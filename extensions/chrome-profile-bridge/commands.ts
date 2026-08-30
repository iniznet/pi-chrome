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
