/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Patterns checked: rm -rf, sudo, chmod/chown 777
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	Key,
	matchesKey,
	MouseRegion,
	ScrollView,
	truncateToWidth,
	type TuiMouseEvent,
	visibleWidth,
	VStack,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type PermissionChoice = "Yes" | "No" | undefined;

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

export default function (pi: ExtensionAPI) {
	const dangerousPatterns = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const isDangerous = dangerousPatterns.some((p) => p.test(command));

		if (isDangerous) {
			if (!ctx.hasUI) {
				// In non-interactive mode, block by default
				return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
			}

			const choice =
				ctx.mode === "tui"
					? await showPermissionReview(command, ctx.ui)
					: await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);

			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}

async function showPermissionReview(command: string, ui: ExtensionUIContext): Promise<PermissionChoice> {
	return ui.custom<PermissionChoice>(
		(tui, theme, _keybindings, done) => {
			enableEditorSlotLayout(tui);
			let selectedIndex = 1; // Safe default: No
			let unsubscribeTerminalInput = () => {};
			const finish = (choice: PermissionChoice) => {
				unsubscribeTerminalInput();
				done(choice);
			};
			let collapsed = false;
			let scrollView: ScrollView | undefined;
			let followSelection = false;
			let cachedWidth: number | undefined;
			let cachedRows: number | undefined;
			let cachedLines: string[] | undefined;
			let optionRows: number[] = [];

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
				if (!collapsed) followSelection = true;
				refresh();
			}

			function handleInput(data: string) {
				if (collapsed) {
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) toggleCollapsed();
					else if (matchesKey(data, Key.escape)) finish(undefined);
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

				if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
					selectedIndex = Math.max(0, selectedIndex - 1);
					followSelection = true;
					refresh();
				} else if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
					selectedIndex = Math.min(1, selectedIndex + 1);
					followSelection = true;
					refresh();
				} else if (matchesKey(data, Key.enter)) {
					finish(selectedIndex === 0 ? "Yes" : "No");
				} else if (matchesKey(data, Key.escape)) {
					finish(undefined);
				}
			}

			function handleMouse(event: TuiMouseEvent) {
				if (event.button !== "left") return undefined;

				if (event.y === 0) {
					if (event.type === "press") return { handled: true, focus: true };
					if (event.type === "click") {
						toggleCollapsed();
						return { handled: true };
					}
				}

				if (collapsed) return undefined;
				const clickedOption = optionRows.indexOf(event.y - 1);
				if (clickedOption === -1) return undefined;
				if (event.type === "press") {
					selectedIndex = clickedOption;
					refresh();
					return { handled: true, focus: true };
				}
				if (event.type === "click") {
					finish(clickedOption === 0 ? "Yes" : "No");
					return { handled: true };
				}
				return undefined;
			}

			function render(width: number): string[] {
				const terminalRows = tui.terminal.rows;
				if (cachedLines && cachedWidth === width && cachedRows === terminalRows) return cachedLines;

				const renderWidth = Math.max(1, width);
				cachedWidth = width;
				cachedRows = terminalRows;

				const renderToggle = (label: string) => {
					const text = truncateToWidth(label, renderWidth, "");
					const padding = Math.max(0, renderWidth - visibleWidth(text));
					const left = Math.floor(padding / 2);
					const right = padding - left;
					return theme.bg("selectedBg", theme.fg("text", `${" ".repeat(left)}${text}${" ".repeat(right)}`));
				};

				if (collapsed) {
					optionRows = [];
					cachedLines = [renderToggle("▶ 展开权限审查")];
					return cachedLines;
				}

				const bodyLines: string[] = [theme.fg("warning", "─".repeat(renderWidth))];

				const addWrappedWithPrefix = (prefix: string, text: string) => {
					const prefixWidth = visibleWidth(prefix);
					const available = Math.max(1, renderWidth - prefixWidth);
					const wrapped = wrapTextWithAnsi(text, available);
					const continuationPrefix = " ".repeat(prefixWidth);
					for (let i = 0; i < wrapped.length; i++) {
						bodyLines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
					}
				};

				addWrappedWithPrefix(" ", theme.fg("warning", theme.bold("⚠️ Dangerous command")));
				bodyLines.push("");
				addWrappedWithPrefix("  ", theme.fg("text", command));
				bodyLines.push("", theme.fg("muted", " Allow this command?"));

				optionRows = [];
				for (let i = 0; i < 2; i++) {
					optionRows.push(bodyLines.length);
					const label = i === 0 ? "Yes — allow once" : "No — block command";
					const prefix = i === selectedIndex ? theme.fg("accent", "> ") : "  ";
					const text = i === selectedIndex ? theme.fg("accent", label) : theme.fg("text", label);
					bodyLines.push(truncateToWidth(prefix + text, renderWidth));
				}

				bodyLines.push("", theme.fg("dim", " ↑↓ select • Enter confirm • Esc block"));
				bodyLines.push(theme.fg("warning", "─".repeat(renderWidth)));

				if (followSelection && scrollView) {
					const selectedRow = optionRows[selectedIndex];
					if (selectedRow !== undefined) {
						if (selectedRow < scrollView.scrollTop) scrollView.scrollTo(selectedRow);
						else if (selectedRow >= scrollView.scrollTop + scrollView.viewportHeight) {
							scrollView.scrollTo(selectedRow - scrollView.viewportHeight + 1);
						}
					}
				}
				followSelection = false;
				cachedLines = [renderToggle("▼ 收起以查看上方内容"), ...bodyLines];
				return cachedLines;
			}

			const capturedKeys = [Key.pageUp, Key.pageDown, Key.up, Key.down, Key.left, Key.right, Key.enter, Key.escape, Key.space];
			unsubscribeTerminalInput = ui.onTerminalInput((data) => {
				if (isKeyRelease(data) || !capturedKeys.some((key) => matchesKey(data, key))) return undefined;
				handleInput(data);
				return { consume: true };
			});

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
			class PermissionDialogLayout extends VStack {
				get capturesViewportInput() {
					return !collapsed;
				}
				handleInput(data: string) {
					handleInput(data);
				}
			}
			return new PermissionDialogLayout([
				{ component: header, basis: 1, grow: 0, shrink: 0 },
				{
					component: scrollView,
					shrink: 1,
					minSize: 0,
					maxSize: maxDialogHeight - 1,
					visible: () => !collapsed,
				},
			]);
		},
		{
			blocked: { kind: "permission", message: "Review dangerous command" },
		},
	);
}
