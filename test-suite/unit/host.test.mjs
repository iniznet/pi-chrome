// Unit harness for the host-side PURE helpers extracted from index.ts into
// extensions/chrome-profile-bridge/commands.ts (test-host):
//   - diffDigests: added / removed / updated / empty + top-level field changes
//   - formatChromeSnapshot truncation (MAX_TEXT_CHARS output cap, MAX_ELEMENTS overflow hint)
//   - history ring trim (CHROME_HISTORY_CAP) + HISTORY_PARAMS_SKIP / storage-op redaction
//   - AuthState transitions: authorize -> active, expiry -> locked, revoke clears, stale-session
//     inheritance is refused
//
// Like bridge-protocol.test.mjs we load the real shipped commands.ts via node's own type
// stripping, so these tests exercise the exact code index.ts imports.

import { stripTypeScriptTypes } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/commands.ts");
const src = fs.readFileSync(commandsPath, "utf8");
const js = stripTypeScriptTypes(src, { mode: "strip" });
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const {
  AuthState,
  CHROME_HISTORY_CAP,
  HISTORY_PARAMS_SKIP,
  MAX_ELEMENTS,
  MAX_TEXT_CHARS,
  diffDigests,
  formatChromeSnapshot,
  recordHistory,
  safeJson,
  summarizeParams,
  truncateText,
} = mod;

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; }
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// A representative element label helper: builds an interactive-mode snapshot with `n` elements.
function interactiveSnapshot(n, { label = "Save changes", rect = { x: 0, y: 0, width: 100, height: 20 } } = {}) {
  return {
    mode: "interactive",
    title: "Page title",
    url: "https://example.test/form",
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0 },
    summary: { modal: null, focused: { uid: "el-1", role: "button", label: "Save changes" }, hints: [] },
    elements: Array.from({ length: n }, (_, i) => ({
      uid: `el-${i + 1}`,
      role: "button",
      label,
      rect: { ...rect, y: i * 24 },
    })),
  };
}

function run() {
  // ===== diffDigests: empty / added / removed / updated / top-level fields. =====
  {
    // Empty — identical snapshots.
    const before = {
      url: "https://a.test/",
      title: "A",
      textHash: "h1",
      focusedUid: "el-1",
      modalUid: null,
      labels: [{ uid: "el-1", role: "button", label: "Save", value: "x" }],
    };
    const same = diffDigests(before, structuredClone(before));
    ok(same.lines.length === 1 && same.lines[0] === "No changes detected between the two snapshots.", "diff: identical digests report no changes");
    ok(Array.isArray(same.diff.added) && same.diff.added.length === 0, "diff: added list empty");
    ok(Array.isArray(same.diff.removed) && same.diff.removed.length === 0, "diff: removed list empty");
    ok(Array.isArray(same.diff.updated) && same.diff.updated.length === 0, "diff: updated list empty");
    ok(same.diff.url === undefined && same.diff.title === undefined && same.diff.textHash === undefined, "diff: no top-level diffs");

    // Added — a label that exists only after.
    const added = diffDigests({ labels: [] }, { labels: [{ uid: "el-9", role: "button", label: "Add row" }] });
    ok(added.diff.added.length === 1 && added.diff.added[0].uid === "el-9", "diff: added label detected");
    ok(added.lines.includes('+ button "Add row" (el-9)'), "diff: added rendered as + line");

    // Removed — a label that existed only before.
    const removed = diffDigests({ labels: [{ uid: "el-2", role: "link", label: "Legacy link" }] }, { labels: [] });
    ok(removed.diff.removed.length === 1 && removed.diff.removed[0].uid === "el-2", "diff: removed label detected");
    ok(removed.lines.includes('- link "Legacy link" (el-2)'), "diff: removed rendered as - line");

    // Updated — same uid, changed fields (label/value/disabled/checked all tracked).
    const updated = diffDigests(
      { labels: [{ uid: "el-5", role: "checkbox", label: "Subscribe", checked: false, disabled: false, value: "off" }] },
      { labels: [{ uid: "el-5", role: "checkbox", label: "Subscribe now", checked: true, disabled: true, value: "on" }] },
    );
    ok(updated.diff.updated.length === 1, "diff: updated label detected");
    const fields = updated.diff.updated[0].fields;
    ok(["label", "checked", "disabled", "value"].every((f) => fields.includes(f)), `diff: all changed fields tracked (${fields.join(",")})`);
    ok(updated.lines.some((line) => line.startsWith("~ checkbox") && line.includes("el-5")), "diff: updated rendered as ~ line");

    // Top-level field changes (url / title / textHash / focusedUid / modalUid).
    const top = diffDigests(
      { url: "https://a.test/", title: "A", textHash: "h1", focusedUid: "el-1", modalUid: null },
      { url: "https://b.test/", title: "B", textHash: "h2", focusedUid: null, modalUid: "el-9" },
    );
    ok(top.diff.url.before === "https://a.test/" && top.diff.url.after === "https://b.test/", "diff: url change captured");
    ok(top.diff.title.before === "A" && top.diff.title.after === "B", "diff: title change captured");
    ok(top.diff.textHash.before === "h1" && top.diff.textHash.after === "h2", "diff: textHash change captured");
    ok(top.diff.focusedUid.before === "el-1" && top.diff.focusedUid.after === null, "diff: focusedUid change captured");
    ok(top.diff.modalUid.before === null && top.diff.modalUid.after === "el-9", "diff: modalUid change captured");
    ok(top.lines.some((l) => l.includes("URL changed")), "diff: url change rendered");

    // Role change on the same uid is an update too.
    const roleChanged = diffDigests(
      { labels: [{ uid: "el-7", role: "button", label: "Go" }] },
      { labels: [{ uid: "el-7", role: "link", label: "Go" }] },
    );
    ok(roleChanged.diff.updated.length === 1 && roleChanged.diff.updated[0].fields.includes("role"), "diff: role change tracked");
  }

  // ===== formatChromeSnapshot: MAX_TEXT_CHARS output cap + MAX_ELEMENTS overflow hint. =====
  {
    // Element labels are compacted (140 chars) so an interactive snapshot stays small; the
    // truncation path is exercised by full mode, which renders the RAW JSON and hits the cap.
    const big = {
      mode: "full",
      title: "Big page",
      url: "https://big.test/",
      elements: Array.from({ length: 300 }, (_, i) => ({
        uid: `el-${i}`,
        role: "button",
        label: `label-${i}-` + "y".repeat(180),
        rect: { x: 0, y: i, width: 100, height: 20 },
      })),
    };
    const untruncated = safeJson(big);
    ok(untruncated.length > MAX_TEXT_CHARS, "format: fixture JSON exceeds the 30000-char budget");
    const text = formatChromeSnapshot(big);
    ok(text.includes("[truncated "), "format: output exceeds MAX_TEXT_CHARS and is flagged truncated");
    ok(text.startsWith(untruncated.slice(0, MAX_TEXT_CHARS)), "format: the first MAX_TEXT_CHARS characters are preserved verbatim");
    ok(text === truncateText(untruncated, MAX_TEXT_CHARS), "format: truncation matches truncateText semantics exactly");
    ok(text.endsWith("characters]"), "format: total length accounts for the truncation marker");
    ok(!text.includes('"uid": "el-299"'), "format: characters beyond the cap never appear");

    // Small output stays untruncated.
    const small = formatChromeSnapshot(interactiveSnapshot(2));
    ok(!small.includes("[truncated"), "format: small snapshots are not truncated");
    ok(small.includes("# Chrome snapshot (interactive)") && small.includes("Page title"), "format: header + title rendered");
    ok(small.includes("viewport=1280x800 scroll=0,0"), "format: viewport line rendered");
    ok(small.includes("focused: el-1 button Save changes"), "format: focused summary rendered");

    // MAX_ELEMENTS overflow hint: more than the per-mode cap shows an N-more line.
    const overflow = formatChromeSnapshot(interactiveSnapshot(70, { label: "Go" }));
    ok(overflow.includes("## Visible actions"), "format: visible actions section rendered");
    ok(overflow.includes("… 10 more; retry with maxElements or mode=interactive"), `format: interactive cap hint for 70 elements (60 shown, 10 more)`);

    const autoOverflow = formatChromeSnapshot({ ...interactiveSnapshot(30), mode: "auto" });
    ok(autoOverflow.includes("… 5 more; retry with maxElements or mode=interactive"), "format: auto mode caps at 25 and reports the remainder");

    // MAX_ELEMENTS (80) is the schema-level default; the renderer's per-mode slice caps live here.
    ok(MAX_ELEMENTS === 80, "format: MAX_ELEMENTS constant is 80 (tool schema default)");
    ok(MAX_TEXT_CHARS === 30_000, "format: MAX_TEXT_CHARS constant is 30000 (truncation budget)");
  }

  // ===== History ring: trim to CHROME_HISTORY_CAP, oldest dropped; params redaction. =====
  {
    const history = [];
    const startedAt = Date.now() - 100;
    for (let i = 0; i < CHROME_HISTORY_CAP + 1; i++) {
      recordHistory(history, { action: "page.click", paramsSummary: `click ${i}`, ok: true, params: { uid: `el-${i}` } }, startedAt);
    }
    ok(history.length === CHROME_HISTORY_CAP, "history: ring trims to CHROME_HISTORY_CAP entries");
    ok(history[0].paramsSummary === "click 1", "history: the OLDEST entry was dropped (click 0 gone)");
    ok(history[history.length - 1].paramsSummary === "click 200", "history: the newest entry is retained");
    ok(history.every((entry) => typeof entry.at === "number" && entry.durationMs === 100), "history: at + durationMs stamped on every entry");

    // HISTORY_PARAMS_SKIP: wire-only params never render in the summary.
    const summary = summarizeParams({
      uid: "el-1",
      text: "hello world",
      sessionKey: "session:secret-key",
      groupTitle: "Pi Session: x",
      sessionGroupTitle: "Pi Session: x",
      joinSessionGroup: true,
      foreground: false,
      maxElements: 80,
    });
    ok(summary.includes('uid="el-1"'), "redact: non-skip params render");
    ok(summary.includes('text="hello world"'), "redact: string values are quoted");
    ok(summary.includes("maxElements=80"), "redact: numeric values render raw");
    ok(!summary.includes("sessionKey") && !summary.includes("session:secret-key"), "redact: sessionKey is skipped");
    ok(!summary.includes("groupTitle") && !summary.includes("joinSessionGroup") && !summary.includes("foreground"), "redact: group/foreground wire params are skipped");

    // storage.op values are secrets: the value key is redacted entirely.
    const storage = summarizeParams({ kind: "cookies", action: "set", name: "sid", value: "super-secret-token" }, "storage.op");
    ok(storage.includes("value=[redacted]"), "redact: storage.op value key renders as [redacted]");
    ok(!storage.includes("super-secret-token"), "redact: the stored secret never appears in the summary");

    // Long strings are compacted to the 40-char window.
    const longText = "a".repeat(60);
    const compacted = summarizeParams({ text: longText });
    ok(!compacted.includes(longText), "redact: long string values are compacted");
    ok(/text="a{39}…"/.test(compacted), "redact: compaction keeps 39 chars + ellipsis inside quotes");

    // Objects render as (clipped) JSON; empty params fall back to a placeholder.
    ok(summarizeParams({ opts: { mode: "auto" } }).includes("opts={\n  \"mode\": \"auto\""), "redact: object params render as JSON");
    ok(summarizeParams({}) === "(no params)", "redact: empty params summary");
    ok(summarizeParams({ a: undefined }) === "(no params)", "redact: undefined values are skipped");
  }

  // ===== AuthState: authorize -> active, expiry -> locked, revoke clears, stale session refused. =====
  {
    const NOW = 10_000;
    const state = new AuthState();
    ok(state.isActive(NOW) === false, "auth: fresh state is locked");
    ok(state.checkExpiry(NOW) === false, "auth: no grant means no expiry transition");

    // authorize -> active.
    state.authorize(NOW + 30_000, "session:A");
    ok(state.isActive(NOW) === true, "auth: authorized grant is active");
    ok(state.until === NOW + 30_000, "auth: grant deadline stored");
    ok(state.sessionKey === "session:A", "auth: grant remembers its session");

    // expiry -> locked exactly once.
    ok(state.checkExpiry(NOW + 30_001) === true, "auth: expiry transition fires when the deadline passes");
    ok(state.isActive(NOW + 30_001) === false, "auth: after expiry the grant is locked");
    ok(state.until === undefined && state.sessionKey === undefined, "auth: expiry clears deadline + session");
    ok(state.checkExpiry(NOW + 30_001) === false, "auth: expiry is not reported twice");

    // revoke clears.
    state.authorize("indefinite", "session:A");
    ok(state.isActive(NOW) === true, "auth: indefinite grant is active at any time");
    ok(state.checkExpiry(NOW + 1_000_000) === false, "auth: indefinite grants never expire");
    state.revoke();
    ok(state.isActive(NOW) === false && state.until === undefined && state.sessionKey === undefined, "auth: revoke clears the grant");

    // Stale-session inheritance is refused (S5.2): same session / reload keep the grant; a
    // DIFFERENT session (non-reload) drops it.
    const stale = new AuthState(NOW + 60_000, "session:A");
    ok(stale.rejectStaleSession("session:A", undefined) === false, "auth: same-session start keeps the grant");
    ok(stale.rejectStaleSession("session:B", "reload") === false, "auth: same-session /reload keeps the grant");
    ok(stale.rejectStaleSession("session:B", "session_end") === true, "auth: different-session start drops the stale grant");
    ok(stale.until === undefined && stale.sessionKey === undefined, "auth: dropped grant is fully cleared");
    ok(stale.isActive(NOW) === false, "auth: dropped grant is locked");
    ok(stale.rejectStaleSession("session:C", undefined) === false, "auth: already-dropped grant is a no-op");

    // Restore path (a grant that survived /reload): constructor accepts the persisted shape.
    const restored = new AuthState(NOW + 5_000, "session:A");
    ok(restored.isActive(NOW) === true && restored.sessionKey === "session:A", "auth: persisted grant restores active");
    const expiredPersisted = new AuthState(NOW - 1, "session:A");
    ok(expiredPersisted.isActive(NOW) === false, "auth: an already-expired persisted grant stays locked");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run();
