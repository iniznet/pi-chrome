// P2-batch harness (test-p2): dom.snapshot/css.audit/a11y.audit + tracing/heap/recording +
// background-service/storage-watch + event/dom breakpoints + ime/virtual-time/device-matrix/
// mhtml/tls.
//
// Pins the P2 tool surface of tasks/impl/TOOL_CONTRACTS.md §7 rows 60-75 against the REAL
// shipped sources (source-level for index.ts, vm-load for service_worker.js, type-stripped
// import for commands.ts). The task's four focus areas are asserted as dedicated sections:
//   (5) file-export caps/truncation — host writer pattern (.pi/<subdir>/ + mkdir + writeFile),
//       the 8MB/1MB/5min bridge caps, SW-side base64/JSON caps with truncated/tooLarge markers,
//       summaryOnly-first for heap
//   (6) keepalive membership — keepaliveModes.tracing / heapRecording / sessionRecord descriptors
//       (TOOL_CONTRACTS §3.2) hold the attach while recording, persist their intent, re-apply on
//       re-attach, and are drained by cleanupModesForTab; a stop with no active recording is a
//       clear error, never a silent phantom (global constraint #1)
//   (7) budget-expired handling — Emulation.virtualTimeBudgetExpired resolves the advance
//       waiter; chrome_virtual_time never combines with printToPDF (contract row 72)
//   (8) chunk-write state — HeapProfiler.addHeapSnapshotChunk accumulation is per-tab, byte-
//       capped, and summaryOnly parses SW-side from the collected chunks (contract row 64)
//
// Contract-pinned assertions follow the keepalive-registry.test.mjs precedent: the pins are
// taken verbatim from TOOL_CONTRACTS §7 (fixed CDP method/event names) or from the mode
// registry contract §3.2 (tracing, heapRecording, sessionRecord). CDP names are never
// invented — every regex below is a real Chrome DevTools Protocol method/event.

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/index.ts");
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const commandsPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/commands.ts");
const injectedPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/snapshot_injected.js");

const indexSrc = fs.readFileSync(indexPath, "utf8");
const workerSrc = fs.readFileSync(workerPath, "utf8");
const injectedSrc = fs.readFileSync(injectedPath, "utf8");

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; } else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---- P2 catalog fixture (TOOL_CONTRACTS.md §7 rows 60-75) ----------------------
// params: distinguishing schema keys that MUST appear in the tool's parameters Type.Object
// (shared tab-resolution keys targetId/background are asserted separately for every tool).
// sw: contract CDP methods/events the SW MUST implement (searched in service_worker.js).
// CDP names are fixed protocol surface; MAX-cap regexes are intentionally tolerant — the impl
// may name its budget any way that follows the file's *_MAX* convention.
const P2_TOOLS = [
  { name: "chrome_dom_snapshot", kind: "dom.snapshot", params: ["computedStyles", "path"], sw: [/DOMSnapshot\.captureSnapshot/, /(?:DOM_SNAPSHOT|SNAPSHOT)[A-Z_]*MAX[A-Z_]*/], exports: true },
  { name: "chrome_css_audit", kind: "css.audit", params: [], sw: [/CSS_AUDIT_MAX_ELEMENTS/, /CSS_AUDIT_MAX_COMPARISONS/], exports: false },
  { name: "chrome_a11y_audit", kind: "a11y.audit", params: ["depth", "contrastLimit"], sw: [/Accessibility\.getFullAXTree/, /CSS\.getBackgroundColors/, /(?:AX_AUDIT|A11Y_AUDIT)[A-Z_]*MAX[A-Z_]*/], exports: false },
  { name: "chrome_trace", kind: "tracing.start", params: ["action", "categories", "path"], sw: [/Tracing\.start/, /Tracing\.end/, /Tracing\.getCategories/, /Tracing\.dataCollected/, /Tracing\.tracingComplete/, /MODE_TRACING/, /(?:TRACE|TRACING)[A-Z_]*MAX[A-Z_]*/], exports: true },
  { name: "chrome_heap_snapshot", kind: "heap.snapshot", params: ["path"], sw: [/HeapProfiler\.takeHeapSnapshot/, /HeapProfiler\.addHeapSnapshotChunk/, /MODE_HEAP_RECORDING/, /(?:HEAP)[A-Z_]*MAX[A-Z_]*/], exports: true },
  { name: "chrome_allocation_profile", kind: "heap.samplingStart", params: ["action", "samplingInterval"], sw: [/HeapProfiler\.startSampling/, /HeapProfiler\.stopSampling/, /HeapProfiler\.startTrackingHeapObjects/, /(?:SAMPLING|ALLOCATION)[A-Z_]*MAX[A-Z_]*/], exports: false },
  { name: "chrome_record_session", kind: "session.record", params: ["action", "durationMs", "path"], sw: [/MODE_RECORD_SESSION/, /(?:SESSION_RECORD|RECORD_SESSION)[A-Z_]*MAX[A-Z_]*/, /Page\.captureScreenshot/], exports: true },
  { name: "chrome_background_service", kind: "background.service", params: ["action", "service", "mode"], sw: [/BackgroundService\.startObserving/, /BackgroundService\.backgroundServiceEventReceived/, /(?:BACKGROUND_SERVICE|BG_SERVICE)[A-Z_]*MAX[A-Z_]*/], exports: false },
  { name: "chrome_watch_storage", kind: "storage.watch", params: ["action", "origin"], sw: [/Storage\.trackIndexedDBForOrigin/, /Storage\.trackCacheStorageForOrigin/, /Storage\.indexedDBContentUpdated/, /Storage\.cacheStorageContentUpdated/, /Storage\.indexedDBListUpdated/, /Storage\.cacheStorageListUpdated/], exports: false },
  { name: "chrome_event_breakpoint", kind: "debug.eventBreak", params: ["action", "eventNames"], sw: [/DOMDebugger\.setEventListenerBreakpoints/, /DOMDebugger\.removeEventListenerBreakpoint/], exports: false },
  { name: "chrome_dom_breakpoint", kind: "debug.domBreak", params: ["action", "uid", "selector"], sw: [/DOMDebugger\.setDOMBreakpoint/, /DOMDebugger\.removeDOMBreakpoint/, /resolveCdpNode/], exports: false },
  { name: "chrome_ime_compose", kind: "page.ime", params: ["action", "text"], sw: [/Input\.imeSetComposition/, /Input\.imeCommitComposition/], exports: false },
  { name: "chrome_virtual_time", kind: "page.virtualTime", params: ["action", "budgetMs"], sw: [/Emulation\.setVirtualTimePolicy/, /Emulation\.virtualTimeBudgetExpired/, /VIRTUAL_TIME_[A-Z_]+/], exports: false },
  { name: "chrome_device_matrix", kind: "page.deviceMatrix", params: ["profiles"], sw: [/Emulation\.setDeviceMetricsOverride/, /(?:DEVICE_MATRIX)[A-Z_]*MAX[A-Z_]*/], exports: true },
  { name: "chrome_snapshot_mhtml", kind: "page.mhtml", params: ["path"], sw: [/Page\.captureSnapshot/, /"mhtml"/, /(?:MHTML|MH)[A-Z_]*MAX[A-Z_]*/], exports: true },
  { name: "chrome_network_tls", kind: "network.certificate", params: ["origin", "requestId"], sw: [/Network\.getCertificate/, /(?:CERTIFICATE|CERT)[A-Z_]*MAX[A-Z_]*/], exports: false },
];

// Kinds that MUST exist as dispatch switch cases (multi-kind tools send literal sub-kinds).
const P2_KINDS = [
  "dom.snapshot", "css.audit", "a11y.audit",
  "tracing.start", "tracing.stop", "tracing.getCategories",
  "heap.snapshot", "heap.samplingStart", "heap.samplingStop",
  "session.record", "session.export",
  "background.service", "storage.watch", "debug.eventBreak", "debug.domBreak",
  "page.ime", "page.virtualTime", "page.deviceMatrix", "page.mhtml", "network.certificate",
];

// ---- String-aware brace matching (same helper as p0/p1a/p1b harnesses) ----------
function matchBrace(src, openIndex) {
  let depth = 0;
  let i = openIndex;
  let state = "code";
  const tplStack = [];
  for (; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (state === "sq") { if (c === "\\") { i++; continue; } if (c === "'") state = "code"; continue; }
    if (state === "dq") { if (c === "\\") { i++; continue; } if (c === '"') state = "code"; continue; }
    if (state === "tpl") {
      if (c === "\\") { i++; continue; }
      if (c === "`") { state = "code"; continue; }
      if (c === "$" && next === "{") { tplStack.push(depth); state = "code"; continue; }
      continue;
    }
    if (c === "/" && next === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && next === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    if (c === "'") { state = "sq"; continue; }
    if (c === '"') { state = "dq"; continue; }
    if (c === "`") { state = "tpl"; continue; }
    if (c === "{") { depth++; continue; }
    if (c === "}") {
      depth--;
      if (tplStack.length > 0 && depth === tplStack[tplStack.length - 1]) { tplStack.pop(); state = "tpl"; continue; }
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractRegisterToolBlocks(src) {
  const blocks = [];
  const re = /pi\.registerTool\(\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf("{", m.index);
    const close = matchBrace(src, open);
    if (close < 0) break;
    const block = src.slice(open, close + 1);
    const nameMatch = /name:\s*"([^"]+)"/.exec(block);
    if (nameMatch) blocks.push({ name: nameMatch[1], block });
    re.lastIndex = close + 1;
  }
  return blocks;
}

function extractParameters(block) {
  const m = /parameters:\s*Type\.Object\(\{/.exec(block);
  if (!m) return "";
  const open = block.indexOf("{", m.index);
  const close = matchBrace(block, open);
  return close < 0 ? "" : block.slice(open, close + 1);
}

function extractCHROME_TOOL_NAMES(src) {
  const m = /const CHROME_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const toolNames = extractCHROME_TOOL_NAMES(indexSrc);
const toolBlocks = extractRegisterToolBlocks(indexSrc);
const blocksByName = new Map(toolBlocks.map((b) => [b.name, b.block]));

// Load the real shipped commands.ts once via node's type stripping (same as p0/p1a/p1b).
const cmdJs = stripTypeScriptTypes(fs.readFileSync(commandsPath, "utf8"), { mode: "strip" });
const cmdMod = await import("data:text/javascript;base64," + Buffer.from(cmdJs).toString("base64"));

// ---- VM harness (real SW, controllable chrome.* mock + fake timers). sendCommand supports
// DEFERRED responses per method (e.g. HeapProfiler.takeHeapSnapshot) so chunk events can be
// fired mid-command, exactly like the real streaming protocol. ----
function makeChrome(rec) {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  const tab = { id: 7, windowId: 1, url: "https://example.test/", active: false, title: "Test" };
  return {
    runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null, reload: noop, getURL: (p) => p },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener, setBadgeText: noop, setBadgeBackgroundColor: noop },
    debugger: {
      attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]),
      onDetach: { addListener: (fn) => { rec.onDetachListener = fn; }, removeListener: noop },
      onEvent: { addListener: (fn) => { rec.onEventListener = fn; }, removeListener: noop },
      sendCommand: (debuggee, method, params, cb) => {
        rec.cdpMethods = rec.cdpMethods || [];
        rec.cdpMethods.push({ method, params: params || {} });
        const queue = rec.deferred && rec.deferred[method];
        if (queue) { queue.push(cb); return; } // resolved later via rec.resolveCdp(method, result)
        cb({});
      },
    },
    scripting: { executeScript: async () => [{ result: undefined }], registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
    webNavigation: { onCommitted: listener, onCompleted: listener },
    tabs: {
      onUpdated: listener, onRemoved: listener,
      query: async () => [{ ...tab }],
      get: async (id) => { if (Number(id) === tab.id) return { ...tab }; throw new Error("no tab"); },
      create: async () => ({ ...tab }), update: async () => ({ ...tab }), remove: async () => {},
      group: async () => -1, ungroup: async () => {},
    },
    windows: { create: async () => ({ id: 1 }), get: async () => ({ tabs: [] }), remove: async () => {}, update: async () => {} },
    storage: { session: { get: async () => ({}), set: async () => {} } },
  };
}

function loadWorker(rec) {
  const chrome = makeChrome(rec);
  const timers = new Map(); // id -> { fn, ms }
  let timerId = 1;
  const sandbox = {
    console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone, URL,
    setTimeout: (fn, ms) => { const id = timerId++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0, clearInterval: () => {},
    fetch: async () => { throw new Error("no network in unit test"); },
    navigator: { userAgent: "unit-test" },
    WebSocket: function () {},
    AbortController, encodeURIComponent, decodeURIComponent, URLSearchParams,
    chrome,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workerSrc, sandbox, { filename: "service_worker.js" });
  const ctxEval = (code) => vm.runInContext(code, sandbox, { filename: "ctx" });
  const fireTimer = (id) => {
    const t = timers.get(id);
    if (t) { timers.delete(id); t.fn(); }
  };
  // Fire any sandbox-side fake timer whose delay fits within maxMs (e.g. the heap handler's
  // trailing `await sleep(30)` drain). Long keepalive/waiter timers are left untouched.
  const flushTimers = (maxMs) => {
    for (const [id, t] of Array.from(timers.entries())) {
      if (t.ms <= maxMs) { timers.delete(id); t.fn(); }
    }
  };
  return { sandbox, ctxEval, timers, fireTimer, flushTimers };
}

// Race guard so a misbehaving (hanging) handler fails the test instead of wedging it.
function withTimeoutRace(promise, ms, label) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms))]);
}

// Yield to the real macrotask queue so an in-flight SW handler can progress through its
// await chain (getTabByParams -> attachDebugger -> cdpSend -> waiter registration).
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Poll (with flushes) until a handler has reached the point the test needs to react to —
// e.g. its CDP call is queued in the deferred mock, or its waiter is armed.
async function waitFor(predicate, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return true;
    await flush();
  }
  return predicate();
}

await run();

async function run() {
  // ===== (1) catalog consistency =====
  {
    for (const t of P2_TOOLS) {
      ok(toolNames.includes(t.name), `catalog: ${t.name} is listed in CHROME_TOOL_NAMES`);
      ok(blocksByName.has(t.name), `catalog: ${t.name} has a pi.registerTool block`);
    }
    const registeredNames = new Set(toolBlocks.map((b) => b.name));
    for (const name of toolNames) ok(registeredNames.has(name), `catalog: every CHROME_TOOL_NAMES entry has a matching registerTool block (${name})`);
  }

  // ===== (2) schema surface =====
  {
    for (const t of P2_TOOLS) {
      const block = blocksByName.get(t.name);
      if (!block) continue;
      const paramsSection = extractParameters(block);
      for (const marker of t.params) ok(paramsSection.includes(marker), `schema: ${t.name} parameters list '${marker}'`);
      // Shared tab-resolution params stay on every P2 tool.
      ok(paramsSection.includes("targetId"), `schema: ${t.name} keeps targetId tab-resolution param`);
      ok(paramsSection.includes("background"), `schema: ${t.name} keeps background tab-resolution param`);
    }
  }

  // ===== (3) wire routing =====
  {
    for (const t of P2_TOOLS) {
      const block = blocksByName.get(t.name);
      if (!block) continue;
      if (t.kind === "tracing.start") {
        ok(block.includes('authorizedBridgeSend("tracing.stop"') && block.includes('"tracing.start"') && block.includes('"tracing.getCategories"'), `routing: ${t.name} routes start/stop/getCategories kinds`);
      } else if (t.kind === "heap.samplingStart") {
        ok(block.includes('"heap.samplingStart"') && block.includes('"heap.samplingStop"'), `routing: ${t.name} routes samplingStart/samplingStop kinds`);
      } else if (t.kind === "session.record") {
        ok(block.includes('authorizedBridgeSend("session.record"') && block.includes('authorizedBridgeSend("session.export"'), `routing: ${t.name} routes record/export kinds`);
      } else {
        ok(block.includes(`authorizedBridgeSend("${t.kind}"`), `routing: ${t.name} sends kind '${t.kind}' via authorizedBridgeSend`);
      }
      ok(!block.includes("bridge.send("), `routing: ${t.name} never bypasses authorization with a raw bridge.send`);
    }
    for (const kind of P2_KINDS) {
      ok(workerSrc.includes(`case "${kind}":`), `routing: SW dispatch has a case for '${kind}'`);
    }
  }

  // ===== (4) CDP mapping =====
  {
    for (const t of P2_TOOLS) {
      for (const re of t.sw) ok(re.test(workerSrc), `cdp: SW implements ${re} for ${t.name}`);
    }
    // The record_session MutationObserver helper ships from snapshot_injected.js (P1B shipped
    // __piChromeWaitForMutation; a session recorder may extend or mirror it).
    ok(injectedSrc.includes("__piChromeWaitForMutation") || /__piChrome(?:Record|Session)/.test(injectedSrc), "cdp: snapshot_injected.js exposes the mutation/session helper the SW calls");
  }

  // ===== (5) file-export caps/truncation =====
  {
    // Host bridge caps stay in force for every P2 export path (risk #4).
    ok(/const MAX_RESULT_BODY_BYTES = 8 \* 1024 \* 1024;/.test(indexSrc), "caps: MAX_RESULT_BODY_BYTES is 8MB (above this /result is degraded, not buffered)");
    ok(/const MAX_COMMAND_BODY_BYTES = 1024 \* 1024;/.test(indexSrc), "caps: MAX_COMMAND_BODY_BYTES is 1MB (/command carries only action+params)");
    ok(/const MAX_WIRE_TIMEOUT_MS = 5 \* 60_000;/.test(indexSrc), "caps: MAX_WIRE_TIMEOUT_MS is 5 minutes");

    // Every P2 file-export tool follows the chrome_network_export / chrome_pdf writer pattern:
    // workspaceCwd(ctx) -> .pi/<subdir>/<timestamp>.<ext> -> mkdir -> writeFile -> { path } in
    // details. Never inline large artifacts beyond the caps.
    for (const t of P2_TOOLS) {
      if (!t.exports) continue;
      const block = blocksByName.get(t.name);
      if (!block) continue;
      ok(/workspaceCwd\(ctx\)/.test(block), `writer: ${t.name} resolves the workspace cwd for its default export path`);
      ok(/mkdir\(/.test(block) && /writeFile\(/.test(block), `writer: ${t.name} mkdirs the target dir and writeFile()s the artifact`);
      ok(/\.pi/.test(block) && /chrome-[a-z-]+/.test(block), `writer: ${t.name} exports under .pi/chrome-<subdir>/`);
      ok(/path:/.test(block) && /details:/.test(block), `writer: ${t.name} returns the written path in details`);
      ok(!/dataUrl:\s*Type\./.test(block), `writer: ${t.name} never accepts an inline payload schema for the artifact`);
    }

    // SW-side truncation discipline: large artifacts carry a truncated/tooLarge marker and the
    // heap path is summaryOnly-first (SW-side parse).
    ok(/\btruncated\b/.test(workerSrc), "caps: SW surfaces a truncated marker for capped payloads");
    ok(/\bsummaryOnly\b/.test(workerSrc), "caps: SW supports summaryOnly-first mode (heap snapshots / huge trees)");

    // mhtml behavior: small captures inline; oversized ones are refused with tooLarge instead of
    // blowing the 8MB bridge cap (chromePdf precedent at SW:5696).
    {
      const rec = {};
      const { sandbox } = loadWorker(rec);
      let mhtmlError = null;
      let r = null;
      let sent = null;
      try {
        rec.cdpMethods = [];
        rec.deferred = {};
        rec.deferred["Page.captureSnapshot"] = [];
        const p = sandbox.dispatch("page.mhtml", { targetId: 7 });
        // Let the handler reach its queued Page.captureSnapshot before resolving it.
        await waitFor(() => (rec.deferred["Page.captureSnapshot"] || []).length > 0, 2000);
        // Stream a small MHTML payload back.
        const small = Buffer.from("<html><body>hi</body></html>").toString("base64");
        rec.deferred["Page.captureSnapshot"].shift()({ data: small });
        r = await withTimeoutRace(p, 2000, "page.mhtml");
        sent = rec.cdpMethods.find((m) => m.method === "Page.captureSnapshot");
      } catch (e) { mhtmlError = e; }
      if (mhtmlError) {
        ok(false, "caps: page.mhtml dispatch failed: " + String(mhtmlError.message || mhtmlError).slice(0, 60));
      } else {
        ok(sent && sent.params.format === "mhtml", "caps: Page.captureSnapshot is requested with format=mhtml");
        ok(r && r.supported === true && r.truncated === false, "caps: small MHTML is returned inline with truncated:false");
        ok(r && typeof r.base64Length === "number" && r.base64Length === Buffer.from("<html><body>hi</body></html>").toString("base64").length, "caps: MHTML response reports the base64 length");
      }
    }

    // mhtml oversize: a payload past MHTML_MAX_BASE64_CHARS is refused with tooLarge and NO
    // inline data (the host would otherwise ship a >8MB /result).
    {
      const rec = {};
      const { sandbox } = loadWorker(rec);
      let capError = null;
      let r2 = null;
      try {
        rec.cdpMethods = [];
        rec.deferred = {};
        rec.deferred["Page.captureSnapshot"] = [];
        const p = sandbox.dispatch("page.mhtml", { targetId: 7 });
        await waitFor(() => (rec.deferred["Page.captureSnapshot"] || []).length > 0, 2000);
        rec.deferred["Page.captureSnapshot"].shift()({ data: "A".repeat(7 * 1024 * 1024) }); // ~7MB base64
        r2 = await withTimeoutRace(p, 2000, "page.mhtml cap");
      } catch (e) { capError = e; }
      if (capError) {
        ok(false, "caps: page.mhtml oversize dispatch failed: " + String(capError.message || capError).slice(0, 60));
      } else {
        ok(r2 && r2.tooLarge === true && r2.data === undefined, "caps: oversized MHTML is flagged tooLarge with no inline data");
      }
    }
  }

  // ===== (6) keepalive membership (tracing / heapRecording / sessionRecord) =====
  {
    const rec = {};
    const { sandbox, ctxEval } = loadWorker(rec);

    // Green-today M0 infra: the mode ids are already declared; registration extends the attach
    // keepalive for ANY mode and cleanup drains per-tab membership + runs onDetach hooks.
    for (const mode of ["MODE_TRACING", "MODE_HEAP_RECORDING", "MODE_RECORD_SESSION"]) {
      ok(ctxEval(`${mode}`) === "tracing" || ctxEval(`${mode}`) === "heapRecording" || ctxEval(`${mode}`) === "sessionRecord", `membership: ${mode} constant is declared`);
    }
    ctxEval(`attachedTabs.set(7, { detachAt: Date.now() + 100, debuggee: { tabId: 7 } });`);
    const before = ctxEval(`attachedTabs.get(7).detachAt`);
    sandbox.registerMode(7, ctxEval(`MODE_TRACING`));
    const after = ctxEval(`attachedTabs.get(7).detachAt`);
    ok(after > before + 10_000, "membership: registering MODE_TRACING keeps the attach past the idle window (recordings never silently die)");
    ok(ctxEval(`modesPerTab.get(7)?.has(MODE_TRACING)`), "membership: MODE_TRACING recorded in modesPerTab");
    sandbox.unregisterMode(7, ctxEval(`MODE_TRACING`));

    // Contract-pinned (TOOL_CONTRACTS §3.2): the three P2 modes are registered with the full
    // contract surface, persist their intent (a re-attach re-applies the recording instead of a
    // phantom resume from thin air), and hold the attach while active. Data-loss discipline is
    // the "recording lost" clear error (asserted below), never a silent empty result.
    for (const [mode, label] of [["MODE_TRACING", "chrome_trace"], ["MODE_HEAP_RECORDING", "chrome_heap_snapshot"], ["MODE_RECORD_SESSION", "chrome_record_session"]]) {
      const desc = ctxEval(`keepaliveModes[${mode}]`);
      ok(desc !== undefined, `membership: ${mode} is registered in keepaliveModes (${label})`);
      if (!desc) continue;
      ok(desc.keepaliveMs > 0, `membership: ${mode} extends the attach keepalive`);
      ok(desc.persist === true, `membership: ${mode} persists its intent (${label} re-applies on re-attach per TOOL_CONTRACTS §3.2)`);
      ok(typeof desc.snapshot === "function" && typeof desc.restore === "function" && typeof desc.reapply === "function" && typeof desc.onDetach === "function", `membership: ${mode} exposes snapshot/restore/reapply/onDetach`);
    }

    // Stop-without-active-recording fails loudly (never silently loses state — constraint #1):
    // either the handler throws "No ... active" or the kind has not landed — either way the
    // agent is told.
    for (const [kind, action] of [["tracing.stop", "tracing"], ["heap.samplingStop", "heap"]]) {
      let threw = false;
      try { await sandbox.dispatch(kind, { targetId: 7, action }); } catch { threw = true; }
      ok(threw, `membership: ${kind} without an active recording throws a clear error`);
    }

    // cleanupModesForTab drains the P2 modes' per-tab maps through their onDetach hooks. The
    // per-tab state map is tolerant of the impl's name (guarded) — the drained membership is the
    // contract surface.
    {
      try {
        ctxEval(`globalThis.tracingPerTab = globalThis.tracingPerTab || new Map(); globalThis.tracingPerTab.set(7, { recording: true });`);
      } catch {}
      sandbox.registerMode(7, ctxEval(`MODE_TRACING`));
      sandbox.cleanupModesForTab(7);
      ok(!ctxEval(`modesPerTab.has(7)`), "membership: cleanup drains per-tab membership");
      ctxEval(`attachedTabs.delete(7)`);
    }
  }

  // ===== (7) budget-expired handling (chrome_virtual_time) =====
  {
    const rec = {};
    const { sandbox, ctxEval } = loadWorker(rec);

    // Source: the onEvent branch resolves an advance waiter on the budget-expired event.
    ok(/Emulation\.virtualTimeBudgetExpired/.test(workerSrc), "virtual-time: SW routes the virtualTimeBudgetExpired CDP event");
    ok(/Emulation\.setVirtualTimePolicy/.test(workerSrc), "virtual-time: SW calls Emulation.setVirtualTimePolicy to advance time");
    ok(/virtualTimeWaiters/.test(workerSrc), "virtual-time: SW keeps per-tab virtual-time waiter state");

    // Behavior: advance with a budget issues setVirtualTimePolicy and resolves with the consumed
    // budget when the budget-expired event fires.
    let advanceError = null;
    let r = null;
    let sent = null;
    try {
      rec.cdpMethods = [];
      const p = sandbox.dispatch("page.virtualTime", { targetId: 7, action: "advance", budgetMs: 500 });
      // The handler arms its budgetExpired waiter only after setVirtualTimePolicy resolves;
      // wait for the waiter before firing the renderer's budget-expired event.
      await waitFor(() => ctxEval(`virtualTimeWaiters.has(7)`), 2000);
      sent = (rec.cdpMethods || []).find((m) => m.method === "Emulation.setVirtualTimePolicy");
      // Budget consumed: the CDP renderer fires virtualTimeBudgetExpired.
      if (rec.onEventListener) {
        rec.onEventListener({ tabId: 7 }, "Emulation.virtualTimeBudgetExpired", { virtualTimeTicksBase: 0, virtualTimeTicks: 500, elapsedVirtualTime: 500 });
      }
      r = await withTimeoutRace(p, 2000, "page.virtualTime advance");
    } catch (e) { advanceError = e; }
    if (advanceError) {
      ok(false, "virtual-time: advance dispatch failed: " + String(advanceError.message || advanceError).slice(0, 60));
    } else {
      ok(sent && sent.params.budget === 500 && sent.params.policy === "advance", "virtual-time: setVirtualTimePolicy carries the requested 500ms budget with policy 'advance'");
      ok(r && r.budgetMs === 500 && r.budgetExpired === true && r.action === "advance", "virtual-time: advance resolves with the requested budget and budgetExpired=true");
    }

    // Never combine with printToPDF (contract row 72): the PDF path must consult virtual-time
    // state within a few tokens of the printToPDF call (or refuse outright).
    const pdfGuard = /printToPDF[\s\S]{0,300}(?:virtualTime|MODE_VIRTUAL_TIME|virtualTimePerTab)|(?:virtualTime|MODE_VIRTUAL_TIME|virtualTimePerTab)[\s\S]{0,300}printToPDF/;
    ok(pdfGuard.test(workerSrc), "virtual-time: chrome_pdf refuses/degrades while virtual time is active (never combine with printToPDF)");
  }

  // ===== (8) chunk-write state (chrome_heap_snapshot streaming) =====
  {
    const rec = {};
    const { sandbox, ctxEval, flushTimers } = loadWorker(rec);

    // Source: chunk events accumulate SW-side and a cap bounds the buffer (risk #11).
    ok(/HeapProfiler\.addHeapSnapshotChunk/.test(workerSrc), "chunks: SW routes HeapProfiler.addHeapSnapshotChunk events");
    ok(/heapSnapshotPerTab/.test(workerSrc), "chunks: SW keeps per-tab heap snapshot chunk state");
    ok(/takeHeapSnapshot/.test(workerSrc), "chunks: SW calls HeapProfiler.takeHeapSnapshot to start collection");

    // Behavior: takeHeapSnapshot streams chunks via events WHILE the CDP call is pending; the
    // handler collects them, parses a SW-side summary, and honors the byte cap.
    let snapshotError = null;
    let r = null;
    try {
      rec.cdpMethods = [];
      rec.deferred = { "HeapProfiler.takeHeapSnapshot": [] };
      const p = sandbox.dispatch("heap.snapshot", { targetId: 7, summaryOnly: true, maxNodes: 100 });

      // Wait for the handler to queue takeHeapSnapshot, then stream chunk events (real protocol
      // order: events fire while the command is still pending).
      await waitFor(() => (rec.deferred["HeapProfiler.takeHeapSnapshot"] || []).length > 0, 2000);
      // Two chunks that concatenate into a valid (small) .heapsnapshot JSON — the real protocol
      // splits one JSON document across addHeapSnapshotChunk events.
      const chunk1 = '{"snapshot":{"meta":{"node_fields":["type","name","id","self_size","edge_count","trace_node_id","detachedness"],"node_types":[["hidden","object"]]},"node_count":2,"edge_count":0},"nodes":[2,0,1,5,0,0,0,2,1,2,3,0,0,0],';
      const chunk2 = '"strings":["","Object","someFunction"],"edges":[],"trace_function_infos":[],"trace_tree":[],"samples":[],"locations":[]}';
      if (rec.onEventListener) {
        rec.onEventListener({ tabId: 7 }, "HeapProfiler.addHeapSnapshotChunk", { chunk: chunk1 });
        rec.onEventListener({ tabId: 7 }, "HeapProfiler.addHeapSnapshotChunk", { chunk: chunk2 });
      }
      // Complete the CDP command: the handler resolves takeHeapSnapshot and summarizes.
      rec.deferred["HeapProfiler.takeHeapSnapshot"].shift()({});
      await flush(); // let the handler reach its trailing `await sleep(30)` drain
      flushTimers(50); // fire the sandbox-side 30ms drain timer
      r = await withTimeoutRace(p, 2000, "heap.snapshot");
    } catch (e) { snapshotError = e; }
    if (snapshotError) {
      ok(false, "chunks: heap.snapshot dispatch failed: " + String(snapshotError.message || snapshotError).slice(0, 60));
    } else {
      ok(r && typeof r === "object" && !Array.isArray(r), "chunks: heap.snapshot resolves with a result object");
      ok(r && r.summary !== undefined && r.summary.chunkCount === 2, "chunks: the SW-side summary reflects the 2 streamed chunks (summaryOnly parse)");
      ok(r && r.summary.truncated === false && r.snapshot !== undefined, "chunks: a small snapshot is inlined, not flagged truncated");
    }

    // Byte cap: a single oversized chunk trips the bounded buffer (risk #4/#11).
    let capError = null;
    let capObserved = false;
    try {
      rec.cdpMethods = [];
      rec.deferred = { "HeapProfiler.takeHeapSnapshot": [] };
      const p = sandbox.dispatch("heap.snapshot", { targetId: 7, summaryOnly: true });
      await waitFor(() => (rec.deferred["HeapProfiler.takeHeapSnapshot"] || []).length > 0, 2000);
      if (rec.onEventListener) {
        rec.onEventListener({ tabId: 7 }, "HeapProfiler.addHeapSnapshotChunk", { chunk: "x".repeat(12 * 1024 * 1024) }); // ~12MB chunk
      }
      rec.deferred["HeapProfiler.takeHeapSnapshot"].shift()({});
      await flush();
      flushTimers(50);
      const r2 = await withTimeoutRace(p, 2000, "heap.snapshot cap");
      capObserved = r2 && (r2.snapshotTooLarge !== undefined || r2.summary?.truncated === true);
    } catch (e) { capError = e; }
    if (capError) {
      ok(false, "chunks: cap dispatch failed: " + String(capError.message || capError).slice(0, 60));
    } else {
      ok(capObserved, "chunks: an oversized chunk stream is flagged (snapshotTooLarge/truncated) instead of buffered past the cap");
    }
  }

  // ===== (9) pure formatters (commands.ts) =====
  {
    const f = (name) => cmdMod[name];
    // Contract §8 names these two explicitly ("later formatA11yTree, formatNetworkSummary,
    // formatHeapSummary, formatTraceSummary").
    ok(typeof f("formatTraceSummary") === "function", "formatters: formatTraceSummary ships (contract §8)");
    ok(typeof f("formatHeapSummary") === "function", "formatters: formatHeapSummary ships (contract §8)");
    // Every P2 tool renders through a commands.ts pure formatter or the truncateText fallback.
    // Digit-tolerant so names like formatA11yAudit match.
    for (const t of P2_TOOLS) {
      const block = blocksByName.get(t.name);
      if (!block) continue;
      ok(/format[A-Z][A-Za-z0-9]*\(/.test(block) || /truncateText\(safeJson\(result\)\)/.test(block), `formatters: ${t.name} renders via a pure formatter or truncateText(safeJson)`);
    }
  }

  console.log(`\np2-tools: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}
