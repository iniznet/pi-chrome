import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import {
	AuthState,
	BridgeProtocol,
	CommandClaim,
	MAX_ELEMENTS,
	type BridgeCommand,
	type BridgeResult,
	type HistoryEntry,
	type PendingEntry,
	type SnapshotDigest,
	diffDigests,
	formatChromeInspect,
	formatChromeSnapshot,
	formatIncludedSnapshotText,
	recordHistory,
	safeJson,
	summarizeParams,
	truncateText,
} from "./commands";

/**
 * Existing-profile Chrome bridge for pi.
 *
 * This is intentionally not a remote-debugging-port integration. Chrome blocks default-profile
 * remote debugging in many normal launches, so pi-chrome uses a companion extension from the
 * browser-extension folder bundled next to this Pi extension.
 *
 * The companion extension runs inside the user's real Chrome profile and polls this local
 * pi extension for commands. That gives pi access to the user's existing tabs/authenticated
 * profile, subject to the browser extension permissions the user grants.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type ToolTextResult = {
	content: Array<{ type: "text"; text: string }>;
	// Required: the SDK's AgentToolResult demands `details`; every tool in this file
	// always supplies it, so keep the local type aligned (S8 tsc gate).
	details: Record<string, unknown>;
};

// Per-instance ring buffer of every chrome_* action this bridge sent (S4). Trimmed to the cap.
const chromeHistory: HistoryEntry[] = [];

const PI_CHROME_PKG_PATH = resolve(__dirname, "..", "..", "package.json");
function readPiChromeVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(PI_CHROME_PKG_PATH, "utf8")) as { version?: string };
		if (pkg.version) return pkg.version;
	} catch {}
	return "0.0.0-dev";
}
const PI_CHROME_VERSION = readPiChromeVersion();
const PI_CHROME_GLOBAL_KEY = "__piChromeProfileBridgeLoaded__";
// Authorization is kept on globalThis (separate from the singleton flag, which is cleared on
// reload) so a /reload — which tears down and re-evaluates the module — does not silently drop
// an active /chrome authorize grant.
const PI_CHROME_AUTH_KEY = "__piChromeProfileBridgeAuth__";
const DEFAULT_HOST = process.env.PI_CHROME_BRIDGE_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PI_CHROME_BRIDGE_PORT ?? "17318");
const DEFAULT_TIMEOUT_MS = 30_000;
// Loopback endpoint limits (endpoint-limits): bounded request bodies, a wire timeout clamp,
// and a concurrent /next waiter cap so a runaway client cannot amplify host memory or pile
// up unbounded long-polls. /result gets a dedicated, larger cap because it legitimately
// carries snapshot/screenshot payloads; oversized results are degraded with a marker.
const MAX_COMMAND_BODY_BYTES = 1024 * 1024; // 1MB — /command carries only action+params
const MAX_CONTROL_BODY_BYTES = 256 * 1024; // 256KB — /ack and /heartbeat are tiny control posts
const MAX_RESULT_BODY_BYTES = 8 * 1024 * 1024; // 8MB — above this /result is degraded, not buffered
const MIN_WIRE_TIMEOUT_MS = 1_000;
const MAX_WIRE_TIMEOUT_MS = 5 * 60_000;
const MAX_NEXT_WAITERS = 4;

const snapshotModeValues = ["auto", "interactive", "forms", "pageMap", "text", "changes", "full"] as const;

// Compact one-line rendering of the chrome_storage auth-state summary (feat-storage).
// Summaries only ever contain names/counts — never values.
function formatStorageSummary(summary: Record<string, unknown>): string {
	const parts: string[] = [];
	if (typeof summary.origin === "string" && summary.origin) parts.push(`origin=${summary.origin}`);
	if (typeof summary.cookieCount === "number") {
		parts.push(`${summary.cookieCount} cookie(s)`);
		if (typeof summary.sessionCookieCount === "number") parts.push(`${summary.sessionCookieCount} session cookie(s)`);
		if (Array.isArray(summary.cookieNames) && (summary.cookieNames as unknown[]).length) {
			const names = (summary.cookieNames as string[]).slice(0, 10).join(", ");
			parts.push(`names: ${names}${summary.namesTruncated ? "…" : ""}`);
		}
	}
	if (typeof summary.keyCount === "number") {
		parts.push(`${summary.keyCount} key(s)`);
		if (Array.isArray(summary.keys) && (summary.keys as unknown[]).length) {
			parts.push(`keys: ${(summary.keys as string[]).slice(0, 10).join(", ")}`);
		}
	}
	if (Array.isArray(summary.databases) && (summary.databases as unknown[]).length) parts.push(`databases: ${(summary.databases as string[]).join(", ")}`);
	return `Summary — ${parts.join(" · ")}`;
}

// Human-friendly rendering of one CDP Performance metric value (feat-perf-metrics): heap
// sizes read better in KB, counters stay as raw counts.
function formatMetricValue(name: string, value: number): string {
	if (/Heap/i.test(name)) return `${Math.round(value / 1024)} KB`;
	return String(Math.round(value * 100) / 100);
}

function extensionRoot(): string {
	// Resolve relative to this extension file, not ctx.cwd. ctx.cwd can temporarily be
	// an attachment/clipboard path when Pi is handling pasted images.
	if (typeof __dirname === "string") return __dirname;
	return process.cwd();
}

function workspaceCwd(ctx: ExtensionContext): string {
	for (const candidate of [ctx.cwd, process.cwd()]) {
		if (!candidate) continue;
		try {
			if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
		} catch {
			// try next candidate
		}
	}
	return process.cwd();
}

function browserExtensionPath(): string {
	return join(extensionRoot(), "browser-extension");
}

function hostnameOf(url: string | undefined): string {
	if (!url) return "";
	try { return new URL(url).hostname; } catch { return ""; }
}

// Description of a click/type/fill result's significant fields so the agent doesn't have to
// guess whether the action actually changed the page.
function summarizeActionResult(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as Record<string, unknown>;
	const parts: string[] = [];
	// NOTE: pageMutated is a coarse heuristic (a hash over body text + input values + node count).
	// Many real effects — class/aria/data-state toggles, JS-held state, canvas, async updates —
	// don't move it, so a false value is NOT proof the action did nothing. Surface it only as a
	// soft hint, and never present it as a failure on its own.
	if (r.pageMutated === false) parts.push("no coarse DOM change detected (may still have taken effect — verify with includeSnapshot)");
	if (r.defaultPrevented === true) parts.push("defaultPrevented=true");
	if (r.elementVisible === false) parts.push("element NOT visible");
	if (r.occludedBy) {
		const o = r.occludedBy as { tag?: string; id?: string };
		parts.push(`occluded by <${o.tag ?? "?"}${o.id ? "#" + o.id : ""}>`);
	}
	if (r.valueMatches === false) parts.push("input value did not stick");
	if (r.autoplayHint) parts.push("autoplay-gated affordance");
	return parts.length ? parts.join("; ") : undefined;
}

// Read the request body up to maxBytes. The data listener stays attached past the cap so the
// stream keeps draining (discarding) instead of buffering in the socket — no memory growth —
// while the caller gets a structured rejection it can surface as a size-limit response.
function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<string> {
	return new Promise((resolveBody, rejectBody) => {
		const chunks: Buffer[] = [];
		let received = 0;
		let oversized = false;
		request.on("data", (chunk: Buffer) => {
			received += chunk.length;
			if (oversized) return; // keep draining, discard payload
			if (received > maxBytes) {
				oversized = true;
				const partial = Buffer.concat(chunks).toString("utf8");
				chunks.length = 0;
				const error = new Error(`Request body exceeds the ${maxBytes}-byte limit`);
				(error as { bodyExceedsLimit?: boolean; partialText?: string }).bodyExceedsLimit = true;
				(error as { partialText?: string }).partialText = partial.slice(0, 4096);
				rejectBody(error);
				return;
			}
			chunks.push(Buffer.from(chunk));
		});
		request.on("end", () => {
			if (!oversized) resolveBody(Buffer.concat(chunks).toString("utf8"));
		});
		request.on("error", rejectBody);
	});
}

// Clamp the wire-provided timeoutMs to [1s, 5min] (endpoint-limits): a client cannot ask the
// server to hold a command (or a /next long-poll equivalent) for unbounded time, and a tiny
// timeout that races its own delivery is worse than the 1s floor.
function clampWireTimeoutMs(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
	return Math.min(MAX_WIRE_TIMEOUT_MS, Math.max(MIN_WIRE_TIMEOUT_MS, value));
}

function corsHeadersFor(request: IncomingMessage): Record<string, string> {
	const origin = String(request.headers.origin ?? "");
	if (!origin.startsWith("chrome-extension://")) return {};
	return {
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": "content-type",
		"access-control-expose-headers": "x-pi-chrome-version",
		"vary": "origin",
	};
}

function isBrowserOriginAllowed(request: IncomingMessage): boolean {
	const origin = String(request.headers.origin ?? "");
	if (origin) return origin.startsWith("chrome-extension://");
	const secFetchSite = String(request.headers["sec-fetch-site"] ?? "");
	return !secFetchSite || secFetchSite === "none" || secFetchSite === "same-origin";
}

function isLocalProcessRequest(request: IncomingMessage): boolean {
	return !request.headers.origin && !request.headers["sec-fetch-site"];
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...(extraHeaders ?? {}),
	});
	response.end(JSON.stringify(body));
}

// Client-mode command id minting: {pid}:{seq} with a module-level counter so the SAME id can
// be reused when a sendViaOwner retry promotes to server and re-runs locally (S1.1/S1.6 — the
// SW journal dedupes on that id).
let clientCommandSeq = 0;
function mintClientCommandId(): string {
	clientCommandSeq += 1;
	return `${process.pid}:${clientCommandSeq}`;
}

class ChromeProfileBridge {
	private server: Server | undefined;
	// Exactly-once command protocol state (queue, pending, orphans, waiters, heartbeats) — the
	// host-free state machine in commands.ts, unit-tested by bridge-protocol.test.mjs.
	private protocol = new BridgeProtocol();
	private lastSeenAt: number | undefined;
	private clientName: string | undefined;
	private mode: "server" | "client" | undefined;
	private seq = 0; // server-side monotonic command id counter (S1.1: pid:seq, no Date.now/Math.random)

	constructor(
		private readonly host: string,
		private readonly port: number,
	) {}

	get url(): string {
		return `http://${this.host}:${this.port}`;
	}

	get connected(): boolean {
		// MV3 service workers can pause between polls/alarms. Treat a recent poll as
		// connected without sending a probe command; real chrome_* tool calls are
		// the authoritative end-to-end health check.
		return this.lastSeenAt !== undefined && Date.now() - this.lastSeenAt < 5 * 60_000;
	}

	status(): Record<string, unknown> {
		return {
			url: this.url,
			mode: this.mode ?? "starting",
			connected: this.connected,
			lastSeenAt: this.lastSeenAt,
			clientName: this.clientName,
			queuedCommands: this.protocol.queue.length,
			pendingCommands: this.protocol.pending.size,
			// S5.1: age of the newest extension heartbeat (undefined when none yet).
			heartbeatAgeMs: this.heartbeatAgeMs(),
		};
	}

	private heartbeatAgeMs(): number | undefined {
		return this.protocol.newestHeartbeatAt(Date.now());
	}

	async start(): Promise<void> {
		if (this.server || this.mode === "client") return;
		await this.bindServerOrClient();
	}

	// Try to own the bridge port. On success we are the server; on EADDRINUSE another Pi
	// session owns it and we run as a client that forwards commands to that owner. Returns
	// the resulting mode so callers (tryPromoteToServer) don't fight stale type narrowing.
	private async bindServerOrClient(): Promise<"server" | "client"> {
		const server = createServer((request, response) => {
			void this.handle(request, response).catch((error) => {
				sendJson(response, 500, { error: (error as Error).message });
			});
		});
		try {
			await new Promise<void>((resolveStart, rejectStart) => {
				server.once("error", rejectStart);
				server.listen(this.port, this.host, () => {
					server.off("error", rejectStart);
					resolveStart();
				});
			});
			this.server = server;
			this.mode = "server";
			return "server";
		} catch (error) {
			server.close();
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			// Another Pi session already owns the bridge port. Use it as the shared
			// machine-local broker so multiple Pi sessions can control Chrome at once.
			this.mode = "client";
			return "client";
		}
	}

	// Client-mode self-heal: when the owning Pi session disappears, fetches to its port fail
	// with `fetch failed` / ECONNREFUSED forever. Try to grab the now-free port and become the
	// server ourselves so chrome_* tools recover without a manual restart.
	private async tryPromoteToServer(): Promise<boolean> {
		if (this.mode !== "client") return this.mode === "server";
		// Stay in client mode (tentative) while probing for the freed port (takeover-transient):
		// concurrent sends keep the owner path (sendViaOwner), which re-verifies reachability
		// per send, instead of routing into a local queue nothing will serve if promotion fails.
		for (let attempt = 0; attempt < 3; attempt++) {
			const currentMode = await this.bindServerOrClient();
			if (currentMode === "server") return true;
			// EADDRINUSE — another session may be grabbing the freed port at the same moment.
			// bindServerOrClient already restored mode="client"; retry a couple of times with a
			// short delay before giving up (audit S2).
			if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
		}
		// Could not take over; mode is still "client", so later sends keep retrying the owner.
		return false;
	}

	stop(): void {
		if (this.mode === "client") {
			this.mode = undefined;
			return;
		}
		// Rejects every pending command, clears the queue, serves `undefined` to all waiters
		// (releasing long-poll /next handlers) and drops orphan notices.
		this.protocol.stop();
		this.server?.close();
		this.server = undefined;
		this.mode = undefined;
	}

	send(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		if (this.mode === "client") return this.sendViaOwner(action, params, timeoutMs, signal);
		return this.sendLocal(action, params, timeoutMs, signal);
	}

	private sendLocal(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal, suppliedId?: string): Promise<unknown> {
		const id = suppliedId ?? `${process.pid}:${++this.seq}`;
		const command = { id, action, params };
		return new Promise((resolveCommand, rejectCommand) => {
			if (signal?.aborted) {
				rejectCommand(new Error("Chrome command aborted"));
				return;
			}
			const cleanupAbort = () => {
				if (signal) signal.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				clearTimeout(timer);
				// orphan-abort: a user-aborted command that was already acked by the extension may
				// have executed. drop() surfaces it as an orphan notice on the next /next, mirroring
				// the timer path, instead of deleting the entry silently.
				this.protocol.drop(id);
				cleanupAbort();
				rejectCommand(new Error("Chrome command aborted"));
			};
			const timer = setTimeout(() => {
				// Acknowledged but never resolved: the action MAY have executed, so drop() pushes an
				// orphan notice the next /next poll surfaces instead of dropping it silently (S1.2).
				const outcome = this.protocol.drop(id);
				cleanupAbort();
				rejectCommand(new Error(this.timeoutMessage(outcome.entry, timeoutMs)));
			}, timeoutMs);
			this.protocol.track(
				command,
				(value) => { cleanupAbort(); resolveCommand(value); },
				(err) => { cleanupAbort(); rejectCommand(err); },
				timer,
			);
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			this.protocol.enqueue(command);
		});
	}

	// Classify why a local command timed out so the agent isn't left guessing. The three
	// distinct failure modes are: extension never polled (not installed / not running),
	// extension polled but never picked up this command, and extension picked up the command
	// but never posted a result back (long-running action or a failed /result post).
	// 4-way timeout classification (S1.5) so the agent knows whether the command may have
	// executed: never polled, polled but never picked up, picked up but never acked, or
	// acked but never returned a result (the dangerous case — the action MAY have run).
	private timeoutMessage(entry: PendingEntry | undefined, timeoutMs: number): string {
		const pollAgeMs = this.lastSeenAt === undefined ? undefined : Date.now() - this.lastSeenAt;
		if (pollAgeMs === undefined || pollAgeMs > 60_000) {
			return `Timed out after ${timeoutMs}ms: the Chrome extension is not polling (last seen ${pollAgeMs === undefined ? "never" : Math.round(pollAgeMs / 1000) + "s ago"}). Run /chrome onboard, then load the bundled browser-extension folder in your normal Chrome profile and keep that Chrome window open.`;
		}
		if (entry) {
			if (entry.state === "received" || entry.ackedAt !== undefined) {
				return `Timed out after ${timeoutMs}ms: the Chrome extension received AND acknowledged the command but never returned a result. The action MAY have executed - verify page state before retrying.`;
			}
			if (entry.deliveredAt !== undefined) {
				// deliveredAt is set only after the /next response actually flushed (lost-command-toctou),
				// so the extension DID receive this command. Whether a same-id retry re-runs depends on
				// whether the extension journaled the id before it stalled — warn instead of asserting
				// "will not re-run", which was false for commands lost to the TOCTOU gap.
				return `Timed out after ${timeoutMs}ms: the Chrome extension polled and received the command but never acknowledged it before the deadline. The command MAY have executed; a same-id retry may not re-run it (dedupe id ${entry.command.id}) - verify page state before retrying.`;
			}
		}
		return `Timed out after ${timeoutMs}ms: the Chrome extension is polling (last seen ${Math.round(pollAgeMs / 1000)}s ago) but did not pick up this command in time. Retry; if it persists, reload 'Pi Chrome Connector' at chrome://extensions.`;
	}

	private async sendViaOwner(action: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs + 2_000);
		const forwardAbort = () => controller.abort();
		if (signal) {
			if (signal.aborted) controller.abort();
			else signal.addEventListener("abort", forwardAbort, { once: true });
		}
		// Mint the command id ONCE per sendViaOwner call and reuse it if we promote to server,
		// so the SW journal dedupes the retried execution (S1.1/S1.6).
		const id = mintClientCommandId();
		// Client-mode timeout: the command was POSTed to the owner, so it may have started before
		// the connection dropped — surface the may-have-executed warning (takeover-transient).
		const timeoutError = (): Error =>
			new Error(
				`Timed out waiting for the shared Chrome bridge owner after ${timeoutMs}ms. The command may have been started by that Pi session and MAY have executed - verify page state before retrying.`,
			);
		const promoteToServerOrThrow = async (deadOwnerMessage: string): Promise<unknown> => {
			const promoted = await this.tryPromoteToServer().catch(() => false);
			if (promoted) return this.sendLocal(action, params, timeoutMs, signal, id);
			throw new Error(deadOwnerMessage);
		};
		try {
			return await this.postCommandToOwner(action, params, timeoutMs, id, controller.signal);
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				if (signal?.aborted) throw new Error("Chrome command aborted");
				throw timeoutError();
			}
			// Transient reset (ECONNRESET / socket hang up / EPIPE): the owner may still be alive —
			// a restart, a dropped keep-alive, or a busy event loop. Retry ONCE before any takeover;
			// /command is idempotent by id, so the SW journal dedupes the retried execution.
			if (this.isOwnerTransientError(error)) {
				try {
					return await this.postCommandToOwner(action, params, timeoutMs, id, controller.signal);
				} catch (retryError) {
					if ((retryError as Error).name === "AbortError") {
						if (signal?.aborted) throw new Error("Chrome command aborted");
						throw timeoutError();
					}
					// Two consecutive transport failures: attempt takeover. A still-live owner keeps
					// the port (EADDRINUSE) and this session stays a client, so surface the real
					// transport error rather than a dead-owner claim.
					if (this.isOwnerTransientError(retryError)) {
						const promoted = await this.tryPromoteToServer().catch(() => false);
						if (promoted) return this.sendLocal(action, params, timeoutMs, signal, id);
						throw retryError;
					}
					if (this.isOwnerHardDead(retryError)) {
						return promoteToServerOrThrow(
							"The Pi session that owned the Chrome bridge is unreachable and this session could not take over the bridge port. Restart this Pi session, or run /chrome doctor.",
						);
					}
					throw retryError;
				}
			}
			// Hard death: ECONNREFUSED / a fetch-level `fetch failed` with an ECONNREFUSED cause
			// means the owning Pi session is gone. Take over the port and re-run the command locally
			// instead of staying stuck as a client pointed at a dead owner.
			if (this.isOwnerHardDead(error)) {
				return promoteToServerOrThrow(
					"The Pi session that owned the Chrome bridge is unreachable and this session could not take over the bridge port. Restart this Pi session, or run /chrome doctor.",
				);
			}
			throw error;
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", forwardAbort);
		}
	}

	// POST one idempotent-by-id command to the owner session's /command endpoint.
	private async postCommandToOwner(
		action: string,
		params: Record<string, unknown>,
		timeoutMs: number,
		id: string,
		signal: AbortSignal,
	): Promise<unknown> {
		const response = await fetch(`${this.url}/command`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id, action, params, timeoutMs }),
			signal,
		});
		const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
		if (response.status === 404) {
			throw new Error(
				"A running Pi session owns the Chrome bridge but is using an older pi-chrome without multi-session support. Restart that Pi session after `pi update`, then retry.",
			);
		}
		if (!response.ok || !payload.ok) throw new Error(payload.error ?? `Chrome bridge owner HTTP ${response.status}`);
		return payload.result;
	}

	// Collect {code, message} signals from the full error chain so classification is precise even
	// when undici wraps the real socket error in a top-level `fetch failed` TypeError whose `cause`
	// is an AggregateError (errors[] list) or another nested cause. Without this, a socket hang-up
	// under `fetch failed` would look like owner death.
	private ownerTransportSignals(error: unknown): { codes: string[]; messages: string[] } {
		const codes: string[] = [];
		const messages: string[] = [];
		const visit = (err: unknown): void => {
			if (!err || typeof err !== "object") return;
			const e = err as NodeJS.ErrnoException;
			if (typeof e.code === "string") codes.push(e.code);
			if (typeof e.message === "string") messages.push(e.message);
			const aggregate = err as { errors?: unknown[] };
			if (Array.isArray(aggregate.errors)) for (const nested of aggregate.errors) visit(nested);
			const cause = (err as { cause?: unknown })?.cause;
			if (cause !== undefined && cause !== err) visit(cause);
		};
		visit(error);
		return { codes, messages };
	}

	// Hard owner death: the port is not listening at all (ECONNREFUSED, including inside a
	// fetch-level `fetch failed` cause). Taking over is safe because no server could possibly
	// have started the command.
	private isOwnerHardDead(error: unknown): boolean {
		const { codes, messages } = this.ownerTransportSignals(error);
		return codes.includes("ECONNREFUSED") || messages.some((message) => /ECONNREFUSED|fetch failed/i.test(message));
	}

	// Transient transport failure: connection reset / socket hang up mid-request. The owner
	// process may still be alive — never treat these as owner death without a retry first.
	private isOwnerTransientError(error: unknown): boolean {
		const { codes, messages } = this.ownerTransportSignals(error);
		return (
			codes.includes("ECONNRESET") ||
			messages.some((message) => /ECONNRESET|other side closed|socket hang up|EPIPE/i.test(message))
		);
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", this.url);
		const corsHeaders = corsHeadersFor(request);
		if (request.method === "OPTIONS") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		if (request.method === "GET" && url.pathname === "/status") {
			sendJson(response, 200, this.status());
			return;
		}
		if (request.method === "POST" && url.pathname === "/command") {
			if (!isLocalProcessRequest(request)) {
				sendJson(response, 403, { ok: false, error: "Chrome commands are accepted only from local Pi processes" });
				return;
			}
			let bodyText: string;
			try {
				bodyText = await readRequestBody(request, MAX_COMMAND_BODY_BYTES);
			} catch (error) {
				// endpoint-limits: an oversized /command is a client error, not a server failure — a
				// 413 tells the sending Pi session the payload was rejected instead of triggering the
				// transient-retry paths that 5xx statuses imply.
				if ((error as { bodyExceedsLimit?: boolean }).bodyExceedsLimit) {
					sendJson(response, 413, { ok: false, error: (error as Error).message });
					return;
				}
				throw error;
			}
			const body = JSON.parse(bodyText) as {
				action?: string;
				params?: Record<string, unknown>;
				timeoutMs?: number;
				id?: string;
			};
			if (!body.action) {
				sendJson(response, 400, { ok: false, error: "Missing command action" });
				return;
			}
			try {
				// Accept an optional client-minted id (S1.1) so a promoted sendViaOwner retry reuses
				// the same id and the SW journal dedupes it; otherwise mint server-side. The wire
				// timeout is clamped to [1s, 5min] (endpoint-limits).
				const result = await this.sendLocal(body.action, body.params ?? {}, clampWireTimeoutMs(body.timeoutMs), undefined, body.id);
				sendJson(response, 200, { ok: true, result });
			} catch (error) {
				sendJson(response, 504, { ok: false, error: (error as Error).message });
			}
			return;
		}
		if (request.method === "GET" && url.pathname === "/next") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			this.lastSeenAt = Date.now();
			this.clientName = url.searchParams.get("name") ?? undefined;
			// protocol.poll() serves ONE orphan notice before any command: an acked-but-resultless
			// command may have executed, so surface it to the extension (which logs it and keeps
			// polling). The command itself is never re-served (S1.2).
			const poll = this.protocol.poll();
			if (poll.type === "orphan") {
				const currentVersion = readPiChromeVersion();
				sendJson(
					response,
					200,
					{ type: "orphan", orphan: poll.orphan, expectedExtensionVersion: currentVersion },
					{ ...corsHeaders, "x-pi-chrome-version": currentVersion },
				);
				return;
			}
			let aborted = false;
			let activeWaiter: ((command: BridgeCommand | undefined) => void) | undefined;
			// The claim owned by THIS poll. Only protocol.poll()/protocol.claim() sets it, and
			// CommandClaim.requeue() returns it to the queue exactly once — so at most one handler
			// ever owns a given command id, and a delivered-but-acked command is never re-served
			// (S1.2).
			let claim: CommandClaim | undefined = poll.type === "command" ? poll.claim : undefined;
			request.once("close", () => {
				aborted = true;
				if (activeWaiter) this.protocol.removeWaiter(activeWaiter);
				// lost-command-toctou: the client may abort after the `if (aborted)` check but before
				// the response bytes reach the socket. writableFinished is true only once the data was
				// handed to the kernel, so a reset inside that window leaves it false and the SW never
				// saw the payload — requeue the claimed command so the next live /next serves it. If
				// the SW DID receive it, its journal dedupes the re-served copy (idempotent by id).
				if (claim !== undefined && !response.writableFinished) claim.requeue(this.protocol);
			});
			if (!claim && this.protocol.waiters.length >= MAX_NEXT_WAITERS) {
				// Concurrent /next waiter cap (endpoint-limits): under contention, answer type:none
				// immediately instead of piling up unbounded long-polls; the SW re-polls shortly.
				claim = undefined;
			} else if (!claim) {
				const command = await this.waitForCommand(25_000, (waiter) => {
					activeWaiter = waiter;
				});
				if (command !== undefined) claim = this.protocol.claim(command);
			}
			if (aborted) {
				// Long-poll connection died before we could deliver. Requeue any claimed command so
				// the next live /next picks it up instead of dropping it on the floor. The close
				// handler may already have requeued it — CommandClaim.requeue is idempotent.
				claim?.requeue(this.protocol);
				return;
			}
			// Mark delivered only once the write actually flushed (lost-command-toctou): the response
			// 'finish' event fires after end() handed the bytes to the kernel, so deliveredAt is never
			// set for a payload that died in the socket — the close handler requeues that command
			// while the claim is still unsettled, and a later timeout then reports it as never picked
			// up instead of claiming a delivery that never landed.
			if (claim !== undefined) {
				response.once("finish", () => claim?.markFlushed(this.protocol, Date.now()));
			}
			// Re-read version on every /next so bumping package.json takes effect without pi restart.
			const currentVersion = readPiChromeVersion();
			sendJson(
				response,
				200,
				claim
					? { type: "command", command: claim.command, expectedExtensionVersion: currentVersion }
					: { type: "none", expectedExtensionVersion: currentVersion },
				{ ...corsHeaders, "x-pi-chrome-version": currentVersion },
			);
			// If the connection dies before the write flushes, the close handler requeues the claim
			// (writableFinished stays false) — the command is never lost and never double-served.
			return;
		}
		if (request.method === "POST" && url.pathname === "/ack") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			this.lastSeenAt = Date.now();
			const body = JSON.parse(await readRequestBody(request, MAX_CONTROL_BODY_BYTES)) as { id?: string };
			// Idempotent by design (S1.3): an unknown id or a duplicate ack is a no-op success —
			// the SW retries acks, and a late ack after timeout must never surface as an error.
			if (body.id !== undefined) this.protocol.ack(body.id, Date.now());
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		if (request.method === "POST" && url.pathname === "/result") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			this.lastSeenAt = Date.now();
			let result: BridgeResult;
			try {
				result = JSON.parse(await readRequestBody(request, MAX_RESULT_BODY_BYTES)) as BridgeResult;
			} catch (error) {
				// endpoint-limits: degrade an oversized /result with a structured marker instead of
				// buffering + parsing a multi-hundred-MB body. The id field always precedes the result
				// payload, so it can be extracted from the buffered prefix to fail the pending command
				// cleanly; accepted:false keeps the SW from retrying the oversized post.
				const marker = error as { bodyExceedsLimit?: boolean; partialText?: string };
				if (!marker.bodyExceedsLimit) throw error;
				let oversizedId: string | undefined;
				try {
					oversizedId = (JSON.parse(marker.partialText ?? "{}") as { id?: string }).id;
				} catch {
					// The partial prefix may be truncated mid-token; fall back to a prefix scan.
					oversizedId = /"id"\s*:\s*"([^"]+)"/.exec(marker.partialText ?? "")?.[1];
				}
				const outcome = oversizedId !== undefined
					? this.protocol.settle(oversizedId)
					: ({ accepted: false } as { accepted: false });
				if (outcome.accepted) {
					const tooLarge = new Error(
						"The Chrome extension returned a result larger than the bridge limit; retry with a smaller output (lower maxElements, mode=interactive, or format=jpeg).",
					);
					(tooLarge as { resultTooLarge?: boolean }).resultTooLarge = true;
					outcome.entry.reject(tooLarge);
				}
				sendJson(response, 200, { ok: true, accepted: false, resultTooLarge: true }, corsHeaders);
				return;
			}
			const outcome = this.protocol.settle(result.id);
			if (!outcome.accepted) {
				// Late result after timeout/owner-switch: ack silently so the SW never retries it.
				// accepted:false signals nothing was resolved (S1.3 — NOT a 404).
				sendJson(response, 200, { ok: true, accepted: false }, corsHeaders);
				return;
			}
			if (result.ok) outcome.entry.resolve(result.result);
			else outcome.entry.reject(new Error(result.error ?? "Chrome extension command failed"));
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		if (request.method === "POST" && url.pathname === "/heartbeat") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			this.lastSeenAt = Date.now();
			// S5.1: the SW posts {sessionKey} every 30s; track liveness and prune stale keys.
			const body = JSON.parse(await readRequestBody(request, MAX_CONTROL_BODY_BYTES)) as { sessionKey?: string };
			if (body.sessionKey) this.protocol.heartbeat(body.sessionKey, Date.now());
			this.protocol.pruneHeartbeats(Date.now());
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		sendJson(response, 404, { error: "not found" });
	}

	private waitForCommand(
		timeoutMs: number,
		registerWaiter?: (waiter: (command: BridgeCommand | undefined) => void) => void,
	): Promise<BridgeCommand | undefined> {
		return new Promise((resolveWait) => {
			let settled = false;
			const waiter = (command: BridgeCommand | undefined) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.protocol.removeWaiter(waiter);
				resolveWait(command);
			};
			const timer = setTimeout(() => waiter(undefined), timeoutMs);
			this.protocol.addWaiter(waiter);
			registerWaiter?.(waiter);
		});
	}
}

const tabActionValues = ["list", "new", "activate", "close", "group", "ungroup", "version", "save"] as const;
const imageFormatValues = ["png", "jpeg"] as const;
const waitForValues = ["selector", "expression", "navigation", "networkIdle"] as const;
const downloadActionValues = ["list", "wait", "clear"] as const;
const dialogTypeValues = ["alert", "confirm", "prompt", "beforeunload", "any"] as const;
const emulateActionValues = ["set", "clear"] as const;
const storageKindValues = ["cookies", "localStorage", "sessionStorage", "indexedDB"] as const;
const storageActionValues = ["get", "set", "delete", "clear", "summary"] as const;
const cookieSameSiteValues = ["no_restriction", "lax", "strict", "unspecified"] as const;
const CHROME_TOOL_NAMES = [
	"chrome_launch",
	"chrome_tab",
	"chrome_snapshot",
	"chrome_diff",
	"chrome_find",
	"chrome_inspect",
	"chrome_navigate",
	"chrome_evaluate",
	"chrome_click",
	"chrome_type",
	"chrome_fill",
	"chrome_fill_form",
	"chrome_key",
	"chrome_wait_for",
	"chrome_downloads",
	"chrome_dialog",
	"chrome_emulate",
	"chrome_storage",
	"chrome_perf_metrics",
	"chrome_list_console_messages",
	"chrome_list_network_requests",
	"chrome_get_network_request",
	"chrome_network_capture",
	"chrome_network_block",
	"chrome_network_export",
	"chrome_screenshot",
	"chrome_hover",
	"chrome_drag",
	"chrome_tap",
	"chrome_scroll",
	"chrome_upload_file",
] as const;
const CHROME_TOOL_NAME_SET = new Set<string>(CHROME_TOOL_NAMES);

function StringEnum<T extends readonly [string, ...string[]]>(values: T) {
	return Type.Union(values.map((value) => Type.Literal(value)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]);
}

export default function (pi: ExtensionAPI): void {
	const instanceToken = Symbol("pi-chrome-instance");
	const currentRoot = extensionRoot();
	const globalState = globalThis as typeof globalThis & {
		[PI_CHROME_GLOBAL_KEY]?: { version: string; root: string; token?: symbol };
		[PI_CHROME_AUTH_KEY]?: { until: number | "indefinite"; sessionKey?: string };
	};
	const alreadyLoaded = globalState[PI_CHROME_GLOBAL_KEY];
	if (alreadyLoaded?.token || (alreadyLoaded && alreadyLoaded.root !== currentRoot)) {
		console.warn(
			`pi-chrome already loaded from ${alreadyLoaded.root} (v${alreadyLoaded.version}); skipping duplicate from ${currentRoot}.`,
		);
		return;
	}
	// pi-chrome <=0.15.19 set the singleton flag but did not clear it on reload.
	// If the stale flag points at this same extension root, replace it instead of
	// skipping the freshly reloaded extension.
	globalState[PI_CHROME_GLOBAL_KEY] = { version: PI_CHROME_VERSION, root: currentRoot, token: instanceToken };

	const bridge = new ChromeProfileBridge(DEFAULT_HOST, DEFAULT_PORT);
	let backgroundDefault = true;
	// Authorization grant + the session key it belongs to (pure AuthState from commands.ts). The
	// session key refuses stale-session inheritance (S5.2).
	const persistedAuth = globalState[PI_CHROME_AUTH_KEY];
	const grantValid = persistedAuth !== undefined && (persistedAuth.until === "indefinite" || persistedAuth.until > Date.now());
	// Restore an authorization that survived a /reload. Drop it if it already expired.
	const authState = new AuthState(grantValid ? persistedAuth.until : undefined, grantValid ? persistedAuth.sessionKey : undefined);
	if (persistedAuth && !grantValid) delete globalState[PI_CHROME_AUTH_KEY];
	const persistAuth = (): void => {
		if (authState.until === undefined) delete globalState[PI_CHROME_AUTH_KEY];
		else globalState[PI_CHROME_AUTH_KEY] = { until: authState.until, sessionKey: sessionKeyFor(sessionCtx) };
	};
	let chromeToolsRegistered = false;
	let chromeToolsUsable = false;
	let authExpiryTimer: NodeJS.Timeout | undefined;
	let countdownInterval: NodeJS.Timeout | undefined;
	// Remembered so bridge sends can tag tabs with this session's group even when ctx isn't handy.
	let sessionCtx: ExtensionContext | undefined;

	const clearAuthExpiryTimer = (): void => {
		if (!authExpiryTimer) return;
		clearTimeout(authExpiryTimer);
		authExpiryTimer = undefined;
	};

	const clearCountdownInterval = (): void => {
		if (!countdownInterval) return;
		clearInterval(countdownInterval);
		countdownInterval = undefined;
	};

	const chromeToolsActive = (tools = pi.getActiveTools()): boolean => tools.some((name) => CHROME_TOOL_NAME_SET.has(name));

	const activateChromeTools = (): boolean => {
		registerChromeTools(pi);
		const before = pi.getActiveTools();
		const next = [...new Set([...before, ...CHROME_TOOL_NAMES])];
		pi.setActiveTools(next);
		return !chromeToolsActive(before) && chromeToolsActive(next);
	};

	const deactivateChromeTools = (): boolean => {
		const before = pi.getActiveTools();
		pi.setActiveTools(before.filter((name) => !CHROME_TOOL_NAME_SET.has(name)));
		return chromeToolsActive(before);
	};

	const logChromeToolChange = (
		action: "authorized" | "reauthorized" | "revoked" | "expired",
		options: { label?: string; authorizedUntil?: number | "indefinite" } = {},
	): void => {
		const content = action === "authorized"
			? `Chrome tools enabled by /chrome authorize${options.label ? ` (${options.label})` : ""}.`
			: action === "reauthorized"
				? `Chrome tool authorization updated by /chrome authorize${options.label ? ` (${options.label})` : ""}.`
				: action === "expired"
					? "Chrome tools disabled because /chrome authorize grant expired."
					: "Chrome tools disabled by /chrome revoke.";
		pi.sendMessage({
			customType: "pi-chrome-tool-change",
			content,
			display: true,
			details: {
				action,
				tools: [...CHROME_TOOL_NAMES],
				authorizedUntil: options.authorizedUntil,
				at: Date.now(),
			},
		}, { triggerTurn: false });
	};

	// Close THIS session's dedicated automation window/tab. Fire-and-forget and best-effort: it
	// must never block /quit, /reload, revoke, or session end, and the service-worker side only
	// ever closes targets this session created itself (never user tabs/windows, never another
	// session's target). Errors (bridge down, target already closed) are intentionally swallowed.
	const cleanupAutomationTargetBestEffort = (): void => {
		const sessionKey = sessionKeyFor(sessionCtx);
		void bridge.send("automation.cleanup", sessionKey !== undefined ? { sessionKey } : {}, 3_000).catch(() => undefined);
	};

	const lockChromeControl = (logAction?: "revoked" | "expired"): void => {
		clearAuthExpiryTimer();
		clearCountdownInterval();
		const wasUsable = chromeToolsUsable;
		deactivateChromeTools();
		chromeToolsUsable = false;
		if (logAction && wasUsable) logChromeToolChange(logAction, { authorizedUntil: undefined });
		authState.revoke();
		persistAuth();
		// Revoking control ends pi-chrome's automation for this session; tidy up the target we own.
		cleanupAutomationTargetBestEffort();
	};

	const authSummary = (): string => {
		if (authState.until === "indefinite") return "authorized indefinitely";
		if (typeof authState.until === "number") {
			const remainingMs = authState.until - Date.now();
			if (remainingMs > 0) return `authorized for ~${Math.ceil(remainingMs / 60_000)}m`;
		}
		return "locked";
	};

	const chromeControlAuthorized = (): boolean => {
		if (authState.isActive(Date.now())) return true;
		// A set-but-expired grant transitions to locked exactly once (auth-state expiry).
		if (authState.checkExpiry(Date.now())) lockChromeControl("expired");
		return false;
	};

	const requireChromeControlAuthorized = (): void => {
		if (!chromeControlAuthorized()) {
			throw new Error("Chrome control locked. Ask the user to run /chrome authorize before using chrome_* tools.");
		}
	};

	// Tab-group title for this Pi session: prefer the user-set display name, else the session id.
	const sessionGroupTitle = (ctx: ExtensionContext): string => {
		const sm = ctx.sessionManager;
		const name = sm.getSessionName?.();
		const id = sm.getSessionId?.();
		return `Pi Session: ${name || id || "unknown"}`;
	};

	const authCountdownLabel = (): string => {
		if (authState.until === "indefinite") return " (indefinite)";
		if (typeof authState.until === "number") {
			const remainingMs = authState.until - Date.now();
			if (remainingMs > 0) {
				const mins = Math.ceil(remainingMs / 60_000);
				return mins >= 1 ? ` (${mins}m)` : " (<1m)";
			}
		}
		return "";
	};

	// Stable per-session key the service worker uses to scope its dedicated automation tab/window
	// to *this* session (one extension brokers all sessions). The session id is stable across
	// /reload, so the automation target is reused rather than orphaned. Returns undefined only
	// before session_start, in which case the worker uses its default bucket.
	const sessionKeyFor = (ctx: ExtensionContext | undefined): string | undefined => {
		const id = ctx?.sessionManager?.getSessionId?.();
		return typeof id === "string" && id ? `session:${id}` : undefined;
	};

	const updateChromeStatus = (ctx: ExtensionContext): void => {
		if (chromeControlAuthorized()) {
			ctx.ui.setStatus("chrome", ctx.ui.theme.fg("success", "●") + " Chrome Bridge" + authCountdownLabel());
		} else {
			ctx.ui.setStatus("chrome", undefined);
		}
	};

	// Ticks every 60 s while a timed authorization is active to keep the countdown current.
	const startCountdownTicker = (ctx: ExtensionContext): void => {
		clearCountdownInterval();
		if (authState.until === "indefinite" || typeof authState.until !== "number") return;
		countdownInterval = setInterval(() => {
			if (!chromeControlAuthorized()) {
				clearCountdownInterval();
				return;
			}
			updateChromeStatus(ctx);
		}, 60_000);
	};

	const scheduleAuthExpiry = (ctx: ExtensionContext, until: number | "indefinite"): void => {
		clearAuthExpiryTimer();
		startCountdownTicker(ctx);
		if (until === "indefinite") return;
		authExpiryTimer = setTimeout(() => {
			if (authState.until !== until) return;
			try {
				lockChromeControl("expired");
				ctx.ui.notify("Chrome control authorization expired. Run /chrome authorize to allow chrome_* tools again.", "info");
				updateChromeStatus(ctx);
			} catch (error) {
				console.warn(`Failed to expire pi-chrome authorization cleanly: ${(error as Error).message}`);
			}
		}, Math.max(0, until - Date.now()));
	};

	const authorizedBridgeSend = (action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> => {
		requireChromeControlAuthorized();
		// Scope the service worker's dedicated automation tab/window to this session. Forwarded on
		// every action so tab resolution, navigation, and cleanup all agree on which target is ours.
		const sessionKey = sessionKeyFor(sessionCtx);
		let wireParams: Record<string, unknown> = sessionKey !== undefined && params.sessionKey === undefined
			? { ...params, sessionKey }
			: params;
		const sessionTitle = sessionCtx !== undefined ? sessionGroupTitle(sessionCtx) : undefined;
		// Any tab Pi opens through tab.new/tab.group must use THIS session's group, even if a caller
		// passes group:false or a custom groupTitle. This central guard covers chrome_tab plus internal
		// callers such as chrome_launch(url).
		if ((action === "tab.new" || action === "tab.group") && sessionTitle !== undefined) {
			wireParams = { ...wireParams, groupTitle: sessionTitle };
		}
		// The session background setting must also reach tab.* actions (background-mode): the SW's
		// tab.new/tab.activate honor a wire `foreground` flag, and chrome_tab never goes through
		// withBackground() like the page.* tools do. Default to the session setting unless the
		// caller already supplied the flag explicitly.
		if (action.startsWith("tab.") && wireParams.foreground === undefined) {
			wireParams = { ...wireParams, foreground: !backgroundDefault };
		}
		// Any tab Pi *uses* (page.* interactions) should join this session's group, mirroring the
		// auto-grouping that tab.new already does. Tagging the wire params lets getTabByParams pull
		// the resolved tab into the session group on the service-worker side. We skip tab.* actions:
		// tab.new/group are forced above, and activate/close/ungroup/list must not group tabs.
		const shouldJoinGroup = action.startsWith("page.") && sessionTitle !== undefined && params.sessionGroupTitle === undefined;
		if (shouldJoinGroup) {
			wireParams = { ...wireParams, sessionGroupTitle: sessionTitle, joinSessionGroup: true };
		}
		// Per-session action history (S4): record every wire send on settle, trimmed to the ring cap.
		const startedAt = Date.now();
		return bridge.send(action, wireParams, timeoutMs, signal).then(
			(result) => {
				recordHistory(chromeHistory, { action, paramsSummary: summarizeParams(wireParams, action), ok: true, sessionKey, params: wireParams }, startedAt);
				return result;
			},
			(error) => {
				recordHistory(chromeHistory, { action, paramsSummary: summarizeParams(wireParams, action), ok: false, error: (error as Error).message, sessionKey, params: wireParams }, startedAt);
				throw error;
			},
		);
	};

	// Translate the public `background` parameter (default on = silent/background) into the
	// service worker's wire-level `foreground` flag, accepting legacy `foreground` as a fallback.
	const withBackground = <T extends Record<string, unknown>>(params: T): T => {
		const typed = params as { background?: boolean; foreground?: boolean };
		const explicit =
			typed.background !== undefined
				? typed.background
				: typed.foreground !== undefined
					? !typed.foreground
					: undefined;
		const background = explicit ?? backgroundDefault;
		return { ...params, foreground: !background } as T;
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		await bridge.start();
		// A grant persisted on globalThis is scoped to the session that created it. If a DIFFERENT
		// session is starting (anything but a /reload of the same session), discard the persisted
		// grant so a stale session never inherits control (audit 9). /reload keeps it: sessionKeyFor
		// is stable across reloads, and this handler still holds the same session id.
		if (authState.rejectStaleSession(sessionKeyFor(ctx), _event?.reason)) {
			delete globalState[PI_CHROME_AUTH_KEY];
		}
		// Reestablish in-memory state after a /reload restored the grant on globalThis.
		if (chromeControlAuthorized()) {
			activateChromeTools();
			chromeToolsUsable = true;
			if (typeof authState.until === "number") scheduleAuthExpiry(ctx, authState.until);
			else if (authState.until === "indefinite") startCountdownTicker(ctx);
		} else {
			deactivateChromeTools();
			chromeToolsUsable = false;
		}
		updateChromeStatus(ctx);
	});

	pi.on("session_shutdown", (event) => {
		clearAuthExpiryTimer();
		clearCountdownInterval();
		// Tidy up this session's dedicated automation window on real session end, but NOT on
		// "reload": /reload tears down and re-evaluates this module while the *same* session
		// (same sessionKey) continues, so we keep the window so it is reused, not churned. The
		// call is fire-and-forget and runs before bridge.stop() so it never blocks shutdown.
		// (Owner-session quit may not deliver in time since stop() closes the bridge server;
		// that only ever leaves a clearly pi-chrome window for the user to close — never a user
		// tab — and /chrome revoke remains the reliable, bridge-alive cleanup path.)
		if (event?.reason !== "reload") {
			cleanupAutomationTargetBestEffort();
			// A real session end must not leak control to the next session in this process: drop
			// the persisted grant (and in-memory grant) alongside the automation target. /reload
			// keeps both — the same session continues and sessionKeyFor stays unchanged.
			delete globalState[PI_CHROME_AUTH_KEY];
			authState.revoke();
		}
		bridge.stop();
		if (globalState[PI_CHROME_GLOBAL_KEY]?.token === instanceToken) {
			delete globalState[PI_CHROME_GLOBAL_KEY];
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!chromeToolsRegistered || !chromeControlAuthorized()) {
			return { systemPrompt: event.systemPrompt };
		}
		const primer = `
<chrome-profile-bridge>
Chrome control is available through the chrome_* tools via a companion Chrome extension installed in the user's normal Chrome profile. Tools target the existing signed-in profile: no remote-debug port, no throwaway profile.

Tab/window isolation (important):
- pi-chrome owns a dedicated automation window/tab. When a chrome_* tool runs with no explicit target, it acts on that pi-chrome-owned target — it never reuses or overwrites the user's currently active tab. The dedicated target is created on first use and reused afterward.
- To act on a specific *existing* tab (e.g. one the user asks you to use), pass targetId/urlIncludes/titleIncludes. Without one of those, assume you are working in pi-chrome's own automation target.
- pi-chrome's automation target may be closed automatically when Chrome control is revoked; user tabs/windows are never closed by pi-chrome.

Capability model (important):
- Interactive controls (click/type/fill/key/hover/drag/scroll/tap) use Chrome's real input layer via chrome.debugger / CDP. Events satisfy normal user-activation gates.
- Input bypasses page CSP because it is injected at browser input layer, not page JavaScript. Chrome may show the “Pi Chrome Connector started debugging this browser” banner while attached.
- \`chrome_evaluate\` and \`chrome_snapshot\` run in MAIN world via **CDP \`Runtime.evaluate\`**, which is not subject to the page's Content-Security-Policy. They work even on strict-CSP pages (e.g. github.com, many bank/SaaS apps) that block \`'unsafe-eval'\`. \`chrome_navigate initScript\` likewise injects at document_start via CDP and bypasses CSP. \`chrome_screenshot\`, \`chrome_tab\`, and Chrome input also work under any CSP.
- Input tools return structured details and support \`includeSnapshot=true\` on click/type/fill/key. Use the fresh snapshot to verify state instead of repeating blindly.

Usage rules:
1. If a chrome_* tool says Chrome control is locked, ask the user to run \`/chrome authorize\` before retrying.
2. \`chrome_snapshot\` before clicking/typing; pass \`uid\` over \`selector\`.
3. \`includeSnapshot=true\` on click/type/fill/key to verify in one round trip.
4. If \`chrome_evaluate\` returns null when you expected a value, the expression evaluated to null/undefined in the page; surface the value via \`JSON.stringify\` to confirm.
5. \`chrome_navigate\` supports an optional \`initScript\` that runs at document_start in MAIN world for the next navigation (good for seeding localStorage or stubbing Date.now).
6. By default chrome_* tools run in the background without focusing Chrome; pass \`background=false\` or run /chrome background off when the user wants to watch Chrome work.
7. If you hit a native file-picker or privileged browser prompt gate, tell the user; generic clicks/typing/CSP gates are handled by Chrome input.
8. Run /chrome doctor when in doubt about connectivity or capabilities.
</chrome-profile-bridge>`;
		return { systemPrompt: event.systemPrompt + primer };
	});

	// Shared handlers, dispatched by the unified /chrome command below.
	const doctorHandler = async (ctx: ExtensionContext) => {
			ctx.ui.notify("Checking pi-chrome…", "info");
			const lines: string[] = [`pi-chrome v${PI_CHROME_VERSION}`];
			const status = bridge.status();
			const roleLabel = status.mode === "client" ? "sharing another pi session's connection" : "running the Chrome connection for this machine";
			lines.push(`• This pi session is ${roleLabel}.`);
			let extensionAlive = false;
			let versionMismatch = false;
			try {
				const started = Date.now();
				const version = (await bridge.send("tab.version", {}, 35_000)) as {
					extensionId?: string;
					extensionVersion?: string;
					bridgeUrl?: string;
				};
				const latencyMs = Date.now() - started;
				extensionAlive = true;
				if (version.extensionVersion && version.extensionVersion !== PI_CHROME_VERSION) {
					versionMismatch = true;
					lines.push(
						`✗ The Chrome companion extension is on an old version (${version.extensionVersion}); this pi-chrome is ${PI_CHROME_VERSION}.`,
						`  Every Chrome action will run with the old code until you reload the extension.`,
						`  Fix: open chrome://extensions and click the refresh icon on 'Pi Chrome Connector'.`,
						`  (After this one-time fix, future updates reload automatically.)`,
					);
				} else {
					lines.push(`✓ Chrome is connected (companion extension v${version.extensionVersion ?? "?"}, responded in ${latencyMs}ms).`);
				}
			} catch (error) {
				const message = (error as Error).message;
				lines.push(`✗ Chrome isn't responding: ${message}`);
				if (message.includes("older pi-chrome without multi-session")) {
					lines.push("  Fix: quit and restart the pi session that first opened the Chrome connection (it was on an older pi-chrome).");
				} else {
					lines.push("  Fix: run /chrome onboard to install the Chrome companion extension, then keep that Chrome window open.");
				}
			}

			if (extensionAlive && !versionMismatch) {
				// Sanity-check that pi-chrome can actually run code in the active tab.
				try {
					const value = await bridge.send("page.evaluate", { expression: "1+1", awaitPromise: true, foreground: false }, 10_000);
					if (value === 2) lines.push(`✓ pi-chrome can run code in the active Chrome tab.`);
					else lines.push(`⚠ pi-chrome ran code in the active tab but got an unexpected result (${JSON.stringify(value)}). The current tab may be locked-down (a Chrome internal page or a strict site).`);
				} catch (error) {
					lines.push(`✗ pi-chrome can't run code in the active tab: ${(error as Error).message}`);
				}

				// Surface obvious site-side automation flags so the user knows why a site might block pi.
				try {
					const probe = (await bridge.send("page.probe", { foreground: false }, 10_000)) as Record<string, unknown>;
					if (probe && probe.arithmetic === 2) lines.push(`✓ The active tab is ${hostnameOf(String(probe.location))} and accepts pi-chrome's commands.`);
					if (probe && probe.webdriver) lines.push(`⚠ Your Chrome is reporting itself as automated to websites. Some sites use this signal to block sign-ins or bot checks.`);
				} catch (error) {
					lines.push(`⚠ Couldn't inspect the active tab: ${(error as Error).message}`);
				}
			} else if (versionMismatch) {
				lines.push(`… Skipped the remaining checks until you reload the Chrome extension.`);
			}

		ctx.ui.notify(lines.join("\n"), "info");
	};

	// Run-in-background (Chrome focus) handler. No args = toggle. Explicit on/off/status.
	const BACKGROUND_DESC: Record<string, string> = {
		on: "pi-chrome runs in the background; Chrome won't pop up or steal focus.",
		off: "Chrome pops to the front and switches tabs so you can watch what pi-chrome is doing.",
	};

	const backgroundHandler = async (ctx: ExtensionContext, args: string) => {
		const arg = (args || "").trim().toLowerCase();
		const currentLabel = backgroundDefault ? "on" : "off";

		if (arg === "status") {
			ctx.ui.notify(`Run in background is ${currentLabel}. ${BACKGROUND_DESC[currentLabel]}`, "info");
			return;
		}

		if (arg === "on" || arg === "true" || arg === "1") backgroundDefault = true;
		else if (arg === "off" || arg === "false" || arg === "0") backgroundDefault = false;
		else if (arg === "toggle" || arg === "") backgroundDefault = !backgroundDefault;
		else {
			ctx.ui.notify(`Unknown background setting '${arg}'. Pick one of: on | off | toggle | status.`, "warning");
			return;
		}

		const nextLabel = backgroundDefault ? "on" : "off";
		ctx.ui.notify(`Run in background → ${nextLabel}. ${BACKGROUND_DESC[nextLabel]}`, "info");
	};

	const authorizeFor = async (ctx: ExtensionContext, label: string, until: number | "indefinite") => {
		const ok = await ctx.ui.confirm(
			"Authorize pi-chrome control?",
			`This Pi session will be allowed to inspect and control your existing Chrome profile for ${label}.\n\nChrome actions use your signed-in browser state and real input. Only approve if you trust the current agent/task.`,
		);
		if (!ok) {
			ctx.ui.notify("Chrome control remains locked.", "info");
			return;
		}
		const wasUsable = chromeToolsUsable;
		authState.authorize(until, sessionKeyFor(sessionCtx));
		persistAuth();
		activateChromeTools();
		chromeToolsUsable = true;
		logChromeToolChange(wasUsable ? "reauthorized" : "authorized", { label, authorizedUntil: until });
		scheduleAuthExpiry(ctx, until);
		ctx.ui.notify(`Chrome control authorized for ${label}.`, "info");
		updateChromeStatus(ctx);
	};

	const parseAuthorizeArg = (arg: string): { label: string; until: number | "indefinite" } | undefined => {
		const normalized = arg.trim().toLowerCase() || "15m";
		if (normalized === "indefinite" || normalized === "forever") return { label: "indefinitely", until: "indefinite" };
		const minutes = normalized.endsWith("m") ? Number(normalized.slice(0, -1)) : Number(normalized);
		if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
		return { label: `${minutes} minutes`, until: Date.now() + minutes * 60_000 };
	};

	const authorizeHandler = async (ctx: ExtensionContext, args: string) => {
		const grant = parseAuthorizeArg(args);
		if (!grant) {
			ctx.ui.notify("Unknown authorize duration. Use minutes (15m, 30m, 45) or indefinite.", "warning");
			return;
		}
		return authorizeFor(ctx, grant.label, grant.until);
	};

	const revokeHandler = (ctx: ExtensionContext) => {
		lockChromeControl("revoked");
		ctx.ui.notify("Chrome control locked. Run /chrome authorize to allow chrome_* tools again.", "info");
		updateChromeStatus(ctx);
	};

	const onboardHandler = async (ctx: ExtensionContext) => {
		const extensionPath = browserExtensionPath();
		const proceed = await ctx.ui.confirm(
			"Install the pi-chrome Chrome extension?",
			`This opens Chrome's extensions page and reveals the folder pi-chrome needs you to load.\n\nWhen the windows open, in Chrome:\n  1. Turn on 'Developer mode' (top-right toggle).\n  2. Click 'Load unpacked' and choose the folder that just opened in Finder, or paste this path:\n     ${extensionPath}\n\nPress Enter to continue, or Esc to cancel.`,
		);
		if (!proceed) {
			ctx.ui.notify("Cancelled. You can run /chrome onboard again whenever you're ready.", "info");
			return;
		}
		if (process.platform === "darwin") {
			await pi.exec("open", ["-a", "Google Chrome", "chrome://extensions"], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
			await pi.exec("open", ["-R", extensionPath], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
			await pi.exec("sh", ["-lc", `printf %s ${JSON.stringify(extensionPath)} | pbcopy`], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
		}
		ctx.ui.notify(
			"Chrome and Finder should be open. The extension folder path is on your clipboard. After you click 'Load unpacked' and pick it, run /chrome doctor to confirm everything is connected.",
			"info",
		);
	};

	// One-line snapshot of pi-chrome's current state. Used as a header in the bare-/chrome
	// picker and as the body of /chrome status.
	const statusSummary = async (): Promise<string> => {
		const parts: string[] = [];
		try {
			const version = (await bridge.send("tab.version", {}, 5_000)) as { extensionVersion?: string };
			if (version.extensionVersion && version.extensionVersion !== PI_CHROME_VERSION) {
				parts.push(`⚠ Chrome extension v${version.extensionVersion} (pi-chrome v${PI_CHROME_VERSION}, reload extension)`);
			} else {
				parts.push(`✓ Chrome connected`);
			}
		} catch {
			parts.push(`✗ Chrome not responding`);
		}
		parts.push(`auth: ${authSummary()}`);
		parts.push(`background: ${backgroundDefault ? "on" : "off"}`);
		return parts.join(" · ");
	};

	const statusHandler = async (ctx: ExtensionContext) => {
		ctx.ui.notify("Checking Chrome connection…", "info");
		ctx.ui.notify(await statusSummary(), "info");
	};

	// Per-session chrome_* action log + replay (S4). Newest-first; `history replay <idx>`
	// re-sends the exact action+params of that entry via the bridge.
	const historyHandler = async (ctx: ExtensionContext, args: string): Promise<void> => {
		const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
		if (tokens[0] === "replay") {
			const idx = Number(tokens[1]);
			if (!Number.isInteger(idx) || idx < 0) {
				ctx.ui.notify("Usage: /chrome history replay <idx> — <idx> is the # index from /chrome history.", "warning");
				return;
			}
			const entry = chromeHistory[chromeHistory.length - 1 - idx];
			if (!entry) {
				ctx.ui.notify(`No chrome action at history index #${idx}.`, "warning");
				return;
			}
			ctx.ui.notify(`Replaying #${idx} ${entry.action} ${entry.paramsSummary}…`, "info");
			try {
				const result = await bridge.send(entry.action, entry.params, DEFAULT_TIMEOUT_MS);
				const text = result === undefined ? "undefined" : typeof result === "string" ? result : safeJson(result);
				ctx.ui.notify(`#${idx} ${entry.action} ok — ${truncateText(text)}`, "info");
			} catch (error) {
				ctx.ui.notify(`#${idx} ${entry.action} failed to replay: ${(error as Error).message}`, "warning");
			}
			return;
		}
		if (chromeHistory.length === 0) {
			ctx.ui.notify("No chrome_* actions recorded yet in this session.", "info");
			return;
		}
		const requested = Number(tokens[0]);
		const n = Math.min(Math.max(Number.isFinite(requested) ? requested : 10, 1), 50);
		const lines: string[] = [];
		const start = Math.max(0, chromeHistory.length - n);
		for (let i = chromeHistory.length - 1; i >= start; i--) {
			const entry = chromeHistory[i];
			const idx = chromeHistory.length - 1 - i;
			const time = new Date(entry.at).toTimeString().slice(0, 8);
			lines.push(`#${idx} ${time} ${entry.action} ${entry.ok ? "ok" : "error"} ${entry.durationMs}ms ${entry.paramsSummary}`);
		}
		lines.push("Replay: /chrome history replay <idx>");
		ctx.ui.notify(lines.join("\n"), "info");
	};

	const openAuthorizeMenu = async (ctx: ExtensionContext): Promise<void> => {
		while (true) {
			const choice = await ctx.ui.select("Authorize Chrome control", [
				"15 minutes",
				"30 minutes",
				"Indefinite",
				"Custom minutes",
			]);
			if (!choice) return;
			switch (choice) {
				case "15 minutes": return authorizeHandler(ctx, "15m");
				case "30 minutes": return authorizeHandler(ctx, "30m");
				case "Indefinite": return authorizeHandler(ctx, "indefinite");
				case "Custom minutes": {
					const value = await ctx.ui.input("Authorize for how many minutes?", "45");
					if (!value) continue;
					return authorizeHandler(ctx, value);
				}
			}
		}
	};

	const openBackgroundMenu = async (ctx: ExtensionContext): Promise<void> => {
		const choice = await ctx.ui.select("Background / watch mode", [
			"Use Chrome in background",
			"Use Chrome in foreground",
		]);
		if (!choice) return;
		switch (choice) {
			case "Use Chrome in background": return backgroundHandler(ctx, "on");
			case "Use Chrome in foreground": return backgroundHandler(ctx, "off");
		}
	};

	const openCommandMenu = async (ctx: ExtensionContext): Promise<void> => {
		while (true) {
			ctx.ui.notify("Checking Chrome connection…", "info");
			const choice = await ctx.ui.select(`pi-chrome\n${await statusSummary()}`, [
				"Authorize Chrome control…",
				"Lock Chrome control",
				"Doctor / troubleshoot",
				"Background / watch mode…",
				"Action history / replay",
				"Install / onboard extension",
			]);
			if (!choice) return;
			switch (choice) {
				case "Authorize Chrome control…": await openAuthorizeMenu(ctx); continue;
				case "Lock Chrome control": return revokeHandler(ctx);
				case "Doctor / troubleshoot": return doctorHandler(ctx);
				case "Background / watch mode…": await openBackgroundMenu(ctx); continue;
				case "Action history / replay": return historyHandler(ctx, "");
				case "Install / onboard extension": return onboardHandler(ctx);
			}
		}
	};

	pi.registerCommand("chrome", {
		description:
			"All pi-chrome controls in one place.\n  /chrome authorize [15m|30m|<minutes>|indefinite] — allow this Pi session to use chrome_* tools.\n  /chrome revoke   — lock Chrome control.\n  /chrome status   — one-line snapshot of connection, auth, and background setting.\n  /chrome doctor   — full health check.\n  /chrome onboard  — install the Chrome companion extension.\n  /chrome history [n|replay <idx>] — per-session chrome_* action log (default 10, max 50) and replay.\n  /chrome background [on|off|status|toggle] — whether pi-chrome runs without focusing Chrome.\nRun with no arguments for an interactive picker that shows current state.",
		getArgumentCompletions: (prefix) => {
			const raw = prefix;
			const trimmedRight = raw.replace(/\s+$/, "");
			const tokens = trimmedRight ? trimmedRight.split(/\s+/) : [];
			const endsWithSpace = raw.length > 0 && raw !== trimmedRight;
			// Path = completed tokens; partial = the token currently being typed (or "" if cursor sits right after a space).
			const partial = endsWithSpace ? "" : (tokens.pop() ?? "");
			const path = tokens.map((t) => t.toLowerCase());
			const partialLower = partial.toLowerCase();

			// Build candidate set with FULL argument-text values so pi-tui's apply-completion
			// (which replaces the entire argument) lands correctly even for nested paths.
			type Item = { fullValue: string; label: string; description: string };
			let candidates: Item[] = [];
			if (path.length === 0) {
				candidates = [
					{ fullValue: "authorize", label: "authorize", description: "Allow this Pi session to use chrome_* tools." },
					{ fullValue: "revoke", label: "revoke", description: "Lock Chrome control for this Pi session." },
					{ fullValue: "status", label: "status", description: "One-line summary: connection, auth, and background setting." },
					{ fullValue: "doctor", label: "doctor", description: "Full health check. Tells you if Chrome is connected and what's wrong if it isn't." },
					{ fullValue: "onboard", label: "onboard", description: "Install the Chrome companion extension (first-time setup)." },
					{ fullValue: "history", label: "history", description: "Per-session chrome_* action log; replay an entry with 'history replay <idx>'." },
					{ fullValue: "background", label: "background", description: "Run pi-chrome in the background without focusing Chrome?" },
				];
			} else if (path[0] === "history" && path.length === 1) {
				candidates = [
					{ fullValue: "history 10", label: "10", description: "Show the 10 most recent chrome_* actions." },
					{ fullValue: "history replay", label: "replay", description: "Re-send a past action, e.g. 'history replay 0' for the newest." },
				];
			} else if (path[0] === "authorize" && path.length === 1) {
				candidates = [
					{ fullValue: "authorize 15m", label: "15m", description: "Authorize Chrome control for 15 minutes." },
					{ fullValue: "authorize 30m", label: "30m", description: "Authorize Chrome control for 30 minutes." },
					{ fullValue: "authorize indefinite", label: "indefinite", description: "Authorize Chrome control until revoked or Pi exits." },
				];
			} else if (path[0] === "background" && path.length === 1) {
				candidates = [
					{ fullValue: "background on", label: "on", description: "Run in background. Chrome stays in the background. Your editor keeps focus. (default)" },
					{ fullValue: "background off", label: "off", description: "Bring Chrome to the front so you can watch." },
					{ fullValue: "background toggle", label: "toggle", description: "Flip whichever way it's currently set." },
					{ fullValue: "background status", label: "status", description: "Show the current setting." },
				];
			}
			if (candidates.length === 0) return null;
			const filtered = candidates.filter((c) => c.label.toLowerCase().startsWith(partialLower));
			if (filtered.length === 0) return null;
			return filtered.map((c) => ({ value: c.fullValue, label: c.label, description: c.description }));
		},
		handler: async (args, ctx) => {
			const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				await openCommandMenu(ctx);
				return;
			}
			const [head, ...rest] = tokens;
			const subArgs = rest.join(" ");
			switch (head) {
				case "authorize": return authorizeHandler(ctx, subArgs);
				case "revoke": return revokeHandler(ctx);
				case "status": return statusHandler(ctx);
				case "doctor": return doctorHandler(ctx);
				case "onboard": return onboardHandler(ctx);
				case "history": return historyHandler(ctx, subArgs);
				case "background":
					return backgroundHandler(ctx, subArgs);
				case "settings": {
					// Legacy nested form: /chrome settings background ...
					const [setting, ...settingArgs] = rest;
					if (setting === "background") return backgroundHandler(ctx, settingArgs.join(" "));
					ctx.ui.notify(`'/chrome settings' was removed. Use /chrome background directly.`, "warning");
					return;
				}
				default:
					ctx.ui.notify(`Unknown subcommand '${head}'. Try: /chrome authorize | revoke | status | doctor | onboard | history | background.`, "warning");
			}
		},
	});

	function registerChromeTools(pi: ExtensionAPI): void {
		if (chromeToolsRegistered) return;
		chromeToolsRegistered = true;

	pi.registerTool({
		name: "chrome_storage",
		label: "Chrome Storage & Auth State",
		description:
			"Read/write browser storage in the user's existing Chrome profile via the companion extension: cookies (get/set/delete/clear with domain/path/secure/httpOnly flags, sameSite, expiry), localStorage/sessionStorage for the resolved tab's origin (get/set/delete/clear), and IndexedDB (list databases, read object stores, delete a database) via CDP. Every response includes a compact auth-state summary (logged-in origins, cookie counts, key/database names) whose values are always redacted; get returns the raw values unless redact=true. Values written via set are redacted from the /chrome action history. Cookie ops are browser-global and never create or touch a tab.",
		promptSnippet: "Inspect or modify cookies / localStorage / sessionStorage / IndexedDB and read an auth-state summary (which origins hold session cookies).",
		parameters: Type.Object({
			kind: StringEnum(storageKindValues),
			action: Type.Optional(StringEnum(storageActionValues)),
			name: Type.Optional(Type.String({ description: "Cookie name (cookies get/set/delete) or web-storage key alias for key." })),
			key: Type.Optional(Type.String({ description: "Web-storage key (localStorage/sessionStorage get/set/delete)." })),
			value: Type.Optional(Type.String({ description: "Cookie value (cookies set) or web-storage value (set). Redacted from the /chrome action history." })),
			url: Type.Optional(Type.String({ description: "Cookies: the URL the cookie belongs to — required for set/delete unless domain is given; also a get/clear filter. localStorage/sessionStorage/IndexedDB always act on the resolved tab's current origin." })),
			domain: Type.Optional(Type.String({ description: "Cookies: domain filter for get/clear, or the domain to set the cookie on when url is omitted (https://<domain>/ is assumed)." })),
			path: Type.Optional(Type.String({ description: "Cookies: cookie path (default /)." })),
			secure: Type.Optional(Type.Boolean({ description: "Cookies: Secure flag when setting." })),
			httpOnly: Type.Optional(Type.Boolean({ description: "Cookies: HttpOnly flag when setting." })),
			sameSite: Type.Optional(StringEnum(cookieSameSiteValues)),
			expirationDate: Type.Optional(Type.Number({ description: "Cookies: expiry in seconds since epoch; omit for a session cookie." })),
			database: Type.Optional(Type.String({ description: "IndexedDB: database name — get reads its stores (add objectStore to read records); clear deletes the whole database." })),
			objectStore: Type.Optional(Type.String({ description: "IndexedDB: object store name to read records from (with database)." })),
			limit: Type.Optional(Type.Number({ description: "IndexedDB: max records to read (default 50, max 200)." })),
			redact: Type.Optional(Type.Boolean({ description: "get: return values as [redacted] (default false; summaries are always redacted)." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = (await authorizedBridgeSend("storage.op", withBackground(params), DEFAULT_TIMEOUT_MS, signal)) as {
				kind?: string;
				action?: string;
				summary?: Record<string, unknown>;
				cookies?: unknown[];
				cookie?: unknown;
				databases?: unknown[];
				stores?: unknown[];
				entryCount?: number;
				entry?: unknown;
				entries?: unknown[];
				origin?: string;
				removed?: number;
				cleared?: number;
			};
			const lines: string[] = [`Storage ${result.kind ?? params.kind} ${result.action ?? params.action}.`];
			if (result.summary) lines.push(formatStorageSummary(result.summary));
			if (Array.isArray(result.cookies)) lines.push(`• ${result.cookies.length} cookie(s) returned.`);
			if (Array.isArray(result.databases)) lines.push(`• ${result.databases.length} database(s).`);
			if (Array.isArray(result.stores)) lines.push(`• ${result.stores.length} object store(s).`);
			if (typeof result.entryCount === "number") lines.push(`• ${result.entryCount} record(s) returned.`);
			if (typeof result.removed === "number") lines.push(`• Removed ${result.removed} cookie(s).`);
			if (typeof result.cleared === "number") lines.push(`• Cleared ${result.cleared} ${params.kind} value(s).`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_perf_metrics",
		label: "Chrome Performance Metrics",
		description:
			"Read one-shot performance counters from the session automation tab via CDP Performance.getMetrics: TaskDuration, JSHeapUsedSize/JSHeapTotalSize, LayoutCount, Nodes, Documents, Frames, JSEventListeners, and more. Cheap and non-persistent — the metrics are collected on demand and no tracing or persistent instrumentation is left attached.",
		promptSnippet: "Read page-performance counters (heap size, task time, layout count) from the Chrome tab.",
		parameters: Type.Object({
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = (await authorizedBridgeSend("page.perfMetrics", withBackground(params), DEFAULT_TIMEOUT_MS, signal)) as {
				metrics?: Array<{ name: string; value: number }>;
				tab?: unknown;
			};
			const metrics = Array.isArray(result.metrics) ? result.metrics : [];
			const FRIENDLY = new Set(["TaskDuration", "JSHeapUsedSize", "JSHeapTotalSize", "LayoutCount", "LayoutDuration", "StyleAndLayoutCount", "Nodes", "Documents", "Frames", "JSEventListeners"]);
			const interesting = metrics.filter((m) => FRIENDLY.has(m.name));
			const text = interesting.length
				? `Performance metrics:\n${interesting.map((m) => `${m.name}=${formatMetricValue(m.name, m.value)}`).join("\n")}`
				: `Performance metrics (${metrics.length} total): ${metrics.map((m) => `${m.name}=${m.value}`).join(", ")}`;
			return { content: [{ type: "text", text }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_launch",
		label: "Chrome Bridge Setup",
		description:
			"Start/check the local bridge used by the companion Chrome extension. This does not launch a separate Chrome profile; install the unpacked Chrome extension in your existing Chrome profile to connect.",
		promptSnippet: "Show instructions for connecting Pi to the user's existing Chrome profile via the companion extension.",
		parameters: Type.Object({
			port: Type.Optional(Type.Number({ description: "Ignored. The bundled Chrome extension polls 127.0.0.1:17318." })),
			url: Type.Optional(Type.String({ description: "Optional URL to open in the existing Chrome profile after the extension is connected." })),
			userDataDir: Type.Optional(Type.String({ description: "Ignored. This bridge intentionally uses the user's existing Chrome profile through the companion extension." })),
			useDefaultProfile: Type.Optional(Type.Boolean({ description: "Ignored; existing-profile access comes from the companion Chrome extension." })),
			headless: Type.Optional(Type.Boolean({ description: "Ignored." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			if (params.url && bridge.connected) {
				const result = await authorizedBridgeSend("tab.new", { url: params.url }, DEFAULT_TIMEOUT_MS, signal);
				return { content: [{ type: "text", text: `Chrome bridge connected; opened ${params.url}` }], details: { status: bridge.status(), result } };
			}
			return {
				content: [
					{
						type: "text",
						text:
							`Chrome profile bridge is listening at ${bridge.url}.\n\n` +
							`To connect your existing Chrome profile:\n` +
							`1. Open chrome://extensions in the Chrome profile you normally use.\n` +
							`2. Enable Developer mode.\n` +
							`3. Click “Load unpacked”.\n` +
							`4. Select: ${browserExtensionPath()}\n\n` +
							`Status: ${bridge.connected ? "connected" : "waiting for extension"}.`,
					},
				],
				details: { status: bridge.status(), extensionPath: browserExtensionPath() },
			};
		},
	});

	pi.registerTool({
		name: "chrome_tab",
		label: "Chrome Tab",
		description: "List, create, activate, close, group, ungroup, inspect, or save named handles for tabs in the user's existing Chrome profile via the companion extension. New/grouped tabs always use this session's Pi tab group. activate/close/group/ungroup require a target (targetId/urlIncludes/titleIncludes); with no target they act on this session's pi-chrome automation tab if one exists, and otherwise error rather than touching the user's active tab. action=save registers a named handle (name) for the resolved tab so a subagent can find or close its own tabs later; action=list returns the named-handle registry.",
		promptSnippet: "List/open/activate/close/group existing Chrome tabs through the companion extension.",
		parameters: Type.Object({
			action: StringEnum(tabActionValues),
			url: Type.Optional(Type.String({ description: "URL for action=new." })),
			targetId: Type.Optional(Type.String({ description: "Chrome tab id for activate/close/group/ungroup." })),
			urlIncludes: Type.Optional(Type.String({ description: "Match the target tab by URL substring for activate/close/group/ungroup." })),
			titleIncludes: Type.Optional(Type.String({ description: "Match the target tab by title substring for activate/close/group/ungroup." })),
			group: Type.Optional(Type.Boolean({ description: "Deprecated; ignored. Pi-created tabs always join this session's own tab group." })),
			groupTitle: Type.Optional(Type.String({ description: "Deprecated for action=new/group; ignored so one Pi session uses one tab group ('Pi Session: <name-or-id>')." })),
			groupColor: Type.Optional(Type.String({ description: "Tab group color for action=group/new: grey, blue, red, yellow, green, pink, purple, cyan, or orange. Defaults to blue." })),
			name: Type.Optional(Type.String({ description: "Handle name for action=save: the named-handle registry entry for the resolved tab." })),
			sessionKey: Type.Optional(Type.String({ description: "Wire-only passthrough (not part of the public API surface): session owner key tagging save/list registry entries. Injected automatically from the host session when omitted." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			const forwarded = { ...params } as typeof params & { groupTitle?: string };
			// Force every Pi-opened/explicitly-grouped tab into this session's own group,
			// named after the session display name (falling back to the session id). There is
			// intentionally no opt-out: one Pi session should create/use one tab group.
			if (params.action === "new" || params.action === "group") {
				forwarded.groupTitle = sessionGroupTitle(ctx);
			}
			const result = await authorizedBridgeSend(`tab.${params.action}`, forwarded, DEFAULT_TIMEOUT_MS, signal);
			if (params.action === "list") {
				// tab.list returns the named-handle registry ({ handles: [...] }) per the documented
				// contract. Accept both that shape and a bare tab array (older companion extension)
				// so a shape mismatch never crashes the tool (regression: "tabs.map is not a function").
				type Handle = { name?: string; tabId?: number; windowId?: number; url?: string; title?: string; ownerSessionKey?: string; savedAt?: number };
				type TabRow = { id?: number; title?: string; url?: string; active?: boolean; group?: { title?: string } | null };
				const handles = (result as { handles?: Handle[] | undefined })?.handles;
				const isRegistry = Array.isArray(handles);
				const rows: Array<Handle | TabRow> = isRegistry ? handles! : Array.isArray(result) ? (result as TabRow[]) : [];
				const text =
					rows
						.map((row) =>
							isRegistry
								? `${(row as Handle).name ?? "(unnamed)"}\t${(row as Handle).tabId ?? ""}\t${(row as Handle).title || "(untitled)"}\t${(row as Handle).url || ""}`
								: `${(row as TabRow).id}\t${(row as TabRow).active ? "*" : " "}\t${(row as TabRow).group?.title ? `[${(row as TabRow).group!.title}] ` : ""}${(row as TabRow).title || "(untitled)"}\t${(row as TabRow).url}`,
						)
						.join("\n") || "No named handles saved.";
				return { content: [{ type: "text", text }], details: { result } };
			}
			return { content: [{ type: "text", text: safeJson(result) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_snapshot",
		label: "Chrome Snapshot",
		description:
			"Inspect a page in the user's existing Chrome profile. Default output is a concise, agent-friendly observation with structural layout/context, stable uids, visible actions, form fields, page hints, and changes since the previous snapshot. Use mode/query/nearUid to zoom instead of dumping the whole page. Runs in the background by default; pass background=false to bring Chrome to the foreground so the user can watch.",
		promptSnippet: "Observe the current Chrome page: concise summary, structural layout, visible actions, forms, page map, query matches, and stable uids.",
		parameters: Type.Object({
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS })),
			mode: Type.Optional(StringEnum(snapshotModeValues)),
			query: Type.Optional(Type.String({ description: "Find/rank elements, regions, and text matching this phrase, e.g. 'merge button', 'email error', 'approve PR'." })),
			maxTextChars: Type.Optional(Type.Number({ description: "Max body text chars included in the underlying snapshot. Defaults are smaller for concise modes." })),
			containingText: Type.Optional(Type.String({ description: "Only return elements whose label/text contains this string (case-insensitive). Useful when the page has many controls." })),
			roleFilter: Type.Optional(Type.String({ description: "Only return elements matching this ARIA role or tag name (case-insensitive). e.g. 'button', 'link', 'textbox'." })),
			nearUid: Type.Optional(Type.String({ description: "Sort elements by proximity to this snapshot uid. Useful for finding controls near a known anchor." })),
			background: Type.Optional(
				Type.Boolean({ description: "If true (the default), run silently in the background without focusing Chrome; pass false so Chrome focuses + the tab activates and the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const snapshot = await authorizedBridgeSend(
				"page.snapshot",
				withBackground({ ...params, maxElements: params.maxElements ?? MAX_ELEMENTS }),
				DEFAULT_TIMEOUT_MS,
				signal,
			);
			return { content: [{ type: "text", text: formatChromeSnapshot(snapshot) }], details: { snapshot } };
		},
	});

	pi.registerTool({
		name: "chrome_find",
		label: "Chrome Find",
		description:
			"Find elements, page regions, or text on the current Chrome page by query. Returns ranked matches with stable uids and coordinates. This is a focused wrapper around chrome_snapshot({ query }).",
		promptSnippet: "Find matching controls/text/regions in Chrome by natural-language query and return stable uids.",
		parameters: Type.Object({
			query: Type.String({ description: "What to find, e.g. 'merge button', 'email error', 'approve PR', 'search box'." }),
			mode: Type.Optional(StringEnum(snapshotModeValues)),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true (the default), run silently in the background without focusing Chrome; pass false so Chrome focuses + the tab activates and the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const snapshot = await authorizedBridgeSend(
				"page.snapshot",
				withBackground({ ...params, mode: params.mode || "auto", maxElements: params.maxElements ?? MAX_ELEMENTS }),
				DEFAULT_TIMEOUT_MS,
				signal,
			);
			return { content: [{ type: "text", text: formatChromeSnapshot(snapshot) }], details: { snapshot } };
		},
	});

	pi.registerTool({
		name: "chrome_inspect",
		label: "Chrome Inspect Element",
		description:
			"Inspect one snapshot uid or selector deeply: nearby text, nearby actions, form context, ancestors, and suggested click target. Use after chrome_snapshot/chrome_find when you need context around one element.",
		promptSnippet: "Inspect a Chrome snapshot uid deeply for nearby text, form context, and suggested actions.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot/chrome_find." })),
			selector: Type.Optional(Type.String({ description: "CSS selector if uid is unavailable." })),
			scrollIntoView: Type.Optional(Type.Boolean({ description: "If true, scroll the target into view before inspecting. Default false to avoid changing page state." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true (the default), run silently in the background without focusing Chrome; pass false so Chrome focuses + the tab activates and the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			try {
				const inspect = await authorizedBridgeSend("page.inspect", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
				return { content: [{ type: "text", text: formatChromeInspect(inspect) }], details: { inspect } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!/Unknown action: page\.inspect/i.test(message)) throw error;
				// Compatibility fallback for a loaded Chrome extension service worker that has not
				// been reloaded since chrome_inspect was added. It is less rich than page.inspect,
				// but still gives useful nearby candidates instead of failing the workflow.
				const snapshot = await authorizedBridgeSend(
					"page.snapshot",
					withBackground({
						...params,
						mode: "interactive",
						maxElements: MAX_ELEMENTS,
						nearUid: params.uid,
						query: params.selector,
					}),
					DEFAULT_TIMEOUT_MS,
					signal,
				);
				const text = `chrome_inspect fallback: loaded Chrome extension does not yet support page.inspect; reload it at chrome://extensions for deep inspect.\n\n${formatChromeSnapshot(snapshot)}`;
				return { content: [{ type: "text", text }], details: { snapshot, fallback: "page.snapshot" } };
			}
		},
	});

	pi.registerTool({
		name: "chrome_navigate",
		label: "Chrome Navigate",
		description:
			"Navigate a Chrome tab to a URL via the companion extension. With no target, navigation goes to pi-chrome's own dedicated automation window/tab — it never replaces the user's active tab. Pass targetId/urlIncludes/titleIncludes only to act on a specific existing tab. Runs in the background by default; pass background=false to focus Chrome and activate the tab so the user can watch. Optionally waits for load completion.",
		promptSnippet: "Navigate a Chrome tab in the user's existing profile.",
		parameters: Type.Object({
			url: Type.String(),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			waitUntilLoad: Type.Optional(Type.Boolean({ default: true })),
			timeoutMs: Type.Optional(Type.Number({ default: 15_000 })),
			initScript: Type.Optional(Type.String({ description: "Optional JavaScript source to run in MAIN world at document_start of the next navigation. Useful for seeding localStorage, stubbing Date.now(), or defining navigator.webdriver=undefined. Requires the companion extension's webNavigation permission." })),
			background: Type.Optional(
				Type.Boolean({ description: "If true, navigate silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.navigate", withBackground(params), (params.timeoutMs ?? 15_000) + 2_000, signal);
			return { content: [{ type: "text", text: `Navigated to ${params.url}${params.initScript ? " (with initScript)" : ""}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_evaluate",
		label: "Chrome Evaluate",
		description:
			"Evaluate JavaScript in an existing Chrome tab through the companion extension. Runs in the page context and returns JSON-serializable values when possible. Runs in the background by default; pass background=false to focus Chrome and activate the tab.",
		promptSnippet: "Evaluate JavaScript in the active Chrome tab through the companion extension.",
		parameters: Type.Object({
			expression: Type.String(),
			awaitPromise: Type.Optional(Type.Boolean({ default: true })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, evaluate silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const value = await authorizedBridgeSend("page.evaluate", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const text = value === undefined
				? "undefined"
				: typeof value === "string"
					? value
					: safeJson(value) ?? "undefined";
			return { content: [{ type: "text", text: truncateText(text) }], details: { value: value as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_click",
		label: "Chrome Click",
		description:
			"Click a snapshot uid, CSS selector, or viewport coordinate using Chrome's real input layer. Pass includeSnapshot=true to return a fresh snapshot after the click.",
		promptSnippet: "Click page elements in Chrome by snapshot uid, selector, or viewport coordinate.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot. Prefer uid over selector after taking a snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to click. Prefer uid from chrome_snapshot when available." })),
			x: Type.Optional(Type.Number({ description: "Viewport x coordinate if uid/selector is omitted." })),
			y: Type.Optional(Type.Number({ description: "Viewport y coordinate if uid/selector is omitted." })),
			domFallback: Type.Optional(Type.Boolean({ description: "If true (default), fall back to DOM-dispatched click if Chrome's CDP input path is blocked by another extension overlay or debugger failure." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after the click." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, click silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.click", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const target = params.uid ?? params.selector ?? `${params.x},${params.y}`;
			const text = summary ? `Clicked ${target} — ${summary}` : `Clicked ${target}`;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_type",
		label: "Chrome Type",
		description:
			"Focus an optional snapshot uid or CSS selector, then type text using Chrome's real keyboard input. Pass includeSnapshot=true to return a fresh snapshot after typing.",
		promptSnippet: "Type text into Chrome, optionally focusing a snapshot uid or selector first.",
		parameters: Type.Object({
			text: Type.String(),
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to focus before typing." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after typing." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			pressEnter: Type.Optional(Type.Boolean()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, type silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.type", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
			const base = `Typed ${params.text.length} character(s)${into}.`;
			const text = summary ? `${base} (${summary})` : base;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_fill",
		label: "Chrome Fill",
		description:
			"Set the full value of a text input, textarea, or contenteditable element using Chrome click/select/delete/type input. Accepts a snapshot uid or CSS selector. Pass includeSnapshot=true to verify after filling.",
		promptSnippet: "Fill a Chrome form field by snapshot uid or selector, optionally returning a fresh snapshot.",
		parameters: Type.Object({
			text: Type.String(),
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to fill if uid is omitted." })),
			submit: Type.Optional(Type.Boolean({ description: "If true, press Enter after filling." })),
			domFallback: Type.Optional(Type.Boolean({ description: "If true (default), fall back to DOM value-setting if Chrome's CDP input path is blocked by another extension overlay or debugger failure." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after filling." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, fill silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.fill", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
			const base = `Filled ${params.text.length} character(s)${into}.`;
			const text = summary ? `${base} (${summary})` : base;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_fill_form",
		label: "Chrome Fill Form",
		description:
			"Fill many form fields in ONE bridge call (collapse round trips for signup/checkout forms) with per-field verification. Each field uses the same real-input CDP fill path as chrome_fill (triple-click select, type, best-effort value read-back). Fields fill sequentially within the call to avoid focus races; the whole form is one call either way.",
		promptSnippet: "Fill a whole Chrome form (many fields) in one call.",
		parameters: Type.Object({
			fields: Type.Array(
				Type.Object({
					uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot. Prefer uid over selector." })),
					selector: Type.Optional(Type.String({ description: "CSS selector for the field." })),
					text: Type.String({ description: "Text to type into the field." }),
					insertText: Type.Optional(Type.Boolean({ description: "Use fast whole-string insertion instead of per-character typing." })),
					delayScale: Type.Optional(Type.Number({ description: "Typing pacing scale, 0 (fast) to 4 (slow)." })),
					domFallback: Type.Optional(Type.Boolean({ description: "Allow the DOM-input fallback for this field when CDP input fails. Default true." })),
				}),
				{ description: "Fields to fill, each with uid or selector plus text." },
			),
			submit: Type.Optional(Type.Boolean({ description: "Press Enter in the last field after filling, submitting the form if the page maps it to submit." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.fillForm", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return {
				content: [{ type: "text", text: `Filled ${params.fields.length} field(s)${params.submit ? " and submitted" : ""}` }],
				details: { result: result as Json },
			};
		},
	});

	pi.registerTool({
		name: "chrome_key",
		label: "Chrome Key",
		description:
			"Send a keyboard key to an existing Chrome tab (Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, or one character). Runs in the background by default; pass background=false to focus Chrome and activate the tab so the user can watch. Pass includeSnapshot=true to verify after the keypress.",
		promptSnippet: "Press keys in Chrome through the companion extension.",
		parameters: Type.Object({
			key: Type.String(),
			modifiers: Type.Optional(Type.Object({
				shiftKey: Type.Optional(Type.Boolean()),
				ctrlKey: Type.Optional(Type.Boolean()),
				altKey: Type.Optional(Type.Boolean()),
				metaKey: Type.Optional(Type.Boolean()),
			}, { description: "Modifier keys to hold while pressing the key (chord)." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after the keypress." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, send the key silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.key", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const base = `Pressed ${params.key}.`;
			const text = summary ? `${base} (${summary})` : base;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_wait_for",
		label: "Chrome Wait For",
		description:
			"Poll an existing Chrome tab until a condition holds. kind=selector waits for a CSS selector to exist; kind=expression waits until a JavaScript expression is truthy; kind=navigation waits until location.href changes (or, when value is set, includes that substring); kind=networkIdle waits until no fetch/XHR has been in-flight for `value` milliseconds (instrumentation tags in-flight requests 'pending').",
		promptSnippet: "Wait for page state in Chrome before further automation.",
		parameters: Type.Object({
			kind: StringEnum(waitForValues),
			value: Type.Optional(Type.String({ description: "CSS selector when kind=selector; JavaScript expression when kind=expression; a URL substring when kind=navigation (omit to wait for any URL change); idle milliseconds when kind=networkIdle (e.g. \"800\")." })),
			timeoutMs: Type.Optional(Type.Number({ default: 10_000 })),
			intervalMs: Type.Optional(Type.Number({ default: 250 })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.waitFor", params, (params.timeoutMs ?? 10_000) + 2_000, signal);
			const observed =
				params.kind === "networkIdle"
					? `network idle for ${params.value || 500}ms`
					: params.kind === "navigation"
						? `navigation to ${params.value || "a new URL"}`
						: `${params.kind}: ${params.value ?? ""}`;
			return { content: [{ type: "text", text: `Observed ${observed} (${(result as { elapsedMs?: number })?.elapsedMs ?? ""}ms)` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_downloads",
		label: "Chrome Downloads",
		description:
			"Track and await browser downloads (browser-global, not tab-scoped). list shows recent downloads with their resolved final paths (incl. auto-rename); wait blocks until a matching download completes (or is interrupted) and returns its final path — use it after clicking an Export/CSV button; clear erases matching downloads from Chrome's history and optionally removes their files. The `downloads` permission was added to the companion extension for this tool.",
		promptSnippet: "List, await, or clear Chrome downloads and get resolved file paths.",
		parameters: Type.Object({
			action: StringEnum(downloadActionValues),
			id: Type.Optional(Type.Number({ description: "Exact download id to filter by (from a previous list/wait)." })),
			filenameRegex: Type.Optional(Type.String({ description: "Regex matched against the download's filename (e.g. \"report.*\.csv$\")." })),
			urlRegex: Type.Optional(Type.String({ description: "Regex matched against the download's URL." })),
			state: Type.Optional(Type.String({ description: "Filter by state for list: in_progress, complete, interrupted." })),
			limit: Type.Optional(Type.Number({ description: "Max downloads to list (default 50, newest first)." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Max ms to wait for a download to settle when action=wait (default 60000)." })),
			removeFiles: Type.Optional(Type.Boolean({ description: "action=clear: also delete the downloaded files from disk." })),
			background: Type.Optional(Type.Boolean({ description: "If true, suppress the download shelf and run silently. Defaults to the session background setting." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const action = params.action ?? "list";
			const timeoutMs = action === "wait" ? Math.min((params.timeoutMs ?? 60_000) + 5_000, 200_000) : DEFAULT_TIMEOUT_MS;
			const result = await authorizedBridgeSend(`downloads.${action}`, withBackground(params), timeoutMs, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_dialog",
		label: "Chrome Dialog",
		description:
			"Accept, dismiss, or answer a JavaScript dialog (alert/confirm/prompt/beforeunload) that is blocking the page. Dialogs are surfaced through the attached CDP debugger; alert() dialogs are auto-dismissed immediately so they never wedge an action chain, while confirm/prompt/beforeunload wait for this tool. Use after an action that likely triggered a dialog, or to unblock a chain stuck on one. The benchmark challenge 'dialog-handling' drives prompt()/confirm() and expects this tool to accept them (pass promptText for the prompt).",
		promptSnippet: "Handle an alert/confirm/prompt/beforeunload dialog in Chrome.",
		parameters: Type.Object({
			type: Type.Optional(StringEnum(dialogTypeValues)),
			accept: Type.Optional(Type.Boolean({ description: "true (default) = OK/Confirm; false = Cancel/Dismiss." })),
			promptText: Type.Optional(Type.String({ description: "Text to return for a prompt() dialog." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Max ms to wait for the dialog to appear (default 10000)." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.dialog", withBackground(params), (params.timeoutMs ?? 10_000) + 5_000, signal);
			const r = result as { handled?: boolean; dialogType?: string; message?: string; promptText?: string | null };
			return {
				content: [
					{
						type: "text",
						text: r.handled
							? `Handled ${r.dialogType} dialog (${r.promptText !== null && r.promptText !== undefined ? `promptText: ${r.promptText}` : "no prompt"})`
							: `Dialog result: ${safeJson(result)}`,
					},
				],
				details: { result: result as Json },
			};
		},
	});

	pi.registerTool({
		name: "chrome_emulate",
		label: "Chrome Emulate Device",
		description:
			"Set or clear CDP device emulation on the session automation tab: viewport size, device scale factor, mobile flag, user-agent override, and touch emulation. Touch emulation is enabled by default when setting metrics — the touch benchmark requires the renderer to synthesize real TouchEvents, which only happens while touch emulation is on. Emulation persists while the debugger stays attached (kept alive for this tab).",
		promptSnippet: "Emulate a device viewport, UA, and touch on the Chrome automation tab.",
		parameters: Type.Object({
			action: Type.Optional(StringEnum(emulateActionValues)),
			width: Type.Optional(Type.Number({ description: "Viewport width in CSS px (default 1280)." })),
			height: Type.Optional(Type.Number({ description: "Viewport height in CSS px (default 800)." })),
			deviceScaleFactor: Type.Optional(Type.Number({ description: "Device scale factor (default 1)." })),
			mobile: Type.Optional(Type.Boolean({ description: "Emit mobile viewport semantics (default false)." })),
			touch: Type.Optional(Type.Boolean({ description: "Enable touch emulation (default true when action=set)." })),
			ua: Type.Optional(Type.String({ description: "User-agent override (also applied at the network layer)." })),
			platform: Type.Optional(Type.String({ description: "Platform override accompanying ua (e.g. 'Linux armv81' / 'iPhone')." })),
			acceptLanguage: Type.Optional(Type.String({ description: "Accept-Language override accompanying ua." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.emulate", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_list_console_messages",
		label: "Chrome Console Messages",
		description:
			"List console messages captured in the page by the companion extension. Capture starts after any chrome_snapshot, chrome_evaluate, chrome_list_console_messages, or chrome_list_network_requests call installs page instrumentation.",
		promptSnippet: "List captured console messages from the active Chrome page.",
		parameters: Type.Object({
			clear: Type.Optional(Type.Boolean({ description: "Clear the captured console log after reading." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: "If true, run silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.console.list", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_list_network_requests",
		label: "Chrome Network Requests",
		description:
			"List fetch/XMLHttpRequest activity captured in the page by the companion extension plus (when CDP network capture is on, see chrome_network_capture) document/static-asset requests captured through the CDP Network domain. In-page capture starts after instrumentation is installed by snapshot/evaluate/network/console tools. CDP-captured entries (including document loads, scripts, stylesheets, images) appear in the cdpEntries field with source:cdp, request/response headers, status, and timings; their response bodies are fetched on demand by chrome_network_export or chrome_get_network_request. Use includePreservedRequests=true to keep requests from earlier same-tab navigations that were captured before navigation.",
		promptSnippet: "List captured XHR/fetch requests from the active Chrome page before doing DOM-heavy debugging.",
		parameters: Type.Object({
			includePreservedRequests: Type.Optional(Type.Boolean({ description: "Include captured requests from earlier locations in the same tab/session." })),
			clear: Type.Optional(Type.Boolean({ description: "Clear the captured request log after reading." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: "If true, run silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.network.list", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_get_network_request",
		label: "Chrome Network Request",
		description:
			"Retrieve one captured network entry by requestId from chrome_list_network_requests, including response body when available. Resolves in-page fetch/XMLHttpRequest entries first, then falls back to CDP Network-domain entries (requestId from the cdpEntries field, e.g. a document/static request); CDP fallback bodies are fetched on demand for text-like responses.",
		promptSnippet: "Fetch captured request details and response body by requestId.",
		parameters: Type.Object({
			requestId: Type.String({ description: "Request id returned by chrome_list_network_requests." }),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: "If true, run silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.network.get", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_network_capture",
		label: "Chrome Network Capture (CDP Network domain)",
		description:
			"Turn persistent CDP Network-domain capture on/off for the session automation tab. When enabled, the companion extension holds the debugger attach open (skipping the idle-detach), enables the CDP Network domain, and records document/static/fetch/XHR requests with request+response headers, status, timings, and redirect chains — closing the gap where chrome_list_network_requests only saw fetch/XHR. Off by default so the attach still idle-detaches; pass clear=true to drop previously captured CDP entries.",
		promptSnippet: "Enable CDP Network-domain capture to see document/static requests, or disable it to restore the idle-detach attach model.",
		parameters: Type.Object({
			enabled: Type.Boolean({ description: "true = enable persistent CDP Network capture (attach stays open, Network domain enabled); false = disable and return to the idle-detach model." }),
			clear: Type.Optional(Type.Boolean({ description: "If true, also drop the captured CDP entries for the resolved tab." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: "If true, run silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("network.mode", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const r = result as { enabled?: boolean; capturedCdpEntries?: number; blockedUrls?: string[] };
			const captured = r.capturedCdpEntries ?? 0;
			const blockedCount = r.blockedUrls?.length ?? 0;
			return {
				content: [
					{
						type: "text",
						text: r.enabled
							? `Network capture on: ${captured} CDP entr${captured === 1 ? "y" : "ies"} retained${blockedCount ? `, ${blockedCount} blocked pattern(s)` : ""}.`
							: `Network capture off (idle-detach model restored).`,
					},
				],
				details: { result: result as Json },
			};
		},
	});

	pi.registerTool({
		name: "chrome_network_block",
		label: "Chrome Network Block",
		description:
			"Block matching network requests on the session automation tab via CDP Network.setBlockedURLs (Chrome wildcard patterns, e.g. \"*://*.analytics.example/*\"). Enables the CDP Network attach on demand if capture mode is off. Pass an empty array to clear all blocked patterns. Blocked requests fail fast (net::ERR_BLOCKED_BY_CLIENT) and never reach the server.",
		promptSnippet: "Block or unblock URL patterns at the network layer (CDP Network.setBlockedURLs).",
		parameters: Type.Object({
			urlPatterns: Type.Array(Type.String({ description: "Chrome URL patterns to block (e.g. \"*://*.ads.example/*\"). Empty array clears blocking." }), { description: "URL patterns to block." }),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: "If true, run silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("network.block", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const r = result as { urlPatterns?: string[]; blocked?: boolean };
			return {
				content: [
					{
						type: "text",
						text: r.blocked
							? `Blocking ${(r.urlPatterns ?? []).length} URL pattern(s): ${(r.urlPatterns ?? []).join(", ")}`
							: "Cleared all blocked URL patterns.",
					},
				],
				details: { result: result as Json },
			};
		},
	});

	pi.registerTool({
		name: "chrome_network_export",
		label: "Chrome Network Export (HAR)",
		description:
			"Serialize captured network traffic for the session automation tab into a HAR-format JSON file under .pi/chrome-network/ (customize with path) and return the file path. Combines CDP Network-domain entries (document/static/fetch/XHR — enable with chrome_network_capture) with the in-page fetch/XHR capture that already carries response bodies; response bodies for CDP entries are fetched on demand (text-like types only, size-capped). The file is a grep-able artifact for API debugging.",
		promptSnippet: "Export captured Chrome network traffic as a HAR file for API debugging.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Output path. Defaults to .pi/chrome-network/<timestamp>.har." })),
			includeBodies: Type.Optional(Type.Boolean({ default: true, description: "Fetch response bodies for CDP-captured entries (text-like types, size-capped, budgeted). Set false for a metadata-only HAR." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: "If true, run silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			const cwd = workspaceCwd(ctx);
			const defaultPath = join(cwd, ".pi", "chrome-network", `${new Date().toISOString().replace(/[:.]/g, "-")}.har`);
			const outputPath = params.path ? resolve(cwd, params.path) : defaultPath;
			const result = (await authorizedBridgeSend("network.export", withBackground(params), 60_000, signal)) as {
				har?: unknown;
				count?: number;
				pageEntries?: number;
				cdpEntries?: number;
				truncated?: boolean;
				mode?: boolean;
			};
			if (!result.har) throw new Error("Network export returned no HAR payload");
			await mkdir(dirname(outputPath), { recursive: true });
			await writeFile(outputPath, JSON.stringify(result.har, null, 2));
			const count = result.count ?? 0;
			return {
				content: [
					{
						type: "text",
						text: `Exported ${count} network entr${count === 1 ? "y" : "ies"} to ${outputPath} (${result.pageEntries ?? 0} in-page, ${result.cdpEntries ?? 0} CDP${result.truncated ? ", truncated" : ""}).`,
					},
				],
				details: { path: outputPath, count, pageEntries: result.pageEntries, cdpEntries: result.cdpEntries, truncated: result.truncated, captureMode: result.mode } as unknown as Record<string, unknown>,
			};
		},
	});

	pi.registerTool({
		name: "chrome_screenshot",
		label: "Chrome Screenshot",
		description:
			"Capture a screenshot of an existing Chrome tab via the companion extension and save it to disk. Chrome's extension screenshot API requires the target tab to be the active tab in its window. Runs in the background by default (the tab is briefly activated within its window for the capture, then the previous active tab is restored); pass background=false to focus Chrome so the user can watch.",
		promptSnippet: "Capture Chrome screenshots and save them under .pi/chrome-screenshots by default.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Output path. Defaults to .pi/chrome-screenshots/<timestamp>.<format>." })),
			format: Type.Optional(StringEnum(imageFormatValues)),
			quality: Type.Optional(Type.Number({ description: "JPEG quality 0-100." })),
			uid: Type.Optional(Type.String({ description: "Snapshot uid (el-...) of the element to capture. Resolves the element's bounding rect and crops the capture to it via CDP; works on inactive tabs without focusing Chrome." })),
			selector: Type.Optional(Type.String({ description: "CSS selector of the element to capture (alternative to uid)." })),
			fullPage: Type.Optional(Type.Boolean({ description: "Not supported by the extension bridge yet; viewport screenshots are captured. Cannot be combined with uid/selector." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true (the default), capture silently without focusing the Chrome window (the target tab is briefly activated within its window for the capture, then restored); pass false to focus Chrome." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext): Promise<ToolTextResult> {
			const format = params.format ?? "png";
			const cwd = workspaceCwd(ctx);
			const defaultPath = join(cwd, ".pi", "chrome-screenshots", `${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`);
			const outputPath = params.path ? resolve(cwd, params.path) : defaultPath;
			const result = (await authorizedBridgeSend("page.screenshot", withBackground(params), params.fullPage ? 120_000 : DEFAULT_TIMEOUT_MS, signal)) as {
				dataUrl?: string;
				tab?: unknown;
				fullPage?: boolean;
				dimensions?: { width: number; height: number; viewportHeight: number; dpr: number };
				tiles?: Array<{ y: number; dataUrl: string }>;
			};
			await mkdir(dirname(outputPath), { recursive: true });
			if (result.fullPage && result.tiles && result.dimensions) {
				// Stitch via PNG if format is png; otherwise we fall back to writing tile files and a
				// manifest. We avoid pulling in an image library by writing each tile next to the main
				// path with a -tileN suffix and a stitched.json manifest.
				const { width, height, viewportHeight, dpr } = result.dimensions;
				const manifest: Array<{ path: string; y: number }> = [];
				for (let i = 0; i < result.tiles.length; i++) {
					const tile = result.tiles[i];
					const tilePath = outputPath.replace(/(\.[^.]+)$/, `-tile${i}$1`);
					const base64 = tile.dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, "");
					await writeFile(tilePath, Buffer.from(base64, "base64"));
					manifest.push({ path: tilePath, y: tile.y });
				}
				await writeFile(outputPath + ".json", JSON.stringify({ width, height, viewportHeight, dpr, tiles: manifest }, null, 2));
				return {
					content: [{ type: "text", text: `Saved ${result.tiles.length} full-page tile(s) for ${width}×${height}px page. Manifest: ${outputPath}.json` }],
					details: { manifest: outputPath + ".json", tiles: manifest, dimensions: result.dimensions, tab: result.tab } as unknown as Record<string, unknown>,
				};
			}
			if (!result.dataUrl) throw new Error("Screenshot returned no dataUrl");
			const base64 = result.dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, "");
			await writeFile(outputPath, Buffer.from(base64, "base64"));
			return { content: [{ type: "text", text: `Saved Chrome screenshot to ${outputPath}` }], details: { path: outputPath, format, tab: result.tab } };
		},
	});

	pi.registerTool({
		name: "chrome_hover",
		label: "Chrome Hover",
		description: "Hover over an element by uid, selector, or x/y using Chrome pointer movement.",
		promptSnippet: "Hover a Chrome element to trigger :hover / mouseover handlers.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.hover", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Hovered ${params.uid ?? params.selector ?? `${params.x},${params.y}`}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_drag",
		label: "Chrome Drag",
		description: "Drag from one uid/selector/point to another using Chrome pointer input.",
		promptSnippet: "Drag a Chrome element from one point to another.",
		parameters: Type.Object({
			fromUid: Type.Optional(Type.String()),
			fromSelector: Type.Optional(Type.String()),
			fromX: Type.Optional(Type.Number()),
			fromY: Type.Optional(Type.Number()),
			toUid: Type.Optional(Type.String()),
			toSelector: Type.Optional(Type.String()),
			toX: Type.Optional(Type.Number()),
			toY: Type.Optional(Type.Number()),
			steps: Type.Optional(Type.Number({ default: 12 })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.drag", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Dragged from ${params.fromUid ?? params.fromSelector} to ${params.toUid ?? params.toSelector}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_tap",
		label: "Chrome Tap (Touch)",
		description:
			"Dispatch a real touchstart/touchend tap through Chrome's input layer. Use for sites that gate on TouchEvent rather than MouseEvent (mobile-first PWAs, swipe carousels). Chrome may show its debugging banner while attached.",
		promptSnippet: "Tap (real touch) a Chrome element by snapshot uid, selector, or coordinate.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.tap", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const target = params.uid ?? params.selector ?? `${params.x},${params.y}`;
			return { content: [{ type: "text", text: `Tapped ${target} (touch)` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_scroll",
		label: "Chrome Scroll",
		description: "Scroll the page or a specific scrollable element by dispatching real wheel events with momentum-shaped deltas, then applying the scroll. Positive deltaY scrolls down. Pass uid/selector to scroll within a container, otherwise the document scrolls.",
		promptSnippet: "Scroll a Chrome page or container via wheel events (not raw scrollTop).",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			deltaY: Type.Optional(Type.Number({ description: "Pixels to scroll vertically. Positive = down." })),
			deltaX: Type.Optional(Type.Number({ description: "Pixels to scroll horizontally. Positive = right." })),
			steps: Type.Optional(Type.Number({ description: "Number of wheel events to dispatch. Defaults to ceil(|deltaY|/100)." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.scroll", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Scrolled dy=${params.deltaY ?? 0} dx=${params.deltaX ?? 0}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_upload_file",
		label: "Chrome Upload File",
		description: "Attach local files to an <input type=file> element using Chrome DevTools file-input control. Does NOT open the native file picker; works with React/Vue/Angular controlled inputs.",
		promptSnippet: "Attach local files to a Chrome <input type=file> without opening the native file picker.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			paths: Type.Array(Type.String(), { description: "Local absolute file paths to upload." }),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			const cwd = workspaceCwd(ctx);
			const paths = params.paths.map((p) => resolve(cwd, p));
			const result = await authorizedBridgeSend("page.upload", withBackground({ ...params, paths }), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Uploaded ${paths.length} file(s) to ${params.uid ?? params.selector}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_diff",
		label: "Chrome Diff",
		description:
			"Compare two Chrome snapshot digests (the `digest` shape from chrome_snapshot) and report what changed between them: URL/title/text content, focused/modal element, and added/removed/updated controls. Runs entirely on the Pi side - no bridge call. Use it to confirm an action changed the page as expected before continuing.",
		promptSnippet: "Compare two Chrome snapshot digests and report what changed between them.",
		parameters: Type.Object({
			before: Type.Object({
				url: Type.Optional(Type.String()),
				title: Type.Optional(Type.String()),
				textHash: Type.Optional(Type.String()),
				focusedUid: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				modalUid: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				labels: Type.Optional(Type.Array(Type.Object({
					uid: Type.String(),
					role: Type.Optional(Type.String()),
					label: Type.Optional(Type.String()),
					disabled: Type.Optional(Type.Boolean()),
					value: Type.Optional(Type.String()),
					checked: Type.Optional(Type.Boolean()),
				}))),
			}),
			after: Type.Object({
				url: Type.Optional(Type.String()),
				title: Type.Optional(Type.String()),
				textHash: Type.Optional(Type.String()),
				focusedUid: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				modalUid: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				labels: Type.Optional(Type.Array(Type.Object({
					uid: Type.String(),
					role: Type.Optional(Type.String()),
					label: Type.Optional(Type.String()),
					disabled: Type.Optional(Type.Boolean()),
					value: Type.Optional(Type.String()),
					checked: Type.Optional(Type.Boolean()),
				}))),
			}),
		}),
		async execute(_id, params): Promise<ToolTextResult> {
			const { lines, diff } = diffDigests(params.before as SnapshotDigest, params.after as SnapshotDigest);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { diff } };
		},
	});
	}

}
