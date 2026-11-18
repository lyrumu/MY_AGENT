import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MouseRegion, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const STATUS_KEY = "openai-quota";
const STATE_TYPE = "openai-quota-state";
const POLL_INTERVAL_MS = 90_000;
const POST_TURN_DELAY_MS = 2_000;
const INITIAL_RETRY_MS = 15_000;
const CACHE_MAX_AGE_MS = 4 * 60_000;
const PERCENT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const APP_SERVER = process.env.PI_QUOTA_CODEX_BIN || "codex";

type Window = {
	usedPercent?: number;
	windowDurationMins?: number | null;
};
type Snapshot = {
	limitId?: string | null;
	limitName?: string | null;
	primary?: Window | null;
	secondary?: Window | null;
	credits?: { balance?: number | null; hasCredits?: boolean | null } | null;
};
type QuotaResponse = {
	rateLimits?: Snapshot;
	rateLimitsByLimitId?: Record<string, Snapshot | undefined> | null;
	rateLimitResetCredits?: { availableCount?: number | string | null } | null;
	ordinaryUsageAllowed?: boolean | null;
};
type RpcMessage = {
	id?: number;
	method?: string;
	params?: any;
	result?: any;
	error?: { message?: string; code?: number };
};

class CodexAppServer {
	private child: ChildProcessWithoutNullStreams | undefined;
	private nextId = 0;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private stopped = false;
	private ready: Promise<void>;

	constructor() {
		this.ready = this.start();
	}

	private start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(APP_SERVER, ["app-server", "--stdio"], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			this.child = child;
			const startupTimer = setTimeout(() => reject(new Error(`Timed out starting ${APP_SERVER} app-server`)), STARTUP_TIMEOUT_MS);
			let settled = false;
			const startupResolve = () => {
				if (settled) return;
				settled = true;
				clearTimeout(startupTimer);
				resolve();
			};
			const startupReject = (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(startupTimer);
				reject(error);
			};

			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => this.onLine(line, startupResolve, startupReject));
			child.stderr.on("data", () => {}); // Never surface potentially sensitive CLI diagnostics in the TUI.
			child.once("error", (error) => {
				startupReject(new Error(`Could not start Codex app-server (${error.message})`));
				this.failPending(error);
			});
			child.stdin.on("error", (error) => {
				startupReject(error);
				this.failPending(error);
			});
			child.once("exit", (code, signal) => {
				if (!this.stopped) {
					this.stopped = true;
					const error = new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})`);
					startupReject(error);
					this.failPending(error);
				}
			});

			void this.request("initialize", {
				clientInfo: { name: "pi-openai-quota", title: "Pi OpenAI quota", version: "1.0.0" },
				capabilities: { experimentalApi: true, requestAttestation: false },
			}).then(() => {
				if (this.stopped) throw new Error("Codex app-server stopped");
				child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
				startupResolve();
			}).catch(startupReject);
		});
	}

	private onLine(line: string, startupResolve: () => void, startupReject: (error: Error) => void): void {
		if (!line.trim()) return;
		let message: RpcMessage;
		try {
			message = JSON.parse(line) as RpcMessage;
		} catch {
			return;
		}
		if (message.id === undefined) return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(message.id);
		if (message.error) {
			const error = new Error(message.error.message || `Codex RPC error ${message.error.code ?? ""}`);
			pending.reject(error);
			startupReject(error);
		} else {
			pending.resolve(message.result);
			if (message.result?.userAgent) startupResolve();
		}
	}

	private request(method: string, params: unknown): Promise<any> {
		if (!this.child || this.stopped) return Promise.reject(new Error("Codex app-server is not running"));
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Codex RPC timed out: ${method}`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.child!.stdin.write(JSON.stringify({ method, id, params }) + "\n");
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async readQuota(): Promise<QuotaResponse> {
		await this.ready;
		return this.request("account/rateLimits/read", { excludeResetCreditDetails: true }) as Promise<QuotaResponse>;
	}

	stop(): void {
		this.stopped = true;
		this.failPending(new Error("Codex app-server stopped"));
		this.child?.kill("SIGTERM");
		this.child = undefined;
	}

	private failPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

function displayDuration(minutes: number): string {
	if (minutes === 300) return "5h";
	if (minutes === 10080) return "周";
	if (minutes >= 24 * 60 && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
	if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function formatWindow(window: Window | null | undefined): string | undefined {
	if (typeof window?.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) {
		return undefined;
	}
	const remaining = 100 - Math.min(100, window.usedPercent);
	const label = window.windowDurationMins && window.windowDurationMins > 0
		? displayDuration(window.windowDurationMins)
		: "额度";
	const percent = remaining > 0 && remaining < 0.01 ? "<0.01" : PERCENT_FORMAT.format(remaining);
	return `${label} ${percent}%`;
}

type Sample = { text: string; readAt: number };

function summarizeQuota(response: QuotaResponse): string {
	const snapshot = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
	const windows = [formatWindow(snapshot?.primary), formatWindow(snapshot?.secondary)].filter(Boolean);
	if (!windows.length) throw new Error("Codex did not return any quota windows");
	const parts = [windows.join(" | ")];
	const count = response.rateLimitResetCredits?.availableCount;
	if ((typeof count === "number" && Number.isSafeInteger(count) && count >= 0) ||
		(typeof count === "string" && /^\d+$/.test(count))) {
		parts.push(`重置卡 ${count}`);
	}
	if (response.ordinaryUsageAllowed === false) parts.push("普通额度受限");
	return parts.join(" · ");
}

type Monitor = {
	ui: ExtensionContext["ui"];
	client?: CodexAppServer;
	timer?: ReturnType<typeof setTimeout>;
	dueAt?: number;
	expiryTimer?: ReturnType<typeof setTimeout>;
	render?: () => void;
	sample?: Sample;
	busy: boolean;
	failed: boolean;
	retryDelayMs: number;
	openAiUsed: boolean;
};

function widgetLabel(state: Monitor, clickable: boolean): { summary: string; hint: string } {
	const sample = state.sample;
	const hint = state.busy ? "刷新中…" : clickable ? "点击刷新" : "/qr 刷新";
	if (!sample || Date.now() - sample.readAt >= CACHE_MAX_AGE_MS) return { summary: "Codex", hint };
	const cached = state.failed ? " · 缓存" : "";
	return { summary: `Codex · ${sample.text}${cached}`, hint };
}

export default function (pi: ExtensionAPI) {
	let monitor: Monitor | undefined;
	let enabled = false;

	const restoreState = (ctx: ExtensionContext) => {
		for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const stored = entry.data as { enabled?: unknown } | undefined;
			if (typeof stored?.enabled === "boolean") return stored.enabled;
		}
		return process.env.PI_QUOTA_AUTOSTART === "1";
	};

	function stop() {
		const state = monitor;
		monitor = undefined; // Invalidate in-flight work before closing the child.
		if (!state) return;
		clearTimeout(state.timer);
		clearTimeout(state.expiryTimer);
		state.client?.stop();
		state.ui.setWidget(STATUS_KEY, undefined);
	}

	// A single timer takes the earliest refresh request. Requests scheduled while a
	// read is running are drained once it finishes; manual clicks join that read.
	function schedule(state: Monitor, delayMs: number) {
		if (monitor !== state) return;
		const dueAt = Date.now() + delayMs;
		state.dueAt = Math.min(state.dueAt ?? dueAt, dueAt);
		if (state.busy) return;
		clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			state.timer = undefined;
			state.dueAt = undefined;
			void refresh(state);
		}, Math.max(0, state.dueAt - Date.now()));
	}

	function refreshManually(state: Monitor) {
		if (monitor === state && !state.busy) schedule(state, 0);
	}

	async function refresh(state: Monitor) {
		if (monitor !== state) return;
		state.busy = true;
		state.render?.();
		let delayMs = POLL_INTERVAL_MS;
		try {
			state.client ??= new CodexAppServer();
			const result = await state.client.readQuota();
			if (monitor !== state) return;
			state.sample = { text: summarizeQuota(result), readAt: Date.now() };
			state.failed = false;
			state.retryDelayMs = INITIAL_RETRY_MS;
			clearTimeout(state.expiryTimer);
			state.expiryTimer = setTimeout(() => {
				if (monitor === state) state.render?.();
			}, CACHE_MAX_AGE_MS);
		} catch {
			if (monitor !== state) return;
			state.failed = true;
			state.client?.stop();
			state.client = undefined;
			delayMs = state.retryDelayMs;
			state.retryDelayMs = Math.min(delayMs * 2, POLL_INTERVAL_MS);
		} finally {
			if (monitor === state) {
				state.busy = false;
				state.render?.();
				schedule(state, delayMs);
			}
		}
	}

	function start(ctx: ExtensionContext) {
		if (monitor || ctx.mode !== "tui") return;
		const state: Monitor = { ui: ctx.ui, busy: false, failed: false, retryDelayMs: INITIAL_RETRY_MS, openAiUsed: false };
		monitor = state;
		ctx.ui.setWidget(STATUS_KEY, (tui, theme) => {
			const clickable = tui.mode === "fullscreen";
			let hitWidth = 0;
			state.render = () => tui.requestRender();
			const component = {
				render(width: number) {
					if (width <= 0) {
						hitWidth = 0;
						return [];
					}
					const { summary, hint } = widgetLabel(state, clickable);
					const line = truncateToWidth(`${theme.fg("text", summary)}  ${theme.fg("dim", hint)}`, width);
					hitWidth = visibleWidth(line);
					return [line];
				},
				invalidate() {},
			};
			return new MouseRegion(component, (event) => {
				if (!clickable || event.type !== "click" || event.button !== "left" ||
					event.y !== 0 || event.x < 0 || event.x >= hitWidth || event.shift || event.ctrl || event.alt) return;
				refreshManually(state);
				return { handled: true, render: false };
			});
		}, { placement: "belowEditor" });
		schedule(state, 0);
	}

	const toggle = async (_args: string, ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") return;
		const next = !enabled;
		pi.appendEntry(STATE_TYPE, { enabled: next });
		enabled = next;
		if (enabled) {
			start(ctx);
			ctx.ui.notify("额度显示已开启（使用本机 Codex CLI 的 ChatGPT 登录）。", "info");
		} else {
			stop();
			ctx.ui.notify("额度显示已关闭。", "info");
		}
	};

	pi.registerCommand("quota", {
		description: "Toggle Codex quota display (requires a local Codex CLI signed in with ChatGPT)",
		handler: toggle,
	});
	pi.registerCommand("quato", { description: "Alias for /quota", handler: toggle });
	pi.registerCommand("qr", {
		description: "Refresh the enabled Codex quota display",
		handler: async (_args, ctx) => {
			if (monitor) refreshManually(monitor);
			else if (ctx.mode === "tui") ctx.ui.notify("先用 /quota 开启额度显示。", "info");
		},
	});

	const restore = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		enabled = restoreState(ctx);
		if (enabled) start(ctx);
		else stop();
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("message_end", (event) => {
		if (monitor && event.message.role === "assistant" &&
			(event.message.provider === "openai" || event.message.provider === "openai-codex")) {
			monitor.openAiUsed = true;
		}
	});
	pi.on("agent_settled", () => {
		const state = monitor;
		if (!state?.openAiUsed) return;
		state.openAiUsed = false;
		schedule(state, POST_TURN_DELAY_MS);
	});
	pi.on("session_shutdown", stop);
}
