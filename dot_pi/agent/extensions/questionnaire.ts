/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	isKeyRelease,
	Key,
	matchesKey,
	MouseRegion,
	ScrollView,
	Text,
	truncateToWidth,
	type TuiMouseEvent,
	visibleWidth,
	VStack,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

/** Pi 1.5.2's editor slot is a plain Container, which otherwise flattens nested ScrollViews. */
function enableEditorSlotLayout(tui: unknown) {
	const renderer = tui as { children?: Array<{ children?: unknown[]; [key: symbol]: unknown }>; getFocusedComponent?: () => unknown };
	const focused = renderer.getFocusedComponent?.();
	const slot = renderer.children?.find((component) => component.children?.includes(focused));
	if (!slot) return;

	const probe = new VStack();
	let prototype: object | null = Object.getPrototypeOf(probe);
	let layoutSymbol: symbol | undefined;
	while (prototype && !layoutSymbol) {
		for (const symbol of Object.getOwnPropertySymbols(prototype)) {
			const candidate = (prototype as Record<symbol, unknown>)[symbol];
			if (typeof candidate !== "function") continue;
			try {
				const node = (candidate as () => { type?: string }).call(probe);
				if (node?.type === "vstack") {
					layoutSymbol = symbol;
					break;
				}
			} catch {
				// Not the layout-node method.
			}
		}
		prototype = Object.getPrototypeOf(prototype);
	}
	if (!layoutSymbol || typeof slot[layoutSymbol] === "function") return;

	Object.defineProperty(slot, layoutSymbol, {
		configurable: true,
		value() {
			const children = (this as { children?: unknown[] }).children ?? [];
			return {
				type: "vstack",
				entries: children.map((component) => ({ component, shrink: 1, minSize: 0 })),
				gap: 0,
				align: "stretch",
			};
		},
	});
}

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				enableEditorSlotLayout(tui);
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let unsubscribeTerminalInput = () => {};
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let collapsed = false;
				let scrollView: ScrollView | undefined;
				let focusRow: number | undefined;
				let followFocus = false;
				let cachedWidth: number | undefined;
				let cachedRows: number | undefined;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, Answer>();

				// Editor for "Type something" option
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				// Helpers
				function refresh() {
					cachedWidth = undefined;
					cachedRows = undefined;
					cachedLines = undefined;
					tui.requestRender();
				}

				function scrollBy(lines: number) {
					scrollView?.scrollBy(lines);
				}

				function toggleCollapsed() {
					collapsed = !collapsed;
					if (!collapsed) followFocus = true;
					refresh();
				}

				function submit(cancelled: boolean) {
					unsubscribeTerminalInput();
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				function currentOptions(): RenderOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: RenderOption[] = [...q.options];
					if (q.allowOther) {
						opts.push({ value: "__other__", label: "Type something.", isOther: true });
					}
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					optionIndex = 0;
					scrollView?.scrollToStart();
					followFocus = false;
					refresh();
				}

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index });
				}

				// Editor submit callback
				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim() || "(no response)";
					saveAnswer(inputQuestionId, trimmed, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function handleInput(data: string) {
					if (collapsed) {
						if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
							toggleCollapsed();
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					if (matchesKey(data, Key.pageUp)) {
						scrollBy(-Math.max(1, (scrollView?.viewportHeight ?? 1) - 1));
						return;
					}
					if (matchesKey(data, Key.pageDown)) {
						scrollBy(Math.max(1, (scrollView?.viewportHeight ?? 1) - 1));
						return;
					}

					// Input mode: route to editor
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					// Tab navigation (multi-question only)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							scrollView?.scrollToStart();
							followFocus = false;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							scrollView?.scrollToStart();
							followFocus = false;
							refresh();
							return;
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					// Option navigation
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						followFocus = true;
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						followFocus = true;
						refresh();
						return;
					}

					// Select option
					if (matchesKey(data, Key.enter) && q) {
						const opt = opts[optionIndex];
						if (opt.isOther) {
							inputMode = true;
							inputQuestionId = q.id;
							editor.setText("");
							followFocus = true;
							refresh();
							return;
						}
						saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
						advanceAfterAnswer();
						return;
					}

					// Cancel
					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				const navigationKeys = [
					Key.pageUp,
					Key.pageDown,
					Key.up,
					Key.down,
					Key.left,
					Key.right,
					Key.tab,
					Key.shift("tab"),
					Key.enter,
					Key.escape,
					Key.space,
				];
				unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
					if (isKeyRelease(data)) return undefined;
					const isMouse = /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
					if (isMouse || (!inputMode && !navigationKeys.some((key) => matchesKey(data, key)))) return undefined;
					handleInput(data);
					return { consume: true };
				});

				function handleMouse(event: TuiMouseEvent) {
					if (event.button !== "left" || event.y !== 0) return undefined;
					if (event.type === "press") return { handled: true, focus: true };
					if (event.type === "click") {
						toggleCollapsed();
						return { handled: true };
					}
					return undefined;
				}

				function render(width: number): string[] {
					const terminalRows = tui.terminal.rows;
					if (cachedLines && cachedWidth === width && cachedRows === terminalRows) return cachedLines;

					const bodyLines: string[] = [];
					const renderWidth = Math.max(1, width);
					cachedWidth = width;
					cachedRows = terminalRows;
					focusRow = undefined;

					function renderToggle(label: string) {
						const text = truncateToWidth(label, renderWidth, "");
						const padding = Math.max(0, renderWidth - visibleWidth(text));
						const left = Math.floor(padding / 2);
						const right = padding - left;
						return theme.bg("selectedBg", theme.fg("text", `${" ".repeat(left)}${text}${" ".repeat(right)}`));
					}

					if (collapsed) {
						cachedLines = [renderToggle("▶ 展开问题")];
						return cachedLines;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					function addWrapped(text: string) {
						bodyLines.push(...wrapTextWithAnsi(text, renderWidth));
					}

					function addWrappedWithPrefix(prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							addWrapped(prefix + text);
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							bodyLines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					bodyLines.push(theme.fg("accent", "─".repeat(renderWidth)));

					// Tab bar (multi-question only)
					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const lbl = questions[i].label;
							const box = isAnswered ? "■" : "□";
							const color = isAnswered ? "success" : "muted";
							const text = ` ${box} ${lbl} `;
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} →`);
						addWrappedWithPrefix(" ", tabs.join(""));
						bodyLines.push("");
					}

					// Helper to render options list
					function renderOptions() {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
							const color = selected || (isOther && inputMode) ? "accent" : "text";
							if (selected) focusRow = bodyLines.length;

							addWrappedWithPrefix(prefix, theme.fg(color, label));
							if (opt.description) {
								addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
							}
						}
					}

					// Content
					if (inputMode && q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						bodyLines.push("");
						// Show options for reference
						renderOptions();
						bodyLines.push("");
						addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
						focusRow = bodyLines.length;
						for (const line of editor.render(Math.max(1, renderWidth - 2))) {
							bodyLines.push(` ${line}`);
						}
						bodyLines.push("");
						addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"));
					} else if (currentTab === questions.length) {
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
						bodyLines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							if (answer) {
								const prefix = answer.wasCustom ? "(wrote) " : "";
								const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", prefix + answer.label)}`;
								addWrappedWithPrefix(" ", summary);
							}
						}
						bodyLines.push("");
						if (allAnswered()) {
							addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
						} else {
							const missing = questions
								.filter((q) => !answers.has(q.id))
								.map((q) => q.label)
								.join(", ");
							addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
						}
					} else if (q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						bodyLines.push("");
						renderOptions();
					}

					bodyLines.push("");
					if (!inputMode) {
						const help = isMulti
							? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
							: "↑↓ navigate • Enter select • Esc cancel";
						addWrappedWithPrefix(" ", theme.fg("dim", help));
					}
					bodyLines.push(theme.fg("accent", "─".repeat(renderWidth)));

					if (followFocus && focusRow !== undefined && scrollView) {
						if (focusRow < scrollView.scrollTop) scrollView.scrollTo(focusRow);
						else if (focusRow >= scrollView.scrollTop + scrollView.viewportHeight) {
							scrollView.scrollTo(focusRow - scrollView.viewportHeight + 1);
						}
					}
					followFocus = false;
					cachedLines = [renderToggle("▼ 收起以查看上方内容"), ...bodyLines];
					return cachedLines;
				}

				const invalidateContent = () => {
					cachedWidth = undefined;
					cachedRows = undefined;
					cachedLines = undefined;
				};
				const headerContent = {
					render: (width: number) => [render(width)[0] ?? ""],
					invalidate: invalidateContent,
				};
				const header = new MouseRegion(headerContent, (event) => {
					if (event.type === "wheel" && event.wheelDelta) {
						scrollBy(event.wheelDelta);
						return { handled: true };
					}
					return handleMouse({ ...event, y: 0 });
				});
				const body = {
					render: (width: number) => render(width).slice(1),
					invalidate: invalidateContent,
					handleMouse: (event: TuiMouseEvent) => {
						if (event.type === "wheel" && event.wheelDelta) {
							scrollBy(event.wheelDelta);
							return { handled: true };
						}
						return handleMouse({ ...event, y: event.y + 1 });
					},
				};
				scrollView = new ScrollView(body, {
					overscroll: "contain",
					scrollbar: "auto",
					scrollbarTrackStyle: (text) => theme.fg("dim", text),
					scrollbarThumbStyle: (text) => theme.fg("accent", text),
				});
				const dialogRows = Math.max(1, tui.terminal.rows);
				const maxDialogHeight = Math.max(4, Math.min(dialogRows - 3, Math.floor(dialogRows * 0.65)));
				class QuestionnaireDialogLayout extends VStack {
					get capturesViewportInput() {
						return !collapsed;
					}
					handleInput(data: string) {
						handleInput(data);
					}
				}
				return new QuestionnaireDialogLayout([
					{ component: header, basis: 1, grow: 0, shrink: 0 },
					{
						component: scrollView,
						shrink: 1,
						minSize: 0,
						maxSize: maxDialogHeight - 1,
						visible: () => !collapsed,
					},
				]);
			}, {
				blocked: { kind: "question", message: "Waiting for questionnaire answers" },
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${labels})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
