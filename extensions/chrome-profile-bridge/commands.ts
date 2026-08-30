// Host-free pure logic for the pi-chrome bridge. Everything here is deliberately free of
// the pi host and of node:http / network I/O so the exactly-once protocol state machine, the
// snapshot/history formatters, the digest differ, the auth-state transitions, and the
// executed-command journal eviction policy are unit-testable under plain node
// (test-suite/unit/bridge-protocol.test.mjs, test-suite/unit/host.test.mjs).
//
// IMPORTANT: keep this file free of non-erasable TypeScript syntax (no parameter properties,
// enums, or namespaces) and of any imports — node's type-stripping loads it directly in tests.
// index.ts imports these same functions/classes, so the tests exercise the shipped code.

// ---------------------------------------------------------------------------
// Types shared with index.ts
// ---------------------------------------------------------------------------

export type BridgeCommand = {
	id: string;
	action: string;
	params: Record<string, unknown>;
};

// Exactly-once state machine (S1.2): "pending" = served but not yet acked, "received" =
// acked by the extension but no result posted, "completed" = /result resolved/rejected it.
export type PendingEntry = {
	command: BridgeCommand;
	state: "pending" | "received" | "completed";
	deliveredAt?: number;
	ackedAt?: number;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export type OrphanedCommand = {
	id: string;
	action: string;
	ackedAt: number;
};

export type BridgeResult = {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
};

export type HistoryEntry = {
	at: number;
	action: string;
	paramsSummary: string;
	ok: boolean;
	error?: string;
	durationMs: number;
	sessionKey?: string;
	// Full wire params retained ONLY for `chrome history replay`; never rendered (S4).
	params: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// History ring + param redaction (S4)
// ---------------------------------------------------------------------------

export const CHROME_HISTORY_CAP = 200;
// Wire-only params authorizedBridgeSend injects; noise in the history summary.
export const HISTORY_PARAMS_SKIP = new Set(["sessionKey", "groupTitle", "sessionGroupTitle", "joinSessionGroup", "foreground"]);
// chrome_storage set writes cookie/web-storage values (secrets); the /chrome history summary
// must never render them (feat-storage redaction). Read responses carry values only in the tool
// result, which history never stores.
export const STORAGE_VALUE_REDACT_ACTIONS = new Set(["storage.op"]);

export function summarizeParams(params: Record<string, unknown>, action = ""): string {
	const redactValues = STORAGE_VALUE_REDACT_ACTIONS.has(action);
	const parts: string[] = [];
	for (const [key, value] of Object.entries(params)) {
		if (HISTORY_PARAMS_SKIP.has(key) || value === undefined) continue;
		let rendered: string;
		if (redactValues && key === "value") rendered = "[redacted]";
		else if (typeof value === "string") rendered = `"${compactLine(value, 40)}"`;
		else if (typeof value === "object" && value !== null) {
			const json = safeJson(value);
			rendered = json.length > 48 ? `${json.slice(0, 47)}…` : json;
		} else rendered = String(value);
		parts.push(`${key}=${rendered}`);
	}
	return parts.join(" ") || "(no params)";
}

export function recordHistory(history: HistoryEntry[], entry: Omit<HistoryEntry, "at" | "durationMs">, startedAt: number): void {
	history.push({ ...entry, at: Date.now(), durationMs: Date.now() - startedAt });
	if (history.length > CHROME_HISTORY_CAP) history.splice(0, history.length - CHROME_HISTORY_CAP);
}

// ---------------------------------------------------------------------------
// Text/snapshot formatters (pure, host-free)
// ---------------------------------------------------------------------------

export const MAX_TEXT_CHARS = 30_000;
export const MAX_ELEMENTS = 80;

export function truncateText(text: string, maxChars = MAX_TEXT_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]`;
}

export function safeJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

export function compactLine(value: unknown, max = 140): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function rectText(rect: any): string {
	if (!rect) return "?";
	return `${rect.x},${rect.y} ${rect.width}x${rect.height}`;
}

export function formatChromeSnapshot(snapshot: any): string {
	if (!snapshot || typeof snapshot !== "object") return safeJson(snapshot);
	if (snapshot.mode === "full") return truncateText(safeJson(snapshot));
	const lines: string[] = [];
	lines.push(`# Chrome snapshot${snapshot.mode ? ` (${snapshot.mode})` : ""}`);
	lines.push(`${snapshot.title || "(untitled)"}`);
	if (snapshot.url) lines.push(`${snapshot.url}`);
	if (snapshot.viewport) lines.push(`viewport=${snapshot.viewport.width}x${snapshot.viewport.height} scroll=${snapshot.viewport.scrollX || 0},${snapshot.viewport.scrollY || 0}`);
	if (snapshot.summary?.modal) lines.push(`modal: ${snapshot.summary.modal.uid} ${compactLine(snapshot.summary.modal.label)}`);
	if (snapshot.summary?.focused) lines.push(`focused: ${snapshot.summary.focused.uid} ${snapshot.summary.focused.role || ""} ${compactLine(snapshot.summary.focused.label)}`);
	if (Array.isArray(snapshot.summary?.hints) && snapshot.summary.hints.length) {
		lines.push("\n## Hints");
		for (const hint of snapshot.summary.hints.slice(0, 6)) lines.push(`- ${hint}`);
	}
	if (snapshot.diff && !snapshot.diff.firstSnapshot) {
		const changed = [
			...(snapshot.diff.changes || []).map((c: any) => c.kind === "textChanged" ? "text changed" : `${c.kind}: ${compactLine(c.before, 50)} → ${compactLine(c.after, 50)}`),
			...(snapshot.diff.added || []).slice(0, 4).map((e: any) => `added ${e.uid} ${e.role || ""} ${compactLine(e.label)}`),
			...(snapshot.diff.updated || []).slice(0, 4).map((u: any) => `updated ${u.uid} ${compactLine(u.after?.label || u.before?.label)}`),
		];
		if (changed.length) {
			lines.push("\n## Changed since last snapshot");
			for (const item of changed.slice(0, 10)) lines.push(`- ${item}`);
		}
	}
	if (Array.isArray(snapshot.matches) && snapshot.matches.length) {
		lines.push(`\n## Matches for "${snapshot.query}"`);
		for (const match of snapshot.matches.slice(0, 12)) {
			if (match.kind === "text") lines.push(`- ${match.uid} text ${compactLine(match.text)} @ ${rectText(match.rect)}`);
			else if (match.kind === "region") lines.push(`- ${match.uid} region ${compactLine(match.label)} headings=${(match.headings || []).map((h: string) => compactLine(h, 50)).join(" | ")}`);
			else lines.push(`- ${match.uid} ${match.role || match.tag || "element"}${match.disabled ? " disabled" : ""} ${compactLine(match.label || match.selector)} @ ${rectText(match.rect)}`);
		}
	}
	if (snapshot.mode === "pageMap" && snapshot.pageMap) {
		lines.push("\n## Page map");
		for (const region of (snapshot.pageMap.regions || []).slice(0, 18)) {
			lines.push(`- ${region.uid} ${region.kind}: ${compactLine(region.label)}`);
			for (const action of (region.actions || []).slice(0, 5)) lines.push(`  - ${action.uid} ${action.role || ""}${action.disabled ? " disabled" : ""} ${compactLine(action.label)}`);
		}
		if (snapshot.pageMap.headings?.length) {
			lines.push("\nHeadings:");
			for (const h of snapshot.pageMap.headings.slice(0, 20)) lines.push(`- ${h.uid} h${h.level || ""} ${compactLine(h.text)}`);
		}
	}
	if (Array.isArray(snapshot.layout) && snapshot.layout.length && snapshot.mode !== "changes") {
		lines.push("\n## Layout / context");
		for (const section of snapshot.layout.slice(0, snapshot.mode === "pageMap" ? 18 : 8)) {
			const bits = [`${section.uid}`, section.role || section.tag, compactLine(section.label || section.text || "(unnamed section)", 110), `@ ${rectText(section.rect)}`];
			lines.push(`- ${bits.filter(Boolean).join(" ")}`);
			const fieldLabels = (section.fields || []).slice(0, 4).map((f: any) => `${f.uid} ${compactLine(f.label || f.role, 40)}`);
			const actionLabels = (section.actions || []).slice(0, 5).map((a: any) => `${a.uid}${a.disabled ? " disabled" : ""} ${compactLine(a.label || a.role, 40)}`);
			if (fieldLabels.length) lines.push(`  fields: ${fieldLabels.join("; ")}`);
			if (actionLabels.length) lines.push(`  actions: ${actionLabels.join("; ")}`);
		}
	}
	if ((snapshot.mode === "forms" || snapshot.forms?.fields?.length) && snapshot.mode !== "pageMap") {
		const fields = snapshot.forms?.fields || [];
		const submits = snapshot.forms?.submits || [];
		if (fields.length || submits.length) lines.push("\n## Forms");
		for (const field of fields.slice(0, snapshot.mode === "forms" ? 40 : 12)) {
			const bits = [field.uid, field.role || field.tag, field.required ? "required" : "", field.invalid ? "invalid" : "", field.disabled ? "disabled" : "", compactLine(field.label || field.selector, 90)];
			if (field.value) bits.push(`value=${compactLine(field.value, 50)}`);
			else if (field.valueRedacted) bits.push("value=[redacted]");
			lines.push(`- ${bits.filter(Boolean).join(" ")} @ ${rectText(field.rect)}`);
		}
		for (const submit of submits.slice(0, 8)) lines.push(`- ${submit.uid} submit/action${submit.disabled ? " disabled" : ""} ${compactLine(submit.label || submit.selector)} @ ${rectText(submit.rect)}`);
	}
	if (Array.isArray(snapshot.elements) && snapshot.mode !== "pageMap") {
		lines.push("\n## Visible actions");
		for (const el of snapshot.elements.slice(0, snapshot.mode === "interactive" ? 60 : 25)) {
			const flags = [el.disabled ? "disabled" : "", el.occluded ? `occluded-by-${el.occluded.tag}` : ""].filter(Boolean).join(",");
			const context = el.context?.label ? ` in ${el.context.uid} ${compactLine(el.context.label, 60)}` : "";
			lines.push(`- ${el.uid} ${el.role || el.tag}${flags ? ` [${flags}]` : ""} ${compactLine(el.label || el.selector)}${context} @ ${rectText(el.rect)}`);
		}
		if (snapshot.elements.length > (snapshot.mode === "interactive" ? 60 : 25)) lines.push(`- … ${snapshot.elements.length - (snapshot.mode === "interactive" ? 60 : 25)} more; retry with maxElements or mode=interactive`);
	}
	if ((snapshot.mode === "text" || snapshot.mode === "auto") && Array.isArray(snapshot.textSnippets) && snapshot.textSnippets.length) {
		lines.push("\n## Text snippets");
		for (const snip of snapshot.textSnippets.slice(0, snapshot.mode === "text" ? 40 : 14)) lines.push(`- ${snip.uid} ${compactLine(snip.text, snapshot.mode === "text" ? 240 : 160)}`);
		if (snapshot.textTruncated) lines.push("- … page text truncated; retry with mode=text or maxTextChars for more");
	}
	lines.push("\nTip: use chrome_snapshot({query:'...', mode:'interactive|forms|pageMap|text|changes|full'}) or nearUid to zoom in.");
	return truncateText(lines.join("\n"));
}

export function formatIncludedSnapshotText(raw: unknown, text: string): string {
	const snapshot = raw && typeof raw === "object" ? (raw as { snapshot?: unknown }).snapshot : undefined;
	return snapshot ? `${text}\n\n${formatChromeSnapshot(snapshot)}` : text;
}

export function formatChromeInspect(inspect: any): string {
	if (!inspect || typeof inspect !== "object") return safeJson(inspect);
	const t = inspect.target || {};
	const lines: string[] = [];
	lines.push(`# Chrome inspect ${t.uid || ""}`.trim());
	lines.push(`${t.role || t.tag || "element"}${t.disabled ? " disabled" : ""}${t.occluded ? ` occluded-by-${t.occluded.tag}` : ""} ${compactLine(t.label || t.selector)}`);
	if (t.selector) lines.push(`selector: ${t.selector}`);
	if (t.rect) lines.push(`rect: ${rectText(t.rect)}`);
	if (inspect.clickSuggestion) lines.push(`suggested click: chrome_click({ uid: "${inspect.clickSuggestion.uid}" }) or x=${inspect.clickSuggestion.x}, y=${inspect.clickSuggestion.y}`);
	if (Array.isArray(inspect.nearbyText) && inspect.nearbyText.length) {
		lines.push("\n## Nearby text");
		for (const item of inspect.nearbyText.slice(0, 12)) lines.push(`- ${item.uid} ${compactLine(item.text, 180)}`);
	}
	if (inspect.formContext) {
		lines.push("\n## Form context");
		for (const field of (inspect.formContext.fields || []).slice(0, 20)) lines.push(`- ${field.uid} ${field.role || field.tag}${field.disabled ? " disabled" : ""} ${compactLine(field.label || field.selector)}${field.value ? ` value=${compactLine(field.value, 60)}` : field.valueRedacted ? " value=[redacted]" : ""}`);
		for (const action of (inspect.formContext.actions || []).slice(0, 10)) lines.push(`- ${action.uid} action${action.disabled ? " disabled" : ""} ${compactLine(action.label || action.selector)}`);
	}
	if (Array.isArray(inspect.nearbyActions) && inspect.nearbyActions.length) {
		lines.push("\n## Nearby actions");
		for (const action of inspect.nearbyActions.slice(0, 18)) lines.push(`- ${action.uid} ${action.role || action.tag}${action.disabled ? " disabled" : ""} ${compactLine(action.label || action.selector)} @ ${rectText(action.rect)}`);
	}
	if (Array.isArray(inspect.ancestors) && inspect.ancestors.length) {
		lines.push("\n## Ancestors");
		for (const a of inspect.ancestors.slice(0, 6)) lines.push(`- ${a.uid} ${a.role || a.tag} ${compactLine(a.label || a.selector, 120)}`);
	}
	return truncateText(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// chrome_network_initiator_chain formatter (P0; pure, host-free)
// ---------------------------------------------------------------------------
// Renders the SW's buildInitiatorChain response as the DevTools-style ancestor chain
// "Document → script:line:col → request" with stack hints, plus dependents when requested.
// The response shape is defined in TOOL_CONTRACTS.md §5.21.
export function formatInitiatorChain(result: Record<string, unknown>): string {
	if (!result || typeof result !== "object") return safeJson(result);
	const lines: string[] = [];
	const url = String(result.url ?? "");
	const method = String(result.method ?? "GET");
	lines.push(`Request ${method} ${url}${result.requestId ? ` (${String(result.requestId)})` : ""}`);
	const ambiguous = result.ambiguous as { matched?: number; candidates?: string[] } | undefined;
	if (ambiguous) {
		lines.push(`⚠ ${ambiguous.matched ?? 0} captured requests match the URL filter; showing the most recent (candidates: ${(ambiguous.candidates ?? []).join(", ")}).`);
	}
	const chain = Array.isArray(result.chain) ? (result.chain as Array<Record<string, unknown>>) : [];
	const nodes = [...chain.map(chainNodeLine), `${method} ${url}`];
	lines.push(`Initiator chain: ${nodes.join("\n  → ")}`);
	if (!chain.length) lines.push("  (this request's trigger was not linked to another captured request)");
	const init = result.initiator as Record<string, unknown> | null | undefined;
	if (init) {
		const stack = Array.isArray(init.stack) ? (init.stack as Array<{ functionName?: string; url?: string; lineNumber?: number | null; columnNumber?: number | null }>) : [];
		if (stack.length) {
			const top = stack.slice(0, 4).map((f) => `${f.functionName || "(anonymous)"} @ ${f.url}:${f.lineNumber ?? "?"}:${f.columnNumber ?? "?"}`);
			lines.push(`Triggering stack: ${top.join("\n  " )}${stack.length > 4 ? "\n  …" : ""}`);
		}
	}
	if (Array.isArray(result.dependents)) {
		const count = typeof result.dependentCount === "number" ? result.dependentCount : (result.dependents as unknown[]).length;
		lines.push(`Dependents (${count}${result.dependentsTruncated ? ", truncated" : ""}):`);
		for (const d of (result.dependents as Array<Record<string, unknown>>).slice(0, 12)) lines.push(`  → ${String(d.method ?? "GET")} ${String(d.url ?? "")}`);
	}
	return truncateText(lines.join("\n"));
}

function chainNodeLine(node: Record<string, unknown>): string {
	const init = node.initiator as Record<string, unknown> | null | undefined;
	const loc =
		init && typeof init.lineNumber === "number"
			? `:${init.lineNumber}${typeof init.columnNumber === "number" ? `:${init.columnNumber}` : ""}`
			: "";
	return `${String(node.method ?? "GET")} ${String(node.url ?? "")}${loc}`;
}

// ---------------------------------------------------------------------------
// P0 tool formatters (pure, testable; added by the P0 batch per TOOL_CONTRACTS §2.6)
// ---------------------------------------------------------------------------

export function formatBytes(value: number): string {
	if (!Number.isFinite(value) || value < 0) return String(value);
	if (value < 1024) return `${Math.round(value)} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
	return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatComputedStyle(result: Record<string, unknown>): string {
	const node = result.node as Record<string, unknown> | undefined;
	const map = (result.computedStyle ?? {}) as Record<string, unknown>;
	const keys = Object.keys(map);
	const target = node && (node.uid || node.selector) ? String(node.uid || node.selector) : "";
	const head = target ? `Computed style for ${target}` : `Computed style (${keys.length} propert${keys.length === 1 ? "y" : "ies"})`;
	const lines: string[] = [head];
	const shown = keys.slice(0, 24);
	for (const k of shown) lines.push(`  ${k}: ${String(map[k])}`);
	if (keys.length > shown.length) lines.push(`  … ${keys.length - shown.length} more${result.truncated ? " (truncated)" : ""}`);
	return truncateText(lines.join("\n"));
}

export function formatBoxModel(result: Record<string, unknown>): string {
	const box = result.boxModel as Record<string, unknown> | undefined;
	const node = result.node as Record<string, unknown> | undefined;
	if (!box) return safeJson(result);
	const quad = (v: unknown) =>
		Array.isArray(v) && v.length >= 8
			? `(${Number(v[0]).toFixed(0)},${Number(v[1]).toFixed(0)})→(${Number(v[6]).toFixed(0)},${Number(v[7]).toFixed(0)})`
			: "?";
	const target = node && (node.uid || node.selector) ? ` for ${String(node.uid || node.selector)}` : "";
	return truncateText(
		[
			`Box model${target}: ${Number(box.width) || 0}×${Number(box.height) || 0}px`,
			`  content ${quad(box.content)}  padding ${quad(box.padding)}  border ${quad(box.border)}  margin ${quad(box.margin)}`,
		].join("\n"),
	);
}

export function formatDomAtPoint(result: Record<string, unknown>): string {
	const node = result.node as Record<string, unknown> | undefined;
	if (!node) return safeJson(result);
	const name = String(node.nodeName || node.localName || "?");
	const attrs = Array.isArray(node.attributes) ? (node.attributes as string[]).join(" ") : "";
	const lines = [`Node at (${String(result.x)}, ${String(result.y)}): <${name}${attrs ? ` ${attrs}` : ""}>`];
	if (typeof result.outerHTML === "string") lines.push(compactLine(result.outerHTML, 300));
	return truncateText(lines.join("\n"));
}

export function formatProperties(result: Record<string, unknown>): string {
	const props = Array.isArray(result.properties) ? (result.properties as Array<Record<string, unknown>>) : [];
	const target = result.target ? ` for ${String(result.target)}` : "";
	const lines = [`Properties${target} (${props.length}):`];
	for (const p of props.slice(0, 40)) {
		const name = String(p.name ?? "?");
		const value = p.value === undefined ? "<accessor>" : typeof p.value === "string" ? p.value : compactLine(p.value, 60);
		lines.push(`  ${p.isOwn ? "own" : "inh"} ${p.enumerable ? "enum" : "    "} ${name}: ${value}`);
	}
	if (props.length > 40) lines.push(`  … ${props.length - 40} more${result.truncated ? " (truncated)" : ""}`);
	return truncateText(lines.join("\n"));
}

export function formatWatchSamples(result: Record<string, unknown>): string {
	const samples = Array.isArray(result.samples) ? (result.samples as Array<Record<string, unknown>>) : [];
	const lines = [`Watch ${String(result.expression ?? "")} — ${samples.length} sample(s), stopped: ${String(result.stopped ?? "")}:`];
	for (const s of samples.slice(-12)) {
		const t = Number(s.t) ?? 0;
		const v = s.error !== undefined ? `ERR ${compactLine(s.error, 60)}` : compactLine(s.value, 80);
		lines.push(`  t=${t}ms  ${v}`);
	}
	if (samples.length > 12) lines.push(`  … ${samples.length - 12} earlier sample(s)`);
	return truncateText(lines.join("\n"));
}

export function formatNetworkSummary(result: Record<string, unknown>): string {
	const counts = (result.counts ?? {}) as Record<string, unknown>;
	const lines = [`Network summary: ${Number(counts.total) || 0} request(s), ${Number(counts.failed) || 0} failed, ${Number(counts.cacheHit) || 0} cache hit`];
	const status = (result.statusDistribution ?? {}) as Record<string, unknown>;
	const statusKeys = Object.keys(status);
	if (statusKeys.length) lines.push(`Status: ${statusKeys.map((k) => `${k}=${status[k]}`).join(", ")}`);
	const slowest = Array.isArray(result.slowest) ? (result.slowest as Array<Record<string, unknown>>) : [];
	if (slowest.length) {
		lines.push("Slowest:");
		for (const s of slowest) lines.push(`  ${Number(s.durationMs) || 0}ms ${String(s.method ?? "GET")} ${compactLine(s.url, 90)} (${String(s.status ?? "")})`);
	}
	const byType = (result.bytesByType ?? {}) as Record<string, unknown>;
	const typeKeys = Object.keys(byType);
	if (typeKeys.length) lines.push(`Bytes by mime: ${typeKeys.map((k) => `${k}=${formatBytes(Number(byType[k]) || 0)}`).join(", ")}`);
	return truncateText(lines.join("\n"));
}

export function formatEventListeners(result: Record<string, unknown>): string {
	const listeners = Array.isArray(result.listeners) ? (result.listeners as Array<Record<string, unknown>>) : [];
	const node = result.node as Record<string, unknown> | undefined;
	const target = node && (node.uid || node.selector) ? ` for ${String(node.uid || node.selector)}` : "";
	const lines = [`Event listeners${target} (${listeners.length}):`];
	for (const l of listeners.slice(0, 40)) {
		const handler = (l.handler ?? {}) as Record<string, unknown>;
		const flags = [l.useCapture ? "capture" : null, l.passive ? "passive" : null, l.once ? "once" : null].filter(Boolean).join("+");
		lines.push(`  ${String(l.type ?? "?")}${flags ? ` (${flags})` : ""} → ${String(handler.functionName ?? "(anonymous)")}`);
	}
	if (listeners.length > 40) lines.push(`  … ${listeners.length - 40} more${result.truncated ? " (truncated)" : ""}`);
	return truncateText(lines.join("\n"));
}

// ---- P1A formatters (Debugger family + console/exceptions + network deep-dive) ----

export function formatBreakpointResult(result: Record<string, unknown>): string {
	const action = String(result.action ?? "");
	if (action === "list") {
		const bps = Array.isArray(result.breakpoints) ? (result.breakpoints as Array<Record<string, unknown>>) : [];
		const lines = [`Breakpoints (${bps.length}):`];
		for (const b of bps) lines.push(`  ${String(b.breakpointId ?? "?")} ${String(b.url ?? b.scriptId ?? "")}:${Number(b.lineNumber)}${b.condition ? ` if ${String(b.condition)}` : ""}`);
		const poe = result.pauseOnExceptions;
		if (poe) lines.push(`Pause on exceptions: ${String(poe)}`);
		return truncateText(lines.join("\n"));
	}
	const bp = result.breakpoint as Record<string, unknown> | undefined;
	if (action === "set" && bp) {
		return `Breakpoint set: ${String(bp.breakpointId ?? "")} at ${String(bp.url ?? bp.scriptId ?? "")}:${Number(bp.lineNumber)}${bp.condition ? ` if ${String(bp.condition)}` : ""} (${Number(result.count) || 0} active)`;
	}
	if (action === "remove") return `Breakpoint removed: ${String(result.removed ?? "")} (${Number(result.count) || 0} active)`;
	return safeJson(result);
}

export function formatPauseState(result: Record<string, unknown>): string {
	if (result.resumed !== undefined) {
		return result.resumed ? "Page resumed (debugger running)." : `Not paused: ${String(result.note ?? "page is not paused")}.`;
	}
	const frames = Array.isArray(result.callFrames) ? (result.callFrames as Array<Record<string, unknown>>) : [];
	if (!result.paused) return `Page is not paused.`;
	const lines = [`Page paused (${String(result.reason ?? "other")}${result.alreadyPaused ? ", already paused" : ""}). ${frames.length} frame(s):`];
	for (const f of frames.slice(0, 10)) lines.push(`  ${String(f.functionName ?? "(anonymous)")} at ${compactLine(f.url, 80)}:${Number(f.lineNumber)}`);
	if (frames.length > 10) lines.push(`  … ${frames.length - 10} more`);
	return truncateText(lines.join("\n"));
}

export function formatCallStack(result: Record<string, unknown>): string {
	const frames = Array.isArray(result.frames) ? (result.frames as Array<Record<string, unknown>>) : [];
	const lines = [`Call stack (${frames.length} frames, reason=${String(result.reason ?? "")}):`];
	for (const f of frames) {
		const head = `#${lines.length - 1} ${String(f.functionName ?? "(anonymous)")} ${compactLine(f.url, 80)}:${Number(f.lineNumber)}:${Number(f.columnNumber)}`;
		lines.push(head);
		const scopes = Array.isArray(f.scopes) ? (f.scopes as Array<Record<string, unknown>>) : [];
		for (const s of scopes.slice(0, 3)) {
			const props = Array.isArray(s.properties) ? (s.properties as Array<Record<string, unknown>>) : [];
			if (!props.length) continue;
			const rendered = props.slice(0, 8).map((p) => `${String(p.name)}=${compactLine(p.value ?? "", 40)}`).join(", ");
			lines.push(`    [${String(s.type ?? "")}] ${rendered}${s.overflow ? " …" : ""}`);
		}
	}
	return truncateText(lines.join("\n"));
}

export function formatJsExceptions(result: Record<string, unknown>): string {
	const list = Array.isArray(result.exceptions) ? (result.exceptions as Array<Record<string, unknown>>) : [];
	const lines = [`JS exceptions (${list.length}${result.cleared ? `, ${Number(result.cleared)} cleared` : ""}):`];
	for (const e of list.slice(0, 30)) {
		const loc = e.url ? ` ${compactLine(String(e.url), 70)}:${Number(e.lineNumber)}` : "";
		lines.push(`  ✗ ${String(e.text ?? "Error")}${loc}`);
		const top = Array.isArray(e.stackTrace) ? (e.stackTrace as Array<Record<string, unknown>>)[0] : null;
		if (top) lines.push(`      at ${String(top.functionName ?? "(anonymous)")} (${compactLine(String(top.url ?? ""), 70)}:${Number(top.lineNumber)})`);
	}
	if (list.length > 30) lines.push(`  … ${list.length - 30} more`);
	return truncateText(lines.join("\n"));
}

export function formatConsoleCapture(result: Record<string, unknown>): string {
	const entries = Array.isArray(result.entries) ? (result.entries as Array<Record<string, unknown>>) : [];
	const totals = (result.totals ?? {}) as Record<string, unknown>;
	const head = `Console capture ${result.enabled ? "ON" : "OFF"}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (${Number(totals.console) || 0} console, ${Number(totals.exceptions) || 0} exceptions, ${Number(totals.log) || 0} log)`;
	const lines = [head];
	for (const e of entries.slice(-25)) {
		const when = new Date(Number(e.timestamp) || 0).toISOString().slice(11, 23);
		if (e.family === "exception") {
			lines.push(`  [${when}] EXC ${compactLine(String(e.text ?? "Error"), 110)}`);
		} else if (e.family === "log") {
			lines.push(`  [${when}] ${String(e.level ?? "info").toUpperCase()} ${compactLine(String(e.text ?? ""), 110)}`);
		} else {
			const args = Array.isArray(e.args) ? (e.args as Array<Record<string, unknown>>).map((a) => compactLine(a.value ?? a.description ?? "", 60)).join(" ") : "";
			lines.push(`  [${when}] ${String(e.type ?? "log")} ${args}`);
		}
	}
	return truncateText(lines.join("\n"));
}

export function formatBrowserLog(result: Record<string, unknown>): string {
	const entries = Array.isArray(result.entries) ? (result.entries as Array<Record<string, unknown>>) : [];
	const lines = [`Browser log entries (${entries.length}${result.cleared ? `, ${Number(result.cleared)} cleared` : ""}):`];
	for (const e of entries.slice(-30)) {
		const loc = e.url ? ` ${compactLine(String(e.url), 70)}:${Number(e.lineNumber)}` : "";
		lines.push(`  [${String(e.source ?? "")}] ${String(e.level ?? "info").toUpperCase()} ${compactLine(String(e.text ?? ""), 120)}${loc}`);
	}
	return truncateText(lines.join("\n"));
}

export function formatNetworkCause(result: Record<string, unknown>): string {
	const failure = (result.failure ?? {}) as Record<string, unknown>;
	const lines = [`Request ${String(result.method ?? "GET")} ${compactLine(String(result.url ?? ""), 100)}`];
	lines.push(`  → status ${result.status ?? "(no response)"}${result.ambiguous ? " (ambiguous match)" : ""}`);
	if (failure.errorText || failure.blockedReason) {
		const cause: string[] = [];
		if (failure.blockedReason) cause.push(`blockedReason=${String(failure.blockedReason)}`);
		if (failure.errorText) cause.push(String(failure.errorText));
		if (failure.canceled) cause.push("canceled");
		lines.push(`  FAILED: ${cause.join(", ")}`);
	}
	const initiator = result.initiator as Record<string, unknown> | undefined;
	if (initiator) {
		const stack = Array.isArray(initiator.stack) ? (initiator.stack as Array<Record<string, unknown>>)[0] : null;
		if (stack) lines.push(`  initiator: ${String(stack.functionName ?? "(anonymous)")} ${compactLine(String(stack.url ?? ""), 70)}:${Number(stack.lineNumber)}`);
		else if (initiator.url) lines.push(`  initiator: ${compactLine(String(initiator.url), 90)}`);
	}
	const reqCookies = Array.isArray(result.blockedRequestCookies) ? result.blockedRequestCookies : [];
	const respCookies = Array.isArray(result.blockedCookies) ? result.blockedCookies : [];
	if (reqCookies.length || respCookies.length) lines.push(`  blocked cookies: ${reqCookies.length} request / ${respCookies.length} response`);
	const sec = result.securityDetails as Record<string, unknown> | null | undefined;
	if (sec) lines.push(`  TLS: ${compactLine(String(sec.subjectName ?? ""), 60)} → ${compactLine(String(sec.issuer ?? ""), 60)} (${String(sec.protocol ?? "")}/${String(sec.cipher ?? "")})`);
	const redirects = Array.isArray(result.redirects) ? (result.redirects as Array<Record<string, unknown>>) : [];
	if (redirects.length) lines.push(`  redirect chain: ${redirects.map((r) => `${String(r.status ?? "")} ${compactLine(String(r.url ?? ""), 60)}`).join(" → ")}`);
	return truncateText(lines.join("\n"));
}

export function formatNetworkHeaders(result: Record<string, unknown>): string {
	const summary = (result.summary ?? {}) as Record<string, unknown>;
	const names = Array.isArray(summary.names) ? (summary.names as string[]) : [];
	return result.clear
		? "Extra HTTP headers cleared."
		: `Injecting ${Number(summary.count) || 0} extra HTTP header(s): ${names.join(", ") || "(none)"}. Values are redacted.`;
}

export function formatInterceptStatus(result: Record<string, unknown>): string {
	if (result.resolved !== undefined) {
		return result.resolved
			? `Request ${String(result.requestId)} ${String(result.action)}d.`
			: `Could not resolve request ${String(result.requestId)}.`;
	}
	if (!result.enabled) return "Fetch interception disabled.";
	const patterns = Array.isArray(result.patterns) ? (result.patterns as string[]) : [];
	return `Fetch interception ON (${patterns.join(", ") || "*"}): ${Number(result.pausedCount) || 0} paused request(s), ${Number(result.resolvedCount) || 0} resolved. Paused requests auto-continue after 30s.`;
}

export function formatWebsocketFrames(result: Record<string, unknown>): string {
	const frames = Array.isArray(result.frames) ? (result.frames as Array<Record<string, unknown>>) : [];
	const lines = [`WebSocket frames (${frames.length} of ${Number(result.totalCaptured) || frames.length}${result.captureMode ? ", capture on" : ""}):`];
	for (const f of frames.slice(-30)) {
		const when = new Date(Number(f.timestamp) || 0).toISOString().slice(11, 23);
		let line = `  [${when}] ${String(f.direction ?? "")}`;
		if (f.direction === "sent" || f.direction === "received") {
			line += ` opcode=${f.opcode}${f.payloadPreview !== undefined ? ` payload=${compactLine(String(f.payloadPreview), 60)}${f.payloadTruncated ? "…" : ""}` : ""}`;
		} else if (f.direction === "created") {
			line += ` ${compactLine(String(f.url ?? ""), 80)}`;
		} else if (f.direction === "response") {
			line += ` ${compactLine(String(f.statusText ?? ""), 60)}`;
		}
		lines.push(line);
	}
	return truncateText(lines.join("\n"));
}

export function formatScriptSource(result: Record<string, unknown>): string {
	if (result.listed) {
		const scripts = Array.isArray(result.scripts) ? (result.scripts as Array<Record<string, unknown>>) : [];
		const lines = [`Scripts (${scripts.length}):`];
		for (const s of scripts.slice(0, 40)) lines.push(`  ${String(s.scriptId ?? "?")} ${compactLine(String(s.url ?? "(inline)"), 90)}`);
		if (scripts.length > 40) lines.push(`  … ${scripts.length - 40} more`);
		return truncateText(lines.join("\n"));
	}
	return truncateText(`Script ${String(result.scriptId ?? "")} ${compactLine(String(result.url ?? ""), 90)}${result.truncated ? " (truncated)" : ""}:\n${String(result.source ?? "")}`);
}

export function formatEvalFrameResult(result: Record<string, unknown>): string {
	if (result.ok === false) return `Evaluation failed: ${compactLine(String((result.exception as Record<string, unknown> | undefined)?.description ?? (result.exception as Record<string, unknown> | undefined)?.text ?? "error"), 200)}`;
	const r = result.result as Record<string, unknown> | undefined;
	return `→ ${compactLine(r?.value ?? r?.description ?? "(undefined)", 200)}`;
}

export function formatTargetList(result: Record<string, unknown>): string {
	const targets = Array.isArray(result.targets) ? (result.targets as Array<Record<string, unknown>>) : [];
	const lines = [`CDP targets (${targets.length}):`];
	for (const t of targets.slice(0, 60)) {
		lines.push(`  ${t.attached ? "●" : "○"} ${String(t.type ?? "?")}\t${String(t.title ?? "")}\t${String(t.url ?? "")}${t.attached ? " [attached]" : ""}`);
	}
	if (targets.length > 60) lines.push(`  … ${targets.length - 60} more`);
	return truncateText(lines.join("\n"));
}

export function formatBrowserInfo(result: Record<string, unknown>): string {
	const browser = result.browser as Record<string, unknown> | undefined;
	if (!browser) return `Browser info unavailable${result.degraded ? " (degraded — page-target attach)" : ""}`;
	const lines = [
		`Chrome ${String(browser.product ?? "")} (revision ${String(browser.revision ?? "")})`,
		`  protocol ${String(browser.protocolVersion ?? "")}  js ${String(browser.jsVersion ?? "")}`,
		`  UA: ${String(browser.userAgent ?? "")}`,
	];
	if (Array.isArray(result.commandLine)) lines.push(`  command line: ${(result.commandLine as string[]).join(" ")}`);
	if (result.degraded) lines.push("  (command-line fingerprint unavailable on a page-target attach)");
	return truncateText(lines.join("\n"));
}

export function formatMemoryCounters(result: Record<string, unknown>): string {
	const dom = result.domCounters as Record<string, unknown> | null | undefined;
	const heap = result.heap as Record<string, unknown> | null | undefined;
	const lines: string[] = [];
	if (dom) lines.push(`DOM counters: ${Number(dom.nodes) || 0} nodes, ${Number(dom.jsEventListeners) || 0} listeners, ${Number(dom.documents) || 0} documents`);
	if (heap) lines.push(`JS heap: ${formatBytes(Number(heap.usedSize) || 0)} used / ${formatBytes(Number(heap.totalSize) || 0)} total`);
	if (!dom && !heap) lines.push("Memory counters unavailable on this Chrome version");
	if (result.prepared) lines.push("Leak-detection preparation requested.");
	return truncateText(lines.join("\n"));
}

export function formatIndexedDbResult(result: Record<string, unknown>): string {
	const action = String(result.action ?? "get");
	const db = result.database ? ` db=${String(result.database)}` : "";
	const store = result.objectStore ? ` store=${String(result.objectStore)}` : "";
	const lines = [`IndexedDB ${action}${db}${store}${result.indexName ? ` (index ${String(result.indexName)})` : ""}.`];
	if (Array.isArray(result.databases)) lines.push(`• ${result.databases.length} database(s).`);
	if (Array.isArray(result.stores)) lines.push(`• ${result.stores.length} object store(s).`);
	if (typeof result.entryCount === "number") lines.push(`• ${result.entryCount} record(s).`);
	if (Array.isArray(result.entries)) {
		for (const e of (result.entries as Array<Record<string, unknown>>).slice(0, 12)) {
			lines.push(`  ${compactLine(e.key, 40)} → ${compactLine(e.value, 100)}`);
		}
		if (result.entries.length > 12) lines.push(`  … ${result.entries.length - 12} more`);
	}
	if (result.metadata && typeof result.metadata === "object") {
		const m = result.metadata as Record<string, unknown>;
		lines.push(`• metadata: ${String(m.entriesCount ?? 0)} entries, keyGeneratorValue=${m.keyGeneratorValue === null ? "null" : compactLine(m.keyGeneratorValue, 30)}`);
	}
	if (result.cleared === true) lines.push("• Store cleared.");
	if (result.deleted === true) lines.push("• Entries deleted.");
	return truncateText(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Tab list / tab formatters (host-side, pure)
// ---------------------------------------------------------------------------
// The bridge's `tab.list` action now returns BOTH the user's open tabs and the named-handle
// registry ({ tabs, handles }) so an agent can discover what the user actually has open. The
// formatter below is deliberately tolerant: it also accepts a bare tab array (older companion
// extension) or a { handles }-only registry, and never crashes on a shape mismatch
// (regression: "tabs.map is not a function").

export type ChromeTabRecord = {
	id?: number;
	windowId?: number;
	active?: boolean;
	highlighted?: boolean;
	title?: string;
	url?: string;
	status?: string;
	pinned?: boolean;
	incognito?: boolean;
	groupId?: number;
	group?: {
		id?: number;
		title?: string;
		color?: string;
		collapsed?: boolean;
		windowId?: number;
		piGroup?: boolean;
	} | null;
};

export type TabHandle = {
	name?: string;
	tabId?: number;
	windowId?: number;
	url?: string;
	title?: string;
	ownerSessionKey?: string;
	savedAt?: number;
};

export type TabListResult =
	| { tabs?: ChromeTabRecord[]; handles?: TabHandle[] }
	| ChromeTabRecord[];

// Renders action=list: one line per open tab (active marker, tabId, [group] title, url), then
// a "Named handles:" section when the registry is non-empty. Never empty while at least one
// open tab exists.
export function formatTabList(result: TabListResult): string {
	const object = !Array.isArray(result) && result !== null && typeof result === "object" ? result : undefined;
	const tabs = Array.isArray(result)
		? (result as ChromeTabRecord[])
		: Array.isArray(object?.tabs)
			? (object.tabs as ChromeTabRecord[])
			: [];
	const handles = object !== undefined && Array.isArray(object.handles) ? (object.handles as TabHandle[]) : [];
	const lines: string[] = [];
	for (const tab of tabs) {
		const groupPrefix = tab.group?.title ? `[${tab.group.title}] ` : "";
		lines.push(`${tab.active ? "*" : " "}\t${tab.id ?? ""}\t${groupPrefix}${tab.title || "(untitled)"}\t${tab.url || ""}`);
	}
	if (handles.length > 0) {
		lines.push("Named handles:");
		for (const handle of handles) {
			lines.push(`  ${handle.name ?? "(unnamed)"}\t${handle.tabId ?? ""}\t${handle.title || "(untitled)"}\t${handle.url || ""}`);
		}
	}
	return lines.join("\n") || "No named handles saved.";
}

// Renders a single tab record — the wire shape returned by the bridge for tab.active,
// tab.activate, tab.new, tab.ungroup, navigate, screenshots, etc.
export function formatTab(tab: ChromeTabRecord | null | undefined): string {
	if (tab === undefined) return "undefined";
	if (tab === null) return "null";
	if (typeof tab !== "object") return safeJson(tab);
	const lines: string[] = [`# Chrome tab${typeof tab.id === "number" ? ` ${tab.id}` : ""}`];
	lines.push(`${tab.title || "(untitled)"}`);
	if (tab.url) lines.push(`${tab.url}`);
	const state: string[] = [];
	if (tab.active) state.push("active");
	if (tab.pinned) state.push("pinned");
	if (tab.incognito) state.push("incognito");
	if (state.length) lines.push(`state: ${state.join(", ")}`);
	if (typeof tab.windowId === "number") lines.push(`windowId: ${tab.windowId}`);
	if (typeof tab.groupId === "number" && tab.groupId >= 0) {
		lines.push(`group: ${tab.group?.title || tab.groupId}`);
	}
	return truncateText(lines.join("\n"));
}

// Blank-automation-tab hint: when the companion service worker resolved the action to THIS
// session's dedicated automation tab and that tab is blank (about:blank / chrome://newtab /
// ''), it flags the result with `_blankAutomationTab: true`. The host appends this hint so an
// agent that snapshotted an empty page is told how to find the user's real tabs instead.
export const BLANK_AUTOMATION_TAB_HINT =
	"  (note: this is pi-chrome's dedicated automation tab, currently blank. Run chrome_tab list to see your open tabs, or pass targetId/urlIncludes/titleIncludes to target a specific tab.)";

export function appendBlankAutomationHint(text: string, raw: unknown): string {
	const flagged = raw !== null && typeof raw === "object" && (raw as { _blankAutomationTab?: unknown })._blankAutomationTab === true;
	return flagged ? `${text}\n${BLANK_AUTOMATION_TAB_HINT}` : text;
}

// ---------------------------------------------------------------------------
// chrome_diff digest comparison (S3.1; host-side pure function, no bridge call)
// ---------------------------------------------------------------------------
// The digest shape mirrors `digestFor()` in snapshot_injected.js.

export type DigestLabel = {
	uid: string;
	role?: string;
	label?: string;
	disabled?: boolean;
	value?: string;
	checked?: boolean;
};

export type SnapshotDigest = {
	url?: string;
	title?: string;
	textHash?: string;
	focusedUid?: string | null;
	modalUid?: string | null;
	labels?: DigestLabel[];
};

function digestChanged(before: string | null | undefined, after: string | null | undefined): boolean {
	return (before ?? "") !== (after ?? "");
}

function digestLabelFieldChanges(a: DigestLabel, b: DigestLabel): string[] {
	const changes: string[] = [];
	for (const field of ["role", "label", "disabled", "value", "checked"] as const) {
		if (a[field] !== b[field]) changes.push(field);
	}
	return changes;
}

export function diffDigests(before: SnapshotDigest, after: SnapshotDigest): { lines: string[]; diff: Record<string, unknown> } {
	const lines: string[] = [];
	const diff: Record<string, unknown> = {};
	if (digestChanged(before.url, after.url)) {
		lines.push(`URL changed: ${before.url ?? ""} -> ${after.url ?? ""}`);
		diff.url = { before: before.url ?? "", after: after.url ?? "" };
	}
	if (digestChanged(before.title, after.title)) {
		lines.push(`Title changed: ${before.title ?? ""} -> ${after.title ?? ""}`);
		diff.title = { before: before.title ?? "", after: after.title ?? "" };
	}
	if (digestChanged(before.textHash, after.textHash)) {
		lines.push("Text content changed");
		diff.textHash = { before: before.textHash ?? "", after: after.textHash ?? "" };
	}
	if (digestChanged(before.focusedUid, after.focusedUid)) {
		lines.push(`Focused element changed: ${before.focusedUid ?? "none"} -> ${after.focusedUid ?? "none"}`);
		diff.focusedUid = { before: before.focusedUid ?? null, after: after.focusedUid ?? null };
	}
	if (digestChanged(before.modalUid, after.modalUid)) {
		lines.push(`Modal changed: ${before.modalUid ?? "none"} -> ${after.modalUid ?? "none"}`);
		diff.modalUid = { before: before.modalUid ?? null, after: after.modalUid ?? null };
	}

	const beforeLabels = new Map((before.labels ?? []).map((label) => [label.uid, label]));
	const afterLabels = new Map((after.labels ?? []).map((label) => [label.uid, label]));
	const added: DigestLabel[] = [];
	const removed: DigestLabel[] = [];
	const updated: Array<{ before: DigestLabel; after: DigestLabel; fields: string[] }> = [];
	for (const label of after.labels ?? []) {
		if (!beforeLabels.has(label.uid)) added.push(label);
		else {
			const previous = beforeLabels.get(label.uid) as DigestLabel;
			const fields = digestLabelFieldChanges(previous, label);
			if (fields.length > 0) updated.push({ before: previous, after: label, fields });
		}
	}
	for (const label of before.labels ?? []) {
		if (!afterLabels.has(label.uid)) removed.push(label);
	}
	for (const label of added) lines.push(`+ ${label.role ?? "element"} "${label.label ?? ""}" (${label.uid})`);
	for (const label of removed) lines.push(`- ${label.role ?? "element"} "${label.label ?? ""}" (${label.uid})`);
	for (const entry of updated) lines.push(`~ ${entry.after.role ?? "element"} "${entry.after.label ?? ""}" (${entry.after.uid})`);

	if (lines.length === 0) lines.push("No changes detected between the two snapshots.");
	diff.added = added;
	diff.removed = removed;
	diff.updated = updated.map((entry) => ({ before: entry.before, after: entry.after, fields: entry.fields }));
	return { lines, diff };
}

// ---------------------------------------------------------------------------
// Auth-state transitions (authorize -> active, expiry -> locked, revoke clears)
// ---------------------------------------------------------------------------

export type AuthUntil = number | "indefinite" | undefined;

export class AuthState {
	until: AuthUntil;
	sessionKey: string | undefined;

	constructor(until: AuthUntil = undefined, sessionKey?: string) {
		this.until = until;
		this.sessionKey = sessionKey;
	}

	isActive(now: number): boolean {
		return this.until === "indefinite" || (typeof this.until === "number" && this.until > now);
	}

	authorize(until: Exclude<AuthUntil, undefined>, sessionKey?: string): void {
		this.until = until;
		this.sessionKey = sessionKey;
	}

	revoke(): void {
		this.until = undefined;
		this.sessionKey = undefined;
	}

	// Returns true when a grant WAS set but has since expired — the caller locks control.
	checkExpiry(now: number): boolean {
		if (this.isActive(now)) return false;
		if (this.until !== undefined) {
			this.until = undefined;
			this.sessionKey = undefined;
			return true;
		}
		return false;
	}

	// Stale-session guard: a grant persisted on globalThis is scoped to the session that
	// created it. A DIFFERENT session starting (anything but a same-session /reload) must
	// not inherit it. Returns true when the stale grant was dropped.
	rejectStaleSession(newSessionKey: string | undefined, reason?: string): boolean {
		if (this.sessionKey === undefined || this.sessionKey === newSessionKey || reason === "reload") return false;
		this.until = undefined;
		this.sessionKey = undefined;
		return true;
	}
}

// ---------------------------------------------------------------------------
// Exactly-once bridge protocol state machine
// ---------------------------------------------------------------------------

export const ORPHAN_NOTE =
	"delivered and acknowledged but never returned a result - the action MAY have executed. Verify state before repeating.";

export type PollOutcome =
	| { type: "orphan"; orphan: OrphanedCommand & { note: string } }
	| { type: "command"; claim: CommandClaim }
	| { type: "none" };

// A command claimed by one /next poll. Exactly one handler owns it: either the poll
// response flushes (markFlushed) or the poll connection dies before flush (requeue).
// Both paths are idempotent — the command can never be lost to the TOCTOU gap and can
// never be double-served after the client saw it (lost-command-toctou).
export class CommandClaim {
	readonly command: BridgeCommand;
	private settled = false;

	constructor(command: BridgeCommand) {
		this.command = command;
	}

	get isSettled(): boolean {
		return this.settled;
	}

	// The /next response was handed to the kernel — the extension saw the payload.
	// deliveredAt is set only here, so a payload that died in the socket is never
	// reported as delivered.
	markFlushed(protocol: BridgeProtocol, at: number): void {
		if (this.settled) return;
		protocol.markDelivered(this.command.id, at);
		this.settled = true;
	}

	// The poll connection died before flush — requeue the claimed command exactly once so
	// the next live /next serves it. If the extension DID receive it, its journal dedupes
	// the re-served copy (idempotent by id).
	requeue(protocol: BridgeProtocol): void {
		if (this.settled) return;
		protocol.requeue(this.command);
		this.settled = true;
	}
}

export class BridgeProtocol {
	pending = new Map<string, PendingEntry>();
	queue: BridgeCommand[] = [];
	orphaned: OrphanedCommand[] = [];
	waiters: Array<(command: BridgeCommand | undefined) => void> = [];
	// Extension liveness signals, keyed by the session key the SW sends. Pruned aggressively
	// so it cannot grow unbounded (S5.1).
	heartbeats = new Map<string, number>();

	// Host registers a command with its settle callbacks and timer, then enqueues it.
	track(
		command: BridgeCommand,
		resolve: (value: unknown) => void,
		reject: (error: Error) => void,
		timer: ReturnType<typeof setTimeout>,
	): PendingEntry {
		const entry: PendingEntry = { command, state: "pending", resolve, reject, timer };
		this.pending.set(command.id, entry);
		return entry;
	}

	// Deliver to a waiting /next long-poll if any, else append to the queue.
	enqueue(command: BridgeCommand): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter(command);
		else this.queue.push(command);
	}

	addWaiter(waiter: (command: BridgeCommand | undefined) => void): void {
		this.waiters.push(waiter);
	}

	removeWaiter(waiter: (command: BridgeCommand | undefined) => void): void {
		this.waiters = this.waiters.filter((entry) => entry !== waiter);
	}

	// /next poll: serve ONE orphan notice before any command — an acked-but-resultless
	// command may have executed, so surface it to the extension (which logs it and keeps
	// polling). The command itself is never re-served (S1.2).
	poll(): PollOutcome {
		if (this.orphaned.length > 0) {
			const orphan = this.orphaned.shift() as OrphanedCommand;
			return { type: "orphan", orphan: { ...orphan, note: ORPHAN_NOTE } };
		}
		const command = this.claimNext();
		return command !== undefined ? { type: "command", claim: new CommandClaim(command) } : { type: "none" };
	}

	// Serve ONLY commands still in "pending" state — a requeued command that has since been
	// acked ("received") must never be re-served (S1.2).
	claimNext(): BridgeCommand | undefined {
		const index = this.queue.findIndex((queued) => {
			const entry = this.pending.get(queued.id);
			return entry === undefined || entry.state === "pending";
		});
		if (index < 0) return undefined;
		return this.queue.splice(index, 1)[0];
	}

	claim(command: BridgeCommand): CommandClaim {
		return new CommandClaim(command);
	}

	requeue(command: BridgeCommand): void {
		this.queue.unshift(command);
	}

	markDelivered(id: string, at: number): void {
		const entry = this.pending.get(id);
		if (entry) entry.deliveredAt = at;
	}

	// POST /ack — idempotent by design (S1.3): an unknown id or a duplicate ack is a no-op
	// success. Returns true only when the entry actually transitioned pending -> received.
	ack(id: string, at: number): boolean {
		const entry = this.pending.get(id);
		if (entry && entry.state === "pending") {
			entry.state = "received";
			entry.ackedAt = at;
			return true;
		}
		return false;
	}

	// POST /result — settles the pending entry (clears its timer, marks completed) and hands
	// it back so the host can resolve/reject the promise. Unknown/late ids are accepted:false
	// (NOT a 404): a late result after timeout/owner-switch is acked silently so the SW never
	// retries it (S1.3).
	settle(id: string): { accepted: true; entry: PendingEntry } | { accepted: false } {
		const entry = this.pending.get(id);
		if (!entry) return { accepted: false };
		clearTimeout(entry.timer);
		entry.state = "completed";
		this.pending.delete(id);
		return { accepted: true, entry };
	}

	// Host timeout timer OR user abort signal: drop the entry, drop any queued copy, and —
	// when the command was acked but never resolved — push an orphan notice so the next
	// /next surfaces the may-have-executed warning instead of dropping it silently (S1.2,
	// orphan-abort).
	drop(id: string): { entry?: PendingEntry } {
		const entry = this.pending.get(id);
		this.pending.delete(id);
		this.queue = this.queue.filter((queued) => queued.id !== id);
		if (entry && entry.state === "received" && entry.ackedAt !== undefined) {
			this.orphaned.push({ id, action: entry.command.action, ackedAt: entry.ackedAt });
		}
		return entry !== undefined ? { entry } : {};
	}

	// POST /heartbeat (S5.1): the SW posts {sessionKey} every 30s; track liveness.
	heartbeat(sessionKey: string, at: number): void {
		this.heartbeats.set(sessionKey, at);
	}

	pruneHeartbeats(now: number, ttlMs = 2 * 60_000): void {
		const cutoff = now - ttlMs;
		for (const [key, at] of this.heartbeats) if (at < cutoff) this.heartbeats.delete(key);
	}

	newestHeartbeatAt(now: number): number | undefined {
		let newest = -Infinity;
		for (const at of this.heartbeats.values()) if (at > newest) newest = at;
		if (newest === -Infinity) return undefined;
		this.pruneHeartbeats(now);
		return Math.max(0, now - newest);
	}

	stop(): void {
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error("Chrome profile bridge stopped"));
		}
		this.pending.clear();
		this.queue = [];
		this.orphaned = [];
		for (const waiter of this.waiters) waiter(undefined);
		this.waiters = [];
	}
}

// ---------------------------------------------------------------------------
// Executed-command journal eviction policy (journal-quota)
// ---------------------------------------------------------------------------
// The companion service worker owns the real executed-command journal (exactly-once dedupe
// against the SW's executed-command journal semantics in service_worker.js: loadJournal /
// sweepJournal). This class is the host-side pure reference implementation of that policy:
// compact digests only (never full results), TTL + entry cap + total-byte budget, oldest
// first eviction. It is deliberately dependency-free so the policy is unit-tested here and
// can be adopted by the worker without re-deriving the semantics.

export const JOURNAL_MAX_ENTRIES = 200;
export const JOURNAL_TTL_MS = 10 * 60_000; // 10 minutes
export const JOURNAL_MAX_BYTES = 256 * 1024; // 256KB

export type JournalEntry = {
	id: string;
	action: string;
	ok: boolean;
	// Compact fingerprint of the result — never the result itself.
	resultHash?: string;
	error?: string;
	completedAt: number;
	aborted?: boolean;
};

function journalEntryBytes(entry: JournalEntry): number {
	try { return JSON.stringify(entry).length; } catch { return 128; }
}

export class BridgeJournal {
	private readonly entries = new Map<string, JournalEntry>();
	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private readonly ttlMs: number;

	constructor(maxEntries = JOURNAL_MAX_ENTRIES, maxBytes = JOURNAL_MAX_BYTES, ttlMs = JOURNAL_TTL_MS) {
		this.maxEntries = maxEntries;
		this.maxBytes = maxBytes;
		this.ttlMs = ttlMs;
	}

	get size(): number {
		return this.entries.size;
	}

	get ids(): string[] {
		return [...this.entries.keys()];
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	get(id: string): JournalEntry | undefined {
		return this.entries.get(id);
	}

	delete(id: string): void {
		this.entries.delete(id);
	}

	clear(): void {
		this.entries.clear();
	}

	record(entry: JournalEntry): void {
		this.entries.set(entry.id, entry);
		this.sweep(entry.completedAt);
	}

	// Total serialized-bytes estimate of the journal map (entry values AND their id keys),
	// mirroring the service worker's accounting so the persisted journal cannot exceed the
	// budget regardless of id length.
	byteCount(): number {
		let bytes = 2;
		for (const [id, entry] of this.entries) bytes += journalEntryBytes(entry) + id.length + 4;
		return bytes;
	}

	// Drop entries older than the TTL, cap by entry count AND by total serialized bytes —
	// oldest first (by completedAt; missing timestamps sort as 0 and drop first).
	sweep(now: number): void {
		const ttlBoundary = now - this.ttlMs;
		for (const [id, entry] of this.entries) {
			if (!entry || typeof entry.completedAt !== "number" || entry.completedAt < ttlBoundary) this.entries.delete(id);
		}
		const oldestFirst = () =>
			[...this.entries.keys()].sort(
				(a, b) => (this.entries.get(a)?.completedAt ?? 0) - (this.entries.get(b)?.completedAt ?? 0),
			);
		let ids = oldestFirst();
		while (ids.length > this.maxEntries) {
			const oldest = ids.shift() as string;
			this.entries.delete(oldest);
		}
		ids = oldestFirst();
		let bytes = 2;
		for (const id of ids) bytes += journalEntryBytes(this.entries.get(id) as JournalEntry) + id.length + 4;
		while (bytes > this.maxBytes && ids.length) {
			const oldest = ids.shift() as string;
			bytes -= journalEntryBytes(this.entries.get(oldest) as JournalEntry) + oldest.length + 4;
			this.entries.delete(oldest);
		}
	}
}
