/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Patterns checked: rm -rf, sudo, chmod/chown 777
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	type TuiMouseEvent,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type PermissionChoice = "Yes" | "No" | undefined;

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
			let selectedIndex = 1; // Safe default: No
			let collapsed = false;
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;
			let optionRows: number[] = [];

			function refresh() {
				cachedWidth = undefined;
				cachedLines = undefined;
				tui.requestRender();
			}

			function toggleCollapsed() {
				collapsed = !collapsed;
				refresh();
			}

			function handleInput(data: string) {
				if (collapsed) {
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) toggleCollapsed();
					else if (matchesKey(data, Key.escape)) done(undefined);
					return;
				}

				if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
					selectedIndex = Math.max(0, selectedIndex - 1);
					refresh();
				} else if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
					selectedIndex = Math.min(1, selectedIndex + 1);
					refresh();
				} else if (matchesKey(data, Key.enter)) {
					done(selectedIndex === 0 ? "Yes" : "No");
				} else if (matchesKey(data, Key.escape)) {
					done(undefined);
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
				const clickedOption = optionRows.indexOf(event.y);
				if (clickedOption === -1) return undefined;
				if (event.type === "press") {
					selectedIndex = clickedOption;
					refresh();
					return { handled: true, focus: true };
				}
				if (event.type === "click") {
					done(clickedOption === 0 ? "Yes" : "No");
					return { handled: true };
				}
				return undefined;
			}

			function render(width: number): string[] {
				if (cachedLines && cachedWidth === width) return cachedLines;

				const renderWidth = Math.max(1, width);
				cachedWidth = width;

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

				const lines: string[] = [
					renderToggle("▼ 收起以查看上方内容"),
					theme.fg("warning", "─".repeat(renderWidth)),
				];

				const addWrappedWithPrefix = (prefix: string, text: string) => {
					const prefixWidth = visibleWidth(prefix);
					const available = Math.max(1, renderWidth - prefixWidth);
					const wrapped = wrapTextWithAnsi(text, available);
					const continuationPrefix = " ".repeat(prefixWidth);
					for (let i = 0; i < wrapped.length; i++) {
						lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
					}
				};

				addWrappedWithPrefix(" ", theme.fg("warning", theme.bold("⚠️ Dangerous command")));
				lines.push("");
				addWrappedWithPrefix("  ", theme.fg("text", command));
				lines.push("", theme.fg("muted", " Allow this command?"));

				optionRows = [];
				for (let i = 0; i < 2; i++) {
					optionRows.push(lines.length);
					const label = i === 0 ? "Yes — allow once" : "No — block command";
					const prefix = i === selectedIndex ? theme.fg("accent", "> ") : "  ";
					const text = i === selectedIndex ? theme.fg("accent", label) : theme.fg("text", label);
					lines.push(truncateToWidth(prefix + text, renderWidth));
				}

				lines.push("", theme.fg("dim", " ↑↓ select • Enter confirm • Esc block"));
				lines.push(theme.fg("warning", "─".repeat(renderWidth)));
				cachedLines = lines;
				return lines;
			}

			return {
				render,
				invalidate: () => {
					cachedWidth = undefined;
					cachedLines = undefined;
				},
				handleInput,
				handleMouse,
			};
		},
		{
			blocked: { kind: "permission", message: "Review dangerous command" },
		},
	);
}
