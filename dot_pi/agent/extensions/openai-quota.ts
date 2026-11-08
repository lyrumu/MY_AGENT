import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const STATUS_KEY = "openai-quota";
const STATE_TYPE = "openai-quota-state";
const POLL_INTERVAL_MS = 5 * 60_000;
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const APP_SERVER = process.env.PI_QUOTA_CODEX_BIN || "codex";

type Window = {
	usedPercent?: number;
	windowDurationMins?: number | null;
	resetsAt?: number | null;
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
			child.once("exit", (code, signal) => {
				if (!this.stopped) {
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

function formatWindow(window: Window | null | undefined, now: number): string | undefined {
	if (!window || typeof window.usedPercent !== "number") return undefined;
	const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
	const span = window.windowDurationMins ? displayDuration(window.windowDurationMins) : "limit";
	const resets = window.resetsAt ? ` ↻${new Date(window.resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
	const stale = now - lastSuccessfulRead > POLL_INTERVAL_MS * 2 ? "*" : "";
	return `${span} ${remaining.toFixed(0)}%${resets}${stale}`;
}

let lastSuccessfulRead = 0;

function renderQuota(response: QuotaResponse, now: number): { compact: string; detail: string } {
	const snapshot = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
	const primary = formatWindow(snapshot?.primary, now);
	const secondary = formatWindow(snapshot?.secondary, now);
	const parts = [primary, secondary].filter(Boolean) as string[];
	if (!parts.length) throw new Error("Codex returned no quota windows");
	const available = response.rateLimitResetCredits?.availableCount;
	const resetCount = available === undefined || available === null ? "未知" : String(available);
	const permission = response.ordinaryUsageAllowed === false ? "普通额度已耗尽" : "普通额度可用";
	const compact = `OpenAI ${parts.join(" | ")}`;
	const detail = [
		`ChatGPT / Codex 额度（官方 Codex App Server）`,
		...parts.map((part) => `• ${part}`),
		`• 可用重置次数：${resetCount}`,
		`• ${permission}`,
		`• 数据更新时间：${new Date(now).toLocaleString()}`,
		`• 额度与模型成本不是同一指标；百分比由 OpenAI 服务端返回。`,
		...(now - lastSuccessfulRead > POLL_INTERVAL_MS * 2 ? [`• 状态栏 * 表示数据可能过期。`] : []),
	].join("\n");
	return { compact, detail };
}

export default function (pi: ExtensionAPI) {
	let client: CodexAppServer | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let retryDelayMs = 15_000;
	let refreshing: Promise<void> | undefined;
	let currentStatus: ((text: string | undefined) => void) | undefined;
	let lastResult: QuotaResponse | undefined;
	let lastError: string | undefined;
	// Quota poll the OpenAI usage endpoint, so it stays off unless the user asks for it.
	// The toggle is stored per session so a reopened session keeps its previous state.
	let enabled = process.env.PI_QUOTA_AUTOSTART === "1";

	const restoreState = (ctx: { sessionManager: { getBranch: () => readonly any[] } }): void => {
		enabled = process.env.PI_QUOTA_AUTOSTART === "1";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry?.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const stored = entry.data as { enabled?: unknown } | undefined;
			if (typeof stored?.enabled === "boolean") enabled = stored.enabled;
		}
	};

	const setStatus = (ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }, text: string | undefined) => {
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	const stopPolling = (clearStatus: boolean) => {
		if (timer) clearInterval(timer);
		if (retryTimer) clearTimeout(retryTimer);
		timer = undefined;
		retryTimer = undefined;
		client?.stop();
		client = undefined;
		retryDelayMs = 15_000;
		if (clearStatus) currentStatus?.(undefined);
	};

	const startPolling = (ctx: { ui: { setStatus: (key: string, text: string | undefined) => void; notify: (message: string, level?: "info" | "warning" | "error") => void } }) => {
		if (timer) return;
		currentStatus?.(`OpenAI quota: checking…`);
		setTimeout(() => { void refresh(ctx); }, 0);
		timer = setInterval(() => { void refresh(ctx); }, POLL_INTERVAL_MS);
	};

	const refresh = (ctx: { ui: { setStatus: (key: string, text: string | undefined) => void; notify: (message: string, level?: "info" | "warning" | "error") => void } }, notifyOnError = false): Promise<void> => {
		if (!enabled) return Promise.resolve();
		if (refreshing) return refreshing;
		refreshing = (async () => {
			try {
				if (!client) client = new CodexAppServer();
				const result = await client.readQuota();
				const now = Date.now();
				const rendered = renderQuota(result, now);
				lastResult = result;
				lastSuccessfulRead = now;
				lastError = undefined;
				retryDelayMs = 15_000;
				if (retryTimer) clearTimeout(retryTimer);
				retryTimer = undefined;
				currentStatus?.(rendered.compact);
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				const message = lastError.includes("ENOENT") || lastError.includes("not found")
					? `未找到 Codex CLI（可设 PI_QUOTA_CODEX_BIN）；${lastError}`
					: lastError;
				if (lastResult) {
					const old = renderQuota(lastResult, lastSuccessfulRead);
					currentStatus?.(`${old.compact} · 过期，重试中`);
				} else {
					currentStatus?.(`OpenAI quota: 暂不可用，重试中`);
				}
				if (notifyOnError) ctx.ui.notify(`OpenAI quota refresh failed: ${message}`, "warning");
				client?.stop();
				client = undefined;
				if (!retryTimer) {
					const delay = retryDelayMs;
					retryDelayMs = Math.min(retryDelayMs * 2, POLL_INTERVAL_MS);
					retryTimer = setTimeout(() => {
						retryTimer = undefined;
						void refresh(ctx);
					}, delay);
				}
			}
		})().finally(() => { refreshing = undefined; });
		return refreshing;
	};

	pi.registerCommand("quota", {
		description: "Toggle OpenAI quota display on/off (requires local Codex CLI installed and logged in)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (!enabled) {
				stopPolling(true);
				pi.appendEntry(STATE_TYPE, { enabled: false });
				ctx.ui.notify("OpenAI 额度显示已关闭。再次输入 /quota 可重新开启。", "info");
				return;
			}
			pi.appendEntry(STATE_TYPE, { enabled: true });
			currentStatus = (text) => setStatus(ctx, text);
			startPolling(ctx);
			await refresh(ctx, true);
			if (lastResult) {
				const rendered = renderQuota(lastResult, lastSuccessfulRead);
				ctx.ui.notify(`OpenAI 额度显示已开启。\n${rendered.detail}`, "info");
			} else if (lastError) {
				ctx.ui.notify(`OpenAI quota unavailable: ${lastError}\nThis feature requires the Codex CLI to be installed on this machine and logged in with ChatGPT. Check with ` +
					"`codex login status`.", "warning");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		// Never await quota work here: Pi awaits session_start handlers before the editor accepts
		// input, so a slow Codex app-server spawn would delay every startup.
		currentStatus = (text) => setStatus(ctx, text);
		restoreState(ctx);
		if (enabled) startPolling(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		stopPolling(true);
		restoreState(ctx);
		if (enabled) startPolling(ctx);
	});

	pi.on("after_provider_response", (_event, ctx) => {
		if (enabled && ctx.model?.provider === "openai") void refresh(ctx);
	});

	pi.on("session_shutdown", () => {
		stopPolling(false);
		currentStatus = undefined;
		lastResult = undefined;
		lastError = undefined;
		lastSuccessfulRead = 0;
	});
}
