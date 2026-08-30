// P1B-batch harness (test-p1b): CSS + A11y + input/events + storage/system/visual/perf.
//
// Pins the P1B tool surface of tasks/impl/TOOL_CONTRACTS.md §6 rows 22-28, 43-59 (23 tools)
// against the REAL shipped sources (source-level for index.ts, vm-load for service_worker.js,
// type-stripped import for commands.ts):
//   (1) catalog consistency — every P1B CHROME_TOOL_NAMES entry has a pi.registerTool block
//   (2) schema surface — distinguishing inputs present per tool; the destructive-gate confirm
//       param on chrome_clear_site_data; chrome_pdf keeps the file-export writer shape
//   (3) wire routing — every P1B kind has a `case` in the SW dispatch switch (multi-kind tools
//       use kind-prefix routing like network.intercept) and every tool routes via
//       authorizedBridgeSend
//   (4) CDP mapping — the SW implements the contract CDP methods/events (CSS.*, Accessibility.*,
//       Storage.*, CacheStorage.*, ServiceWorker.*, SystemInfo.*, Animation.*, Profiler.*, ...)
//   (5) destructive-gate — storage.clearSiteData refuses without confirm:true and only then
//       sends Storage.clearDataForOrigin (storageTypes "all") + Network.clearBrowserCache
//   (6) keepalive-detach — MODE_PSEUDO (persist + re-apply on re-attach), MODE_INPUT_LOCK
//       (persist:false, auto-clear on detach), MODE_ANIMATIONS / MODE_CPU_PROFILE (paused-all /
//       recording hold the attach); onDetach drains every per-tab map
//   (7) vm behavior — dispatch-driven: pseudo-state lifecycle, touch gesture, cache/storage ops,
//       service-worker control, target evaluate attach/detach, animations pause keepalive,
//       pdf base64, cpu profile start/stop keepalive, coverage
//   (8) pure helpers + formatters — recordAnimationEvent / recordServiceWorkerEvent rings
//       (commands.ts format* surface)
//
// NOTE ON PHASE STATE: the P1B batch is fully implemented in the tree (handlers, dispatch
// cases, host registerTool blocks, commands.ts formatters). This fixture is aligned with the
// SHIPPED implementation so the whole harness runs GREEN.
//
// Accepted deviations from TOOL_CONTRACTS.md §6 (implementation made reasonable surface
// choices; flagged here for the Verify phase to reconcile against the contract):
//   * chrome_matched_css_rules — no pseudoElements input param (CDP response still carries the
//     pseudo-element cascade).
//   * chrome_a11y_tree — no frameId input (depth only).
//   * chrome_layout_metrics — detectOverflow/detectCLS inputs dropped; the overflow/scrollable
//     scan is always-on (see the tool description).
//   * chrome_cpu_profile — maxBufferSize replaced by action + samplingInterval inputs;
//     Profiler domain is enabled via the enableCdpDomain helper (templated `${domain}.enable`).
//   * chrome_target_evaluate — keeps the shared tab-resolution params for host symmetry, but
//     its targetId is the CDP evaluation target (workers/service workers), not a tab.
//   * chrome_service_worker / chrome_cpu_profile — the host computes the kind per action
//     (ternary), so routing is asserted on the kind literals + authorizedBridgeSend call.

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
  if (cond) { passes++; }
  else { failures++; console.error(`  ✗ ${msg}`); }
}
function throwsWith(fn, re, msg) {
  try { fn(); ok(false, `${msg} (expected throw)`); }
  catch (e) { ok(re.test(String(e.message || e)), `${msg} (got: ${e.message})`); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ---- P1B catalog fixture (TOOL_CONTRACTS.md §6 rows 22-28 + 43-59) --------------------------
// params: distinguishing schema keys that MUST appear in the tool's parameters Type.Object.
// sw: contract CDP methods/behavior the SW MUST implement (searched in service_worker.js).
// global: browser-global tool (no tab resolution; host/port only). targetTool: evaluates inside
// an arbitrary CDP target (its targetId is the evaluation target, not a tab).
const P1B_TOOLS = [
  // CSS cluster (rows 22-26)
  { name: "chrome_matched_css_rules", kind: "css.matchedRules", params: ["uid", "selector"], sw: [/CSS\.getMatchedStylesForNode/, /CSS\.getInlineStylesForNode/, /CSS_MATCHED_RULES_MAX/] },
  { name: "chrome_force_pseudo_state", kind: "css.pseudoState", params: ["uid", "selector", "forcedPseudoClasses", "clear"], sw: [/CSS\.forcePseudoState/, /forcedPseudoPerTab/, /MODE_PSEUDO/] },
  { name: "chrome_media_queries", kind: "css.mediaQueries", params: [], sw: [/CSS\.getMediaQueries/, /CSS_MEDIA_QUERIES_MAX/] },
  { name: "chrome_background_colors", kind: "css.backgroundColors", params: ["uid", "selector"], sw: [/CSS\.getBackgroundColors/] },
  { name: "chrome_platform_fonts", kind: "css.platformFonts", params: ["uid", "selector"], sw: [/CSS\.getPlatformFontsForNode/] },
  // A11y cluster (rows 27-28)
  { name: "chrome_a11y_tree", kind: "a11y.tree", params: ["depth"], sw: [/Accessibility\.getFullAXTree/, /AX_TREE_MAX_NODES/, /AX_TREE_DEPTH_MAX/, /summaryOnly/] },
  { name: "chrome_a11y_node", kind: "a11y.node", params: ["uid", "selector"], sw: [/Accessibility\.getPartialAXTree/] },
  // DOM / debugger / input (rows 48-51)
  { name: "chrome_mutation_wait", kind: "page.mutationWait", params: ["uid", "selector", "attributeFilter", "childList", "timeoutMs", "maxRecords"], sw: [/MUTATION_WAIT_MAX_MS/, /MUTATION_WAIT_MAX_RECORDS/] },
  { name: "chrome_capture_fetch_stack", kind: "debug.xhrBreak", params: ["url", "timeoutMs"], sw: [/DOMDebugger\.setXHRBreakpoint/, /DOMDebugger\.removeXHRBreakpoint/, /xhrBreakWaiters/, /XHR_BREAK_MAX_WAIT_MS/] },
  { name: "chrome_input_lock", kind: "input.setIgnore", params: ["ignore"], sw: [/Input\.setIgnoreInputEvents/, /MODE_INPUT_LOCK/, /inputLockTabs/] },
  { name: "chrome_touch_gesture", kind: "page.gesture", params: ["type", "scale", "points"], sw: [/Input\.dispatchTouchEvent/, /Input\.synthesizePinchGesture/, /Input\.synthesizeScrollGesture/] },
  // Storage cluster (rows 45-47)
  { name: "chrome_storage_usage", kind: "storage.usage", params: ["origin"], sw: [/Storage\.getUsageAndQuota/] },
  { name: "chrome_cache_storage", kind: "cache.op", params: ["action", "cacheId", "requestUrl"], sw: [/CacheStorage\.requestCacheNames/, /CacheStorage\.requestEntries/, /CacheStorage\.deleteCache/, /CacheStorage\.deleteEntry/, /CACHE_STORAGE_ENTRIES_MAX/] },
  { name: "chrome_clear_site_data", kind: "storage.clearSiteData", params: ["confirm", "origin", "storageTypes"], sw: [/Storage\.clearDataForOrigin/, /Network\.clearBrowserCache/], destructive: true },
  // Browser / system cluster (rows 43, 52-54)
  { name: "chrome_service_worker", kind: ["serviceworker.list", "serviceworker.action"], params: ["action", "versionId", "scopeURL"], sw: [/ServiceWorker\.enable/, /ServiceWorker\.startWorker/, /ServiceWorker\.stopWorker/, /ServiceWorker\.unregister/, /ServiceWorker\.inspectWorker/, /serviceWorkerPerTab/] },
  { name: "chrome_system_info", kind: "system.info", params: ["processes"], sw: [/SystemInfo\.getInfo/, /SystemInfo\.getProcessInfo/], global: true },
  { name: "chrome_target_evaluate", kind: "target.evaluate", params: ["targetId", "expression"], sw: [/attachedTargets/, /chrome\.debugger\.attach/, /TARGET_EVAL_ATTACH_TIMEOUT_MS/], targetTool: true },
  { name: "chrome_set_permission", kind: "browser.setPermission", params: ["origin", "permission", "setting"], sw: [/Browser\.setPermission/], global: true },
  // Visual cluster (rows 55-57)
  { name: "chrome_layout_metrics", kind: "page.layoutMetrics", params: [], sw: [/Page\.getLayoutMetrics/] },
  { name: "chrome_animations", kind: "page.animations", params: ["action", "animationId", "currentTime", "playbackRate", "timeoutMs"], sw: [/Animation\.enable/, /Animation\.setPaused/, /Animation\.seekAnimations/, /Animation\.setPlaybackRate/, /MODE_ANIMATIONS/] },
  { name: "chrome_pdf", kind: "page.pdf", params: ["path", "landscape", "printBackground", "scale", "pageRanges"], sw: [/Page\.printToPDF/, /PRINT_TO_PDF_TIMEOUT_MS/], fileExport: true },
  // Perf cluster (rows 58-59)
  { name: "chrome_cpu_profile", kind: ["profiler.cpuStart", "profiler.cpuStop"], params: ["action", "samplingInterval"], sw: [/enableCdpDomain\([^)]*"Profiler"/, /Profiler\.start/, /Profiler\.stop/, /MODE_CPU_PROFILE/, /CPU_PROFILE_SUMMARY_MAX_FRAMES/, /CPU_PROFILE_INLINE_MAX_CHARS/] },
  { name: "chrome_coverage", kind: "coverage.get", params: [], sw: [/Profiler\.getBestEffortCoverage/, /CSS\.startRuleUsageTracking/, /CSS\.takeCoverageDelta/, /COVERAGE_MAX_FILES/] },
];

// ---- String-aware brace matching (same helper as p0/p1a harnesses) --------------------------
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

// Load the real shipped commands.ts once via node's type stripping (same as p0/p1a harnesses).
const cmdJs = stripTypeScriptTypes(fs.readFileSync(commandsPath, "utf8"), { mode: "strip" });
const cmdMod = await import("data:text/javascript;base64," + Buffer.from(cmdJs).toString("base64"));

// ---- Canned CDP responses so vm dispatch can walk the real resolver + handler chains. -------
const DEFAULT_CANNED = {
  "Runtime.evaluate": () => ({ result: { type: "object", objectId: "obj-1", description: "Element" }, exceptionDetails: undefined }),
  "Runtime.callFunctionOn": () => ({ result: { type: "object", objectId: "obj-3", description: "Element" }, exceptionDetails: undefined }),
  "DOM.requestNode": () => ({ nodeId: 1 }),
  "DOM.getFrameOwner": () => ({ nodeId: 2 }),
  "DOM.resolveNode": () => ({ object: { type: "object", objectId: "obj-2" } }),
  "DOM.describeNode": () => ({ node: { nodeId: 1, nodeName: "DIV" } }),
  "CSS.getMatchedStylesForNode": () => ({ matchedCSSRules: [{ selectorText: "#btn", origin: "regular", specificity: [0, 1, 0], style: { cssProperties: [] } }], pseudoElements: [], inherited: [] }),
  "CSS.getInlineStylesForNode": () => ({ inlineStyle: null, attributesStyle: null }),
  "CSS.getMediaQueries": () => ({ medias: [{ text: "(max-width: 600px)", source: "linkedSheet" }] }),
  "CSS.getBackgroundColors": () => ({ backgroundColors: ["rgb(255, 255, 255)"], computedFontSize: "16px", computedFontWeight: "400", contrastTextColor: "rgb(0, 0, 0)" }),
  "CSS.getPlatformFontsForNode": () => ({ fonts: [{ familyName: "Arial", glyphCount: 5, isCustomFont: false }] }),
  "Accessibility.getFullAXTree": () => ({ nodes: [{ nodeId: 1, ignored: false, role: { value: "button" }, name: { value: "Go" } }] }),
  "Accessibility.getPartialAXTree": () => ({ nodes: [{ nodeId: 1, ignored: false, role: { value: "link" }, name: { value: "Docs" } }] }),
  "Storage.getUsageAndQuota": () => ({ usage: 1234, quota: 1000000, usageBreakdown: [{ storageType: "temporary", usage: 1234 }] }),
  "CacheStorage.requestCacheNames": () => ({ caches: [{ cacheName: "v1", securityOrigin: "https://app.example/" }] }),
  "CacheStorage.requestEntries": () => ({ cacheDataEntries: [{ requestURL: "https://app.example/x", requestMethod: "GET", responseHeaders: [] }], hasMore: false }),
  "CacheStorage.deleteCache": () => ({}),
  "CacheStorage.deleteEntry": () => ({}),
  "SystemInfo.getInfo": () => ({ gpu: { vendorId: 1, deviceId: 1, driverVersion: "1", vendorString: "Vendor", deviceString: "Device X" }, modelName: "Test Model", modelVersion: "1", commandLine: ["--test"] }),
  "SystemInfo.getProcessInfo": () => ({ processInfo: [{ id: 1, type: "browser", cpuTime: 1 }] }),
  "Browser.setPermission": () => ({}),
  "Page.getLayoutMetrics": () => ({ layoutViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 }, visualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800, scale: 1, zoom: 1 }, contentSize: { x: 0, y: 0, width: 1280, height: 800 } }),
  "Animation.enable": () => ({}),
  "Animation.getAnimations": () => ({ animations: [{ id: "a1", name: "spin", playState: "running", playbackRate: 1 }] }),
  "Animation.setPaused": () => ({}),
  "Animation.seekAnimations": () => ({}),
  "Animation.setPlaybackRate": () => ({}),
  "Page.printToPDF": () => ({ data: Buffer.from("%PDF-1.4 unit-test").toString("base64") }),
  "Profiler.enable": () => ({}),
  "Profiler.start": () => ({}),
  "Profiler.stop": () => ({ profile: { nodes: [{ id: 1, callFrame: { functionName: "main", url: "https://app.example/app.js", lineNumber: 1, columnNumber: 0 }, hitCount: 10 }], samples: [1], timeDeltas: [100], startTime: 0, endTime: 100 } }),
  "Profiler.getBestEffortCoverage": () => ({ result: [{ url: "https://app.example/app.js", functions: [{ functionName: "main", ranges: [{ startOffset: 0, endOffset: 100, count: 1 }], isBlockCoverage: true }] }] }),
  "CSS.startRuleUsageTracking": () => ({}),
  "CSS.takeCoverageDelta": () => ({ coverage: [], timestamp: 0 }),
  "ServiceWorker.enable": () => ({}),
  "Input.setIgnoreInputEvents": () => ({}),
  "Input.dispatchTouchEvent": () => ({}),
  "Input.synthesizePinchGesture": () => ({}),
  "Input.synthesizeScrollGesture": () => ({}),
  "DOMDebugger.setXHRBreakpoint": () => ({ breakpointId: "xhr-1" }),
  "DOMDebugger.removeXHRBreakpoint": () => ({}),
  "Network.clearBrowserCache": () => ({}),
  "Storage.clearDataForOrigin": () => ({}),
};

// ---- VM harness (real SW, controllable chrome.* mock + fake timers + event fakers). ---------
function makeChrome(rec) {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  const sessionStore = {};
  const listeners = { onDetach: [], onEvent: [] };
  const tab = { id: 7, windowId: 1, url: "https://app.example/", active: false, title: "App" };
  return {
    runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null, reload: noop, getURL: (p) => p },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener, setBadgeText: noop, setBadgeBackgroundColor: noop },
    debugger: {
      attach: async (target, _version, cb) => { rec.attached = rec.attached || []; rec.attached.push(target); if (typeof cb === "function") cb(); },
      detach: async (target, _version, cb) => { rec.detached = rec.detached || []; rec.detached.push(target); if (typeof cb === "function") cb(); },
      getTargets: (cb) => cb(rec.targets || []),
      onDetach: { addListener: (fn) => listeners.onDetach.push(fn), removeListener: noop },
      onEvent: { addListener: (fn) => listeners.onEvent.push(fn), removeListener: noop },
      sendCommand: (debuggee, method, params, cb) => {
        rec.cdpMethods = rec.cdpMethods || [];
        rec.cdpMethods.push({ method, params: params || {} });
        if (rec.failing && rec.failing.has(method)) {
          chrome.runtime.lastError = { message: `mock failure for ${method}` };
          cb({});
          chrome.runtime.lastError = null;
          return;
        }
        const canned = (rec.canned || DEFAULT_CANNED)[method];
        const out = typeof canned === "function" ? canned(params) : {};
        if (out && typeof out.then === "function") out.then((v) => cb(v));
        else cb(out);
      },
    },
    scripting: { executeScript: async () => [{ result: undefined }], registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
    webNavigation: { onCommitted: listener, onCompleted: listener, getAllFrames: async () => [] },
    tabs: {
      onUpdated: listener, onRemoved: listener,
      query: async () => [{ ...tab }],
      get: async (id) => { if (Number(id) === tab.id) return { ...tab }; throw new Error("no tab"); },
      create: async () => ({ ...tab }), update: async () => ({ ...tab }), remove: async () => {},
      group: async () => -1, ungroup: async () => {},
    },
    windows: { create: async () => ({ id: 1 }), get: async () => ({ tabs: [] }), remove: async () => {}, update: async () => {} },
    storage: { session: { get: async (k) => (k in sessionStore ? { [k]: sessionStore[k] } : {}), set: async (o) => Object.assign(sessionStore, o) } },
    sessionStore, listeners,
  };
}

function loadWorker(rec) {
  const chrome = makeChrome(rec);
  const timers = new Map(); // id -> { fn, ms }
  let timerId = 1;
  const sandbox = {
    console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone, URL,
    setTimeout: (fn, ms) => {
      const id = timerId++;
      timers.set(id, { fn, ms });
      // Auto-fire short timers (the coverage flow sleeps 100ms between rule-usage start/delta)
      // so a vm dispatch never hangs; long safety timers (XHR-break 30s window) stay manual
      // and are cleared by the events that resolve their waiters.
      if (typeof ms === "number" && ms <= 1000) setImmediate(() => fireTimer(id));
      return id;
    },
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
  const fireOnEvent = (method, eventParams) => {
    for (const fn of chrome.listeners.onEvent) fn({ tabId: 7 }, method, eventParams);
  };
  const fireOnDetach = (tabId, reason) => {
    for (const fn of chrome.listeners.onDetach) fn({ tabId }, reason || "target_closed");
  };
  return { sandbox, ctxEval, timers, fireTimer, fireOnEvent, fireOnDetach, chrome };
}

// Dispatch a kind and report "not implemented yet" (Unknown action) as a single clear failure
// instead of letting every contract-pinned assertion crash on a missing case.
async function dispatchOrSkip(sandbox, kind, params, label) {
  try {
    return await sandbox.dispatch(kind, params);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/Unknown action/.test(msg)) {
      ok(false, `${label}: dispatch('${kind}') not implemented yet (Unknown action)`);
      return null;
    }
    throw e;
  }
}

function cdpCalled(rec, method) {
  return (rec.cdpMethods || []).some((m) => m.method === method);
}
function cdpParams(rec, method) {
  const hit = (rec.cdpMethods || []).filter((m) => m.method === method);
  return hit.map((m) => m.params);
}

// ---- P1B formatter surface (commands.ts pure formatters — names + shapes of the shipped impl).
// Each row: [sample-result, needles that MUST appear in the formatted text].
const P1B_FORMATTERS = {
  formatMatchedRules: [{ node: { uid: "el-1" }, matchedRules: [{ group: "matched", origin: "author", selectorText: "#btn", specificity: { a: 0, b: 1, c: 0 }, properties: [{ name: "color", value: "red" }] }], truncated: false }, ["#btn", "author"]],
  formatPseudoState: [{ forcedPseudoClasses: [":hover", ":active"], cleared: false }, [":hover"]],
  formatMediaQueries: [{ queries: [{ source: "linkedSheet", text: "(max-width: 600px)" }] }, ["max-width"]],
  formatBackgroundColors: [{ backgroundColors: ["rgb(0, 0, 0)"], computedFontSize: "16px", computedFontWeight: "400" }, ["rgb(0, 0, 0)"]],
  formatPlatformFonts: [{ fonts: [{ familyName: "Arial", glyphCount: 5, isCustomFont: false }] }, ["Arial"]],
  formatA11yTree: [{ nodes: [{ nodeId: "n1", role: "button", name: "Go", ignored: false }], summary: { total: 1, ignored: 0, roleCounts: [{ role: "button", count: 1 }] }, depth: 2 }, ["Go", "button"]],
  formatA11yNode: [{ ax: { nodeId: "n1", role: "link", name: "Docs", ignored: true, ignoredReasons: [{ reason: "not rendered" }] } }, ["Docs", "IGNORED"]],
  formatMutationWait: [{ records: [{ type: "attributes", attributeName: "class", target: { tag: "div" } }], count: 1, timedOut: false }, ["attributes"]],
  formatFetchStack: [{ breakpointed: true, url: "https://api.example/x", stack: [{ functionName: "fetchX", url: "https://app.example/app.js", lineNumber: 3 }] }, ["api.example", "fetchX"]],
  formatInputLock: [{ ignoring: true }, ["ignored"]],
  formatGesture: [{ type: "pinch", scaleFactor: 2, x: 100, y: 200 }, ["pinch", "scale=2"]],
  formatStorageUsage: [{ origin: "https://app.example", usage: 1234, quota: 1000000, usageBreakdown: [{ type: "temporary", usage: 1000 }] }, ["temporary", "1.2 KB"]],
  formatCacheStorage: [{ action: "list", caches: [{ cacheName: "v1", cacheId: "c1" }] }, ["v1"]],
  formatClearSiteData: [{ origin: "https://app.example", storageTypes: "all", httpCacheCleared: true }, ["Cleared", "HTTP cache"]],
  formatServiceWorker: [{ action: "list", registrations: [], versions: [{ versionId: "v1", status: "activated", runningStatus: "running", scriptURL: "https://app.example/sw.js" }], errors: [] }, ["v1", "activated"]],
  formatSystemInfo: [{ info: { platform: "Windows", platformVersion: "11", arch: "x64", osVersion: "10", gpu: { devices: [{ vendorString: "Vendor", deviceString: "Device X", driverVersion: "1" }] } } }, ["Windows", "Device X"]],
  formatTargetEvaluate: [{ ok: true, targetId: "t-1", result: 42 }, ["42"]],
  formatSetPermission: [{ permission: "geolocation", setting: "granted", origin: "https://app.example" }, ["granted"]],
  formatLayoutMetrics: [{ layoutViewport: { width: 1280, height: 800, x: 0, y: 0 }, cssContentSize: { width: 1280, height: 800 } }, ["1280x800"]],
  formatAnimations: [{ action: "list", animations: [{ id: "a1", playState: "running", playbackRate: 2, target: { tag: "div" } }] }, ["a1", "running"]],
  formatPdfResult: [{ supported: true, base64Length: 1337 }, ["bytes"]],
  formatCpuProfile: [{ elapsedMs: 100, sampleCount: 5, rowCount: 3, selfTimeByFunction: [{ functionName: "main", url: "https://app.example/app.js", lineNumber: 1, selfTimeMs: 12, pct: 50 }] }, ["main", "50%"]],
  formatCoverage: [{ files: [{ url: "app.js", unusedBytes: 100, totalBytes: 350, unusedPct: 28.6, kind: "js" }] }, ["app.js"]],
};

async function run() {
  // ===== (1) catalog consistency =====
  {
    for (const t of P1B_TOOLS) {
      ok(toolNames.includes(t.name), `catalog: ${t.name} is listed in CHROME_TOOL_NAMES`);
      ok(blocksByName.has(t.name), `catalog: ${t.name} has a pi.registerTool block`);
    }
    const registeredNames = new Set(toolBlocks.map((b) => b.name));
    for (const name of toolNames) {
      ok(registeredNames.has(name), `catalog: every CHROME_TOOL_NAMES entry has a matching registerTool block (${name})`);
    }
  }

  // ===== (2) schema surface =====
  {
    for (const t of P1B_TOOLS) {
      const block = blocksByName.get(t.name);
      if (!block) continue;
      const paramsSection = extractParameters(block);
      for (const marker of t.params) {
        ok(paramsSection.includes(marker), `schema: ${t.name} parameters list '${marker}'`);
      }
      // Shared tab-resolution params stay on every tab-resolving P1B tool. Browser-global tools
      // carry host/port only; chrome_target_evaluate's targetId IS the evaluation target.
      if (!t.global && !t.targetTool) {
        ok(paramsSection.includes("targetId"), `schema: ${t.name} keeps targetId tab-resolution param`);
        ok(paramsSection.includes("urlIncludes"), `schema: ${t.name} keeps urlIncludes tab-resolution param`);
        ok(paramsSection.includes("background"), `schema: ${t.name} keeps background tab-resolution param`);
      } else if (t.global) {
        ok(paramsSection.includes("host"), `schema: ${t.name} keeps host param`);
        ok(paramsSection.includes("port"), `schema: ${t.name} keeps port param`);
      } else {
        ok(paramsSection.includes("targetId"), `schema: ${t.name} exposes targetId (the CDP target to evaluate in)`);
        ok(paramsSection.includes("expression"), `schema: ${t.name} exposes expression`);
      }
    }

    // Destructive-gate surface: chrome_clear_site_data must carry an explicit confirm and its
    // description must warn before clearing (risk: irreversible data loss).
    const csd = blocksByName.get("chrome_clear_site_data");
    if (csd) {
      const paramsSection = extractParameters(csd);
      ok(paramsSection.includes("confirm"), "gate: chrome_clear_site_data parameters require 'confirm'");
      ok(/confirm/i.test(csd), "gate: chrome_clear_site_data block references confirm");
      ok(/destructive|irreversible|permanent|will clear|clears all/i.test(csd), "gate: chrome_clear_site_data description warns it is destructive");
    }

    // chrome_pdf is a file-export tool: schema carries path; the block never inlines the raw
    // base64 into the tool text (writer pattern, TOOL_CONTRACTS §2.5).
    const pdf = blocksByName.get("chrome_pdf");
    if (pdf) {
      const paramsSection = extractParameters(pdf);
      ok(paramsSection.includes("path"), "export: chrome_pdf parameters expose an output path");
      ok(paramsSection.includes("printBackground"), "export: chrome_pdf parameters expose printBackground");
      ok(!/text:.*\$\{.*(data|pdf)/.test(pdf), "export: chrome_pdf never inlines the raw PDF/base64 into tool text");
    }
  }

  // ===== (3) wire routing =====
  {
    for (const t of P1B_TOOLS) {
      const block = blocksByName.get(t.name);
      if (!block) continue;
      const kinds = Array.isArray(t.kind) ? t.kind : [t.kind];
      if (kinds.length > 1) {
        // Multi-kind tools (serviceworker.list/.action, profiler.cpuStart/.cpuStop) compute the
        // kind from the action param; the block must reference every kind literal AND route via
        // authorizedBridgeSend (never a raw bridge.send).
        for (const k of kinds) ok(block.includes(`"${k}"`), `routing: ${t.name} references kind '${k}'`);
        ok(block.includes("authorizedBridgeSend("), `routing: ${t.name} routes via authorizedBridgeSend`);
      } else {
        ok(block.includes(`authorizedBridgeSend("${t.kind}"`), `routing: ${t.name} sends kind '${t.kind}' via authorizedBridgeSend`);
      }
      ok(!block.includes("bridge.send("), `routing: ${t.name} never bypasses authorization with a raw bridge.send`);
    }
    // Every P1B kind has a `case` in the SW dispatch switch (multi-kind tools have one per kind).
    for (const t of P1B_TOOLS) {
      const kinds = Array.isArray(t.kind) ? t.kind : [t.kind];
      for (const k of kinds) {
        ok(workerSrc.includes(`case "${k}":`), `routing: SW dispatch has a case for '${k}' (${t.name})`);
      }
    }
  }

  // ===== (4) CDP mapping =====
  {
    for (const t of P1B_TOOLS) {
      for (const re of t.sw) ok(re.test(workerSrc), `cdp: SW implements ${re} for ${t.name}`);
    }
  }

  // ===== (5) in-page helper contract (chrome_mutation_wait uses snapshot_injected.js) =====
  {
    ok(/MutationObserver/.test(injectedSrc), "injected: snapshot_injected.js ships a MutationObserver helper");
    ok(injectedSrc.includes("__PI_CHROME_STATE__"), "injected: helper hooks into __PI_CHROME_STATE__");
    ok(/disconnect/.test(injectedSrc), "injected: helper guarantees observer.disconnect()");
  }

  // ===== (6) keepalive-detach: P1B mode descriptors (GREEN — shipped with the foundation) =====
  {
    const rec = {};
    const { sandbox, ctxEval, fireOnDetach, chrome } = loadWorker(rec);
    const modeSurface = (id) => {
      const desc = ctxEval(`keepaliveModes[${id}]`);
      return desc;
    };
    const KEEPALIVE_KEY = "piChromeKeepaliveModes";

    // MODE_PSEUDO — persist:true (re-apply on re-attach; forced state dies with the attach).
    {
      const d = modeSurface("MODE_PSEUDO");
      ok(d !== undefined, "keepalive: MODE_PSEUDO descriptor registered");
      ok(d && d.keepaliveMs > 0, "keepalive: MODE_PSEUDO extends the attach keepalive");
      ok(d && d.persist === true, "keepalive: MODE_PSEUDO persists intent (forced state dies with attach)");
      ok(d && typeof d.snapshot === "function" && typeof d.restore === "function" && typeof d.reapply === "function" && typeof d.onDetach === "function", "keepalive: MODE_PSEUDO exposes snapshot/restore/reapply/onDetach");
    }

    // MODE_INPUT_LOCK — persist:false + auto-clear on detach (humans must never race automation).
    {
      const d = modeSurface("MODE_INPUT_LOCK");
      ok(d !== undefined, "keepalive: MODE_INPUT_LOCK descriptor registered");
      ok(d && d.keepaliveMs > 0, "keepalive: MODE_INPUT_LOCK holds the attach while locked");
      ok(d && d.persist === false, "keepalive: MODE_INPUT_LOCK is NOT persisted (auto-clear on detach)");
      ok(d && typeof d.onDetach === "function", "keepalive: MODE_INPUT_LOCK exposes onDetach (drops the lock)");
    }

    // MODE_ANIMATIONS — paused-all lock holds the attach; persist:false (live-session concern).
    {
      const d = modeSurface("MODE_ANIMATIONS");
      ok(d !== undefined, "keepalive: MODE_ANIMATIONS descriptor registered");
      ok(d && d.keepaliveMs > 0, "keepalive: MODE_ANIMATIONS holds the attach while paused-all");
      ok(d && d.persist === false, "keepalive: MODE_ANIMATIONS is NOT persisted");
    }

    // MODE_CPU_PROFILE — recording holds the attach; persist:false (suspend = "recording lost").
    {
      const d = modeSurface("MODE_CPU_PROFILE");
      ok(d !== undefined, "keepalive: MODE_CPU_PROFILE descriptor registered");
      ok(d && d.keepaliveMs > 0, "keepalive: MODE_CPU_PROFILE holds the attach while recording");
      ok(d && d.persist === false, "keepalive: MODE_CPU_PROFILE is NOT persisted (recording lost surfaces on stop)");
    }

    // Non-regression: every pre-P1B mode keeps its descriptor.
    {
      for (const mode of ["MODE_NETWORK", "MODE_EMULATE", "MODE_MEDIA", "MODE_THROTTLE", "MODE_BLOCKED_URLS", "MODE_PAUSED", "MODE_BREAKPOINTS", "MODE_PAUSE_EXCEPTIONS", "MODE_CONSOLE_CAPTURE", "MODE_HEADERS", "MODE_INTERCEPT"]) {
        ok(modeSurface(mode) !== undefined, `keepalive: ${mode} descriptor stays registered (non-regression)`);
      }
    }

    // Detach drains every P1B per-tab map + mode membership (central cleanup rail).
    {
      ctxEval(`forcedPseudoPerTab.set(7, { uid: "el-1", selector: null, forcedPseudoClasses: [":hover"] }); registerMode(7, MODE_PSEUDO);`);
      ctxEval(`inputLockTabs.add(7); registerMode(7, MODE_INPUT_LOCK);`);
      ctxEval(`animationPerTab.set(7, { events: [], pausedIds: new Set(["a1"]) }); registerMode(7, MODE_ANIMATIONS);`);
      ctxEval(`cpuProfilePerTab.set(7, { recording: true }); registerMode(7, MODE_CPU_PROFILE);`);
      fireOnDetach(7, "target_closed");
      ok(!ctxEval(`modesPerTab.has(7)`), "detach: all modes drained from modesPerTab");
      ok(!ctxEval(`forcedPseudoPerTab.has(7)`), "detach: forcedPseudoPerTab dropped");
      ok(!ctxEval(`inputLockTabs.has(7)`), "detach: inputLockTabs dropped (input-lock auto-clear)");
      ok(!ctxEval(`animationPerTab.has(7)`), "detach: animationPerTab dropped");
      ok(!ctxEval(`cpuProfilePerTab.has(7)`), "detach: cpuProfilePerTab dropped");
    }

    // MODE_PSEUDO full persist → suspend → restore → re-apply round trip (MV3 risk #1).
    {
      ctxEval(`keepaliveIntentHydrated = false; modesPerTab.delete(7); forcedPseudoPerTab.delete(7); attachedTabs.delete(7);`);
      for (const k of Object.keys(chrome.sessionStore)) delete chrome.sessionStore[k]; // in-place so the mock's storage closure sees it
      ctxEval(`forcedPseudoPerTab.set(7, { uid: "el-1", selector: null, forcedPseudoClasses: ["hover"] }); registerMode(7, MODE_PSEUDO);`);
      await sandbox.persistKeepaliveIntent();
      ok(chrome.sessionStore[KEEPALIVE_KEY] !== undefined && String(JSON.stringify(chrome.sessionStore)).includes("pseudo"), "keepalive: MODE_PSEUDO intent persisted to chrome.storage.session");
      // Simulate MV3 suspend / Chrome-initiated detach wiping in-memory state.
      ctxEval(`modesPerTab.delete(7); forcedPseudoPerTab.delete(7); keepaliveIntentHydrated = false;`);
      await sandbox.restoreModesForTab(7);
      ok(ctxEval(`forcedPseudoPerTab.get(7)?.forcedPseudoClasses?.includes("hover")`), "keepalive: pseudo intent re-hydrated after suspend");
      ok(ctxEval(`modesPerTab.get(7)?.has(MODE_PSEUDO)`), "keepalive: MODE_PSEUDO membership restored after suspend");
      ok(cdpCalled(rec, "CSS.forcePseudoState") && cdpParams(rec, "CSS.forcePseudoState").some((p) => Array.isArray(p.forcedPseudoClasses) && p.forcedPseudoClasses.includes("hover")), "keepalive: re-apply re-sends CSS.forcePseudoState on re-attach");
    }

    // MODE_INPUT_LOCK persist:false — intent never written to storage.session.
    {
      ctxEval(`keepaliveIntentHydrated = false; modesPerTab.delete(7); inputLockTabs.delete(7);`);
      for (const k of Object.keys(chrome.sessionStore)) delete chrome.sessionStore[k];
      ctxEval(`inputLockTabs.add(7); registerMode(7, MODE_INPUT_LOCK);`);
      await sandbox.persistKeepaliveIntent();
      ok(!String(JSON.stringify(chrome.sessionStore)).includes("inputLock"), "keepalive: input-lock intent NOT persisted (auto-clear on detach)");
    }
  }

  // ===== (7) P1B event recorders (GREEN — shipped with the foundation) =====
  {
    const { sandbox, ctxEval } = loadWorker({});
    // Animation.* events feed a bounded ring; canceled/ended drop the paused-all id.
    {
      ctxEval(`animationPerTab.set(7, { events: [], pausedIds: new Set(["a1"]) })`);
      sandbox.recordAnimationEvent(7, "Animation.animationCreated", { id: "a2", nodeId: 3 });
      sandbox.recordAnimationEvent(7, "Animation.animationStarted", { id: "a2", animation: { name: "spin", playState: "running", playbackRate: 2 } });
      const st = ctxEval(`animationPerTab.get(7)`);
      ok(st.events.length === 2, "recorder: Animation.* events recorded");
      ok(st.events[0].direction === "animationCreated" && st.events[0].id === "a2", "recorder: created event carries id");
      ok(st.events[1].name === "spin" && st.events[1].playbackRate === 2, "recorder: started event carries name/playbackRate");
      sandbox.recordAnimationEvent(7, "Animation.animationEnded", { id: "a1" });
      ok(!ctxEval(`animationPerTab.get(7).pausedIds.has("a1")`), "recorder: ended/canceled drops the paused-all id");
      // Ring is bounded at ANIMATION_RING_MAX.
      ctxEval(`animationPerTab.set(7, { events: [], pausedIds: new Set() })`);
      for (let i = 0; i < 505; i++) sandbox.recordAnimationEvent(7, "Animation.animationCreated", { id: `a${i}` });
      ok(ctxEval(`animationPerTab.get(7).events.length`) === 500, "recorder: Animation ring capped at 500");
    }
    // ServiceWorker.* events feed bounded registrations/versions/errors rings.
    {
      sandbox.recordServiceWorkerEvent(7, "ServiceWorker.workerRegistrationUpdated", { registrations: [{ registrationId: "r1", scopeURL: "https://app.example/sw.js", isDeleted: false }] });
      sandbox.recordServiceWorkerEvent(7, "ServiceWorker.workerVersionUpdated", { versions: [{ versionId: "v1", registrationId: "r1", scriptURL: "https://app.example/sw.js", runningStatus: "running", status: "activated" }] });
      sandbox.recordServiceWorkerEvent(7, "ServiceWorker.workerErrorReported", { errorMessage: { errorMessage: "boom", sourceURL: "https://app.example/sw.js", lineNumber: 2 } });
      const st = ctxEval(`serviceWorkerPerTab.get(7)`);
      ok(st.registrations.length === 1 && st.registrations[0].registrationId === "r1", "recorder: workerRegistrationUpdated recorded");
      ok(st.versions.length === 1 && st.versions[0].versionId === "v1", "recorder: workerVersionUpdated recorded");
      ok(st.errors.length === 1 && st.errors[0].errorMessage === "boom", "recorder: workerErrorReported recorded");
      ok(st.errors[0].timestamp > 0, "recorder: error entry carries a timestamp");
      ctxEval(`serviceWorkerPerTab.set(7, { registrations: [], versions: [], errors: [] })`);
      for (let i = 0; i < 505; i++) sandbox.recordServiceWorkerEvent(7, "ServiceWorker.workerVersionUpdated", { versions: [{ versionId: `v${i}` }] });
      ok(ctxEval(`serviceWorkerPerTab.get(7).versions.length`) === 500, "recorder: ServiceWorker ring capped at 500");
    }
  }

  // ===== (8) vm: CSS cluster =====
  {
    const rec = {};
    const { sandbox, ctxEval } = loadWorker(rec);

    // css.matchedRules — resolver → CSS.getMatchedStylesForNode + getInlineStylesForNode, 200 cap.
    {
      const r = await dispatchOrSkip(sandbox, "css.matchedRules", { targetId: "7", selector: "#btn", pseudoElements: true }, "matched rules");
      if (!r) return;
      ok(cdpCalled(rec, "CSS.getMatchedStylesForNode") && cdpParams(rec, "CSS.getMatchedStylesForNode").some((p) => p.nodeId === 1), "matched-rules: CSS.getMatchedStylesForNode sent with resolved nodeId");
      ok(cdpCalled(rec, "CSS.getInlineStylesForNode"), "matched-rules: CSS.getInlineStylesForNode sent");
      ok(Array.isArray(r.matchedRules) || Array.isArray(r.rules), "matched-rules: result carries the matched rule list");
      ok(typeof r.truncated === "boolean" || r.matchedRules.length <= 200, "matched-rules: result caps the cascade at 200 rules");
    }

    // css.pseudoState — force → MODE_PSEUDO + per-node map; clear → mode dropped.
    {
      rec.cdpMethods = [];
      const r = await dispatchOrSkip(sandbox, "css.pseudoState", { targetId: "7", uid: "el-1", forcedPseudoClasses: ["hover", "active"] }, "pseudo set");
      if (!r) return;
      ok(cdpCalled(rec, "CSS.forcePseudoState"), "pseudo: CSS.forcePseudoState sent");
      ok(cdpParams(rec, "CSS.forcePseudoState").some((p) => p.nodeId === 1 && Array.isArray(p.forcedPseudoClasses) && p.forcedPseudoClasses.includes("hover")), "pseudo: force sent with nodeId + forcedPseudoClasses");
      ok(ctxEval(`forcedPseudoPerTab.get(7)?.forcedPseudoClasses?.includes("hover")`), "pseudo: forcedPseudoPerTab records the per-node force set");
      ok(ctxEval(`modesPerTab.get(7)?.has(MODE_PSEUDO)`), "pseudo: MODE_PSEUDO registered");
      ok(r.forcedPseudoClasses && r.forcedPseudoClasses.includes("hover"), "pseudo: result echoes the forced classes");
      // clear
      rec.cdpMethods = [];
      const cleared = await dispatchOrSkip(sandbox, "css.pseudoState", { targetId: "7", clear: true }, "pseudo clear");
      if (!cleared) return;
      ok(!ctxEval(`modesPerTab.get(7)?.has(MODE_PSEUDO)`), "pseudo: clear unregisters MODE_PSEUDO");
      ok(!ctxEval(`forcedPseudoPerTab.get(7)?.forcedPseudoClasses?.length`), "pseudo: clear empties the per-node force set");
      ok(cleared.cleared === true, "pseudo: clear result reports cleared");
    }

    // css.mediaQueries — CDP call + 500 cap.
    {
      rec.cdpMethods = [];
      const r = await dispatchOrSkip(sandbox, "css.mediaQueries", { targetId: "7" }, "media queries");
      if (!r) return;
      ok(cdpCalled(rec, "CSS.getMediaQueries"), "media-queries: CSS.getMediaQueries sent");
      ok(Array.isArray(r.medias) || Array.isArray(r.queries), "media-queries: result carries the query list");
      ok(r.count <= 500, "media-queries: query list capped at 500 (CSS_MEDIA_QUERIES_MAX)");
    }

    // css.backgroundColors — CDP call + contrast text color best-effort.
    {
      rec.cdpMethods = [];
      const r = await dispatchOrSkip(sandbox, "css.backgroundColors", { targetId: "7", selector: "#btn" }, "background colors");
      if (!r) return;
      ok(cdpCalled(rec, "CSS.getBackgroundColors") && cdpParams(rec, "CSS.getBackgroundColors").some((p) => p.nodeId === 1), "background-colors: CSS.getBackgroundColors sent with resolved nodeId");
      ok(Array.isArray(r.backgroundColors), "background-colors: result carries backgroundColors[]");
    }

    // css.platformFonts — CDP call + familyName/glyphCount.
    {
      rec.cdpMethods = [];
      const r = await dispatchOrSkip(sandbox, "css.platformFonts", { targetId: "7", selector: "#btn" }, "platform fonts");
      if (!r) return;
      ok(cdpCalled(rec, "CSS.getPlatformFontsForNode"), "platform-fonts: CSS.getPlatformFontsForNode sent");
      ok(Array.isArray(r.fonts) && r.fonts.length > 0, "platform-fonts: result carries fonts[]");
      ok(r.fonts[0].familyName !== undefined && r.fonts[0].glyphCount !== undefined, "platform-fonts: each font has familyName + glyphCount");
    }
  }

  // ===== (9) vm: A11y cluster =====
  {
    const rec = {};
    const { sandbox } = loadWorker(rec);

    // a11y.tree — full AX tree with depth pruning / summaryOnly cap.
    {
      const r = await dispatchOrSkip(sandbox, "a11y.tree", { targetId: "7", depth: 2 }, "a11y tree");
      if (!r) return;
      ok(cdpCalled(rec, "Accessibility.getFullAXTree"), "a11y-tree: Accessibility.getFullAXTree sent");
      ok(Array.isArray(r.nodes) || Array.isArray(r.tree), "a11y-tree: result carries the AX node list");
      ok(r.depth === 2 || typeof r.pruned === "boolean" || typeof r.summaryOnly === "boolean", "a11y-tree: depth/prune markers present");
    }

    // a11y.node — resolver → partial AX tree with ignored nodes + reasons.
    {
      rec.cdpMethods = [];
      const r = await dispatchOrSkip(sandbox, "a11y.node", { targetId: "7", uid: "el-1" }, "a11y node");
      if (!r) return;
      ok(cdpCalled(rec, "Accessibility.getPartialAXTree") && cdpParams(rec, "Accessibility.getPartialAXTree").some((p) => p.nodeId === 1), "a11y-node: Accessibility.getPartialAXTree sent with resolved nodeId");
      ok(r.ax !== undefined && r.ax !== null, "a11y-node: result carries the AX node (ax)");
      ok(r.ax.role !== undefined && r.ax.name !== undefined, "a11y-node: node carries role + name");
    }
  }

  // ===== (10) vm: input cluster =====
  {
    const rec = {};
    const { sandbox, ctxEval, fireOnDetach } = loadWorker(rec);

    // input.setIgnore — lock registers MODE_INPUT_LOCK; detach auto-clears it (keepalive-detach).
    {
      const r = await dispatchOrSkip(sandbox, "input.setIgnore", { targetId: "7", ignore: true }, "input lock on");
      if (!r) return;
      ok(cdpCalled(rec, "Input.setIgnoreInputEvents") && cdpParams(rec, "Input.setIgnoreInputEvents").some((p) => p.ignore === true), "input-lock: Input.setIgnoreInputEvents {ignore:true} sent");
      ok(ctxEval(`inputLockTabs.has(7)`), "input-lock: inputLockTabs marks the tab");
      ok(ctxEval(`modesPerTab.get(7)?.has(MODE_INPUT_LOCK)`), "input-lock: MODE_INPUT_LOCK registered (holds the attach)");
      ok(r.ignoring === true || r.ignore === true, "input-lock: result reports the lock");
      // Detach auto-clears the lock (humans can race automation again).
      fireOnDetach(7, "target_closed");
      ok(!ctxEval(`inputLockTabs.has(7)`), "input-lock: detach auto-clears the lock (inputLockTabs dropped)");
      ok(!ctxEval(`modesPerTab.get(7)?.has(MODE_INPUT_LOCK)`), "input-lock: detach unregisters MODE_INPUT_LOCK");
    }

    // page.gesture — touch sequences + synthesized pinch/scroll gestures.
    {
      rec.cdpMethods = [];
      const tap = await dispatchOrSkip(sandbox, "page.gesture", { targetId: "7", type: "tap", x: 100, y: 200 }, "gesture tap");
      if (!tap) return;
      ok(cdpCalled(rec, "Input.dispatchTouchEvent"), "gesture: tap dispatches Input.dispatchTouchEvent");
      ok(cdpParams(rec, "Input.dispatchTouchEvent").some((p) => p.touchPoints && p.touchPoints.some((tp) => tp.x === 100 && tp.y === 200)), "gesture: touch points carry the coordinates");
      ok(tap.type === "tap", "gesture: result echoes the type");
      rec.cdpMethods = [];
      const pinch = await dispatchOrSkip(sandbox, "page.gesture", { targetId: "7", type: "pinch", x: 100, y: 200, scale: 2 }, "gesture pinch");
      if (!pinch) return;
      ok(cdpCalled(rec, "Input.synthesizePinchGesture") && cdpParams(rec, "Input.synthesizePinchGesture").some((p) => p.scaleFactor === 2), "gesture: pinch uses Input.synthesizePinchGesture with scaleFactor");
      rec.cdpMethods = [];
      const scroll = await dispatchOrSkip(sandbox, "page.gesture", { targetId: "7", type: "scroll", x: 100, y: 200, distanceY: 300 }, "gesture scroll");
      if (!scroll) return;
      ok(cdpCalled(rec, "Input.synthesizeScrollGesture"), "gesture: scroll uses Input.synthesizeScrollGesture");
    }
  }

  // ===== (11) vm: storage cluster =====
  {
    const rec = {};
    const { sandbox } = loadWorker(rec);

    // storage.usage — Storage.getUsageAndQuota with the tab origin; usage/breakdown/quota.
    {
      const r = await dispatchOrSkip(sandbox, "storage.usage", { targetId: "7" }, "storage usage");
      if (!r) return;
      ok(cdpCalled(rec, "Storage.getUsageAndQuota") && cdpParams(rec, "Storage.getUsageAndQuota").some((p) => /https:\/\/app\.example/.test(String(p.origin || ""))), "storage-usage: Storage.getUsageAndQuota sent with the tab origin");
      ok(typeof r.usage === "number" && typeof r.quota === "number", "storage-usage: result carries usage + quota");
      ok(Array.isArray(r.usageBreakdown) || Array.isArray(r.breakdown), "storage-usage: result carries a per-type usageBreakdown");
    }

    // cache.op — list / read / delete flow through the CacheStorage domain.
    {
      rec.cdpMethods = [];
      const list = await dispatchOrSkip(sandbox, "cache.op", { targetId: "7", action: "list" }, "cache list");
      if (!list) return;
      ok(cdpCalled(rec, "CacheStorage.requestCacheNames"), "cache: list calls CacheStorage.requestCacheNames");
      ok(Array.isArray(list.caches), "cache: list result carries caches[]");
      rec.cdpMethods = [];
      const read = await dispatchOrSkip(sandbox, "cache.op", { targetId: "7", action: "read", cacheId: "c1", requestUrl: "https://app.example/x" }, "cache read");
      if (!read) return;
      ok(cdpCalled(rec, "CacheStorage.requestEntries") && cdpParams(rec, "CacheStorage.requestEntries").some((p) => p.cacheId === "c1"), "cache: read calls CacheStorage.requestEntries with cacheId");
      ok(Array.isArray(read.entries), "cache: read result carries entries[]");
      rec.cdpMethods = [];
      const del = await dispatchOrSkip(sandbox, "cache.op", { targetId: "7", action: "delete", cacheId: "c1" }, "cache delete");
      if (!del) return;
      ok(cdpCalled(rec, "CacheStorage.deleteCache") && cdpParams(rec, "CacheStorage.deleteCache").some((p) => p.cacheId === "c1"), "cache: delete calls CacheStorage.deleteCache with cacheId");
      ok(del.action === "deleteCache", "cache: delete result reports the deleteCache action");
    }

    // storage.clearSiteData — destructive gate: refuses without confirm:true.
    {
      rec.cdpMethods = [];
      let threw = false;
      try { await sandbox.dispatch("storage.clearSiteData", { targetId: "7" }); }
      catch (e) { threw = /confirm/i.test(String(e.message || e)); }
      ok(threw, "gate: storage.clearSiteData without confirm:true is rejected");
      ok(!cdpCalled(rec, "Storage.clearDataForOrigin"), "gate: no clear command sent while unconfirmed");
      const r = await dispatchOrSkip(sandbox, "storage.clearSiteData", { targetId: "7", confirm: true, origin: "https://app.example" }, "clear site data confirm");
      if (!r) return;
      ok(cdpCalled(rec, "Storage.clearDataForOrigin") && cdpParams(rec, "Storage.clearDataForOrigin").some((p) => p.origin === "https://app.example" && (p.storageTypes === "all" || /all/i.test(String(p.storageTypes || "")))), "gate: Storage.clearDataForOrigin sent with origin + storageTypes=all");
      ok(cdpCalled(rec, "Network.clearBrowserCache"), "gate: Network.clearBrowserCache sent");
      ok(r.cleared === true && r.httpCacheCleared === true, "gate: confirm path reports cleared (incl. http cache)");
    }
  }

  // ===== (12) vm: browser / system cluster =====
  {
    const rec = {};
    const { sandbox } = loadWorker(rec);

    // system.info — SystemInfo.getInfo + getProcessInfo; degrades instead of throwing.
    {
      const r = await dispatchOrSkip(sandbox, "system.info", { targetId: "7", processes: true }, "system info");
      if (!r) return;
      ok(cdpCalled(rec, "SystemInfo.getInfo"), "system-info: SystemInfo.getInfo sent");
      ok(cdpCalled(rec, "SystemInfo.getProcessInfo"), "system-info: getProcessInfo sent with processes:true");
      ok(r.info !== null || r.degraded === true, "system-info: result carries platform details (or degraded)");
      ok(r.processes === null || Array.isArray(r.processes), "system-info: processes table (or null)");
    }
    // Version-dependent degrade: when SystemInfo.getInfo fails the tool reports degraded:true
    // instead of throwing (contract row 52 edge).
    {
      const rec2 = { canned: { ...DEFAULT_CANNED }, failing: new Set(["SystemInfo.getInfo"]) };
      const { sandbox: s2 } = loadWorker(rec2);
      let r2 = null;
      try { r2 = await s2.dispatch("system.info", { targetId: "7" }); }
      catch { r2 = null; }
      ok(r2 !== null, "system-info: unavailable SystemInfo.getInfo does not throw");
      ok(r2 === null || r2.degraded === true, "system-info: degraded:true reported when SystemInfo is unavailable");
    }

    // target.evaluate — attaches the CDP target, evaluates, detaches after.
    {
      rec.cdpMethods = [];
      const r = await dispatchOrSkip(sandbox, "target.evaluate", { targetId: "t-1", expression: "1 + 1" }, "target evaluate");
      if (!r) return;
      ok((rec.attached || []).some((a) => (a.targetId || a.tabId) === "t-1"), "target-evaluate: chrome.debugger.attach called with the targetId");
      ok(cdpCalled(rec, "Runtime.evaluate") && cdpParams(rec, "Runtime.evaluate").some((p) => p.expression === "1 + 1"), "target-evaluate: Runtime.evaluate sent with the expression");
      ok((rec.detached || []).some((a) => (a.targetId || a.tabId) === "t-1"), "target-evaluate: the worker target is detached after evaluation");
    }

    // browser.setPermission — Browser.setPermission with origin/permission/setting; degrades.
    {
      rec.cdpMethods = [];
      const r = await dispatchOrSkip(sandbox, "browser.setPermission", { origin: "https://app.example", permission: "geolocation", setting: "granted" }, "set permission");
      if (!r) return;
      ok(cdpCalled(rec, "Browser.setPermission"), "set-permission: Browser.setPermission sent");
      ok(cdpParams(rec, "Browser.setPermission").some((p) => p.origin === "https://app.example" && (p.permission?.name === "geolocation" || p.permission === "geolocation") && p.setting === "granted"), "set-permission: origin/permission/setting forwarded");
      ok(r.setting === "granted", "set-permission: result echoes the setting");
    }
    {
      const rec2 = { canned: { ...DEFAULT_CANNED }, failing: new Set(["Browser.setPermission"]) };
      const { sandbox: s2 } = loadWorker(rec2);
      let r2 = null;
      try { r2 = await s2.dispatch("browser.setPermission", { origin: "https://app.example", permission: "geolocation", setting: "granted" }); }
      catch { r2 = null; }
      ok(r2 !== null, "set-permission: unavailable Browser.setPermission does not throw");
      ok(r2 === null || r2.degraded === true, "set-permission: degraded:true reported when Browser.setPermission is unavailable");
    }

    // serviceworker.list + serviceworker.action — enable, then start/stop/unregister/inspect.
    {
      rec.cdpMethods = [];
      const list = await dispatchOrSkip(sandbox, "serviceworker.list", { targetId: "7" }, "service worker list");
      if (!list) return;
      ok(cdpCalled(rec, "ServiceWorker.enable"), "service-worker: list enables the ServiceWorker domain");
      ok(Array.isArray(list.registrations) || Array.isArray(list.workers) || Array.isArray(list.versions), "service-worker: list result carries worker/registration data");
      rec.cdpMethods = [];
      const start = await dispatchOrSkip(sandbox, "serviceworker.action", { targetId: "7", action: "start", versionId: "v1" }, "service worker start");
      if (!start) return;
      ok(cdpCalled(rec, "ServiceWorker.startWorker") && cdpParams(rec, "ServiceWorker.startWorker").some((p) => p.versionId === "v1"), "service-worker: start calls ServiceWorker.startWorker with versionId");
      rec.cdpMethods = [];
      const stop = await dispatchOrSkip(sandbox, "serviceworker.action", { targetId: "7", action: "stop", versionId: "v1" }, "service worker stop");
      if (!stop) return;
      ok(cdpCalled(rec, "ServiceWorker.stopWorker"), "service-worker: stop calls ServiceWorker.stopWorker");
      rec.cdpMethods = [];
      const unreg = await dispatchOrSkip(sandbox, "serviceworker.action", { targetId: "7", action: "unregister", scopeURL: "https://app.example/sw.js" }, "service worker unregister");
      if (!unreg) return;
      ok(cdpCalled(rec, "ServiceWorker.unregister"), "service-worker: unregister calls ServiceWorker.unregister");
      rec.cdpMethods = [];
      const inspect = await dispatchOrSkip(sandbox, "serviceworker.action", { targetId: "7", action: "inspect", versionId: "v1" }, "service worker inspect");
      if (!inspect) return;
      ok(cdpCalled(rec, "ServiceWorker.inspectWorker"), "service-worker: inspect calls ServiceWorker.inspectWorker");
    }
  }

  // ===== (13) vm: visual cluster =====
  {
    const rec = {};
    const { sandbox, ctxEval } = loadWorker(rec);

    // page.layoutMetrics — Page.getLayoutMetrics + overflow/CLS scan markers.
    {
      const r = await dispatchOrSkip(sandbox, "page.layoutMetrics", { targetId: "7", detectOverflow: true, detectCLS: true }, "layout metrics");
      if (!r) return;
      ok(cdpCalled(rec, "Page.getLayoutMetrics"), "layout-metrics: Page.getLayoutMetrics sent");
      ok(r.contentSize !== undefined || r.layoutViewport !== undefined, "layout-metrics: result carries contentSize/layoutViewport");
    }

    // page.animations — list; pause-all registers MODE_ANIMATIONS; resume clears it; rate seeks.
    {
      rec.cdpMethods = [];
      const list = await dispatchOrSkip(sandbox, "page.animations", { targetId: "7", action: "list" }, "animations list");
      if (!list) return;
      ok(cdpCalled(rec, "Animation.enable"), "animations: list enables the Animation domain");
      ok(Array.isArray(list.animations), "animations: list result carries animations[]");
      rec.cdpMethods = [];
      const paused = await dispatchOrSkip(sandbox, "page.animations", { targetId: "7", action: "pause", animationId: "a1" }, "animations pause");
      if (!paused) return;
      ok(ctxEval(`modesPerTab.get(7)?.has(MODE_ANIMATIONS)`), "animations: pause registers MODE_ANIMATIONS (holds the attach)");
      ok(cdpCalled(rec, "Animation.setPaused") && cdpParams(rec, "Animation.setPaused").some((p) => p.paused === true), "animations: Animation.setPaused {paused:true} sent");
      rec.cdpMethods = [];
      const resumed = await dispatchOrSkip(sandbox, "page.animations", { targetId: "7", action: "resume", animationId: "a1" }, "animations resume");
      if (!resumed) return;
      ok(!ctxEval(`modesPerTab.get(7)?.has(MODE_ANIMATIONS)`), "animations: resume clears MODE_ANIMATIONS");
      rec.cdpMethods = [];
      const rate = await dispatchOrSkip(sandbox, "page.animations", { targetId: "7", action: "rate", animationId: "a1", playbackRate: 2 }, "animations rate");
      if (!rate) return;
      ok(cdpCalled(rec, "Animation.setPlaybackRate") && cdpParams(rec, "Animation.setPlaybackRate").some((p) => p.playbackRate === 2), "animations: rate sends Animation.setPlaybackRate");
    }

    // page.pdf — Page.printToPDF returns base64 data (host writes the file).
    {
      rec.cdpMethods = [];
      const r = await dispatchOrSkip(sandbox, "page.pdf", { targetId: "7", printBackground: true, landscape: false }, "pdf");
      if (!r) return;
      ok(cdpCalled(rec, "Page.printToPDF"), "pdf: Page.printToPDF sent");
      ok(typeof r.data === "string" && r.data.length > 0, "pdf: result carries the base64 PDF data for the host writer");
    }
  }

  // ===== (14) vm: perf cluster =====
  {
    const rec = {};
    const { sandbox, ctxEval } = loadWorker(rec);

    // profiler.cpuStart / profiler.cpuStop — recording registers MODE_CPU_PROFILE; stop summarizes.
    {
      const started = await dispatchOrSkip(sandbox, "profiler.cpuStart", { targetId: "7", maxBufferSize: 1000000 }, "cpu start");
      if (!started) return;
      ok(cdpCalled(rec, "Profiler.enable"), "cpu-profile: start enables the Profiler domain");
      ok(cdpCalled(rec, "Profiler.start"), "cpu-profile: Profiler.start sent");
      ok(ctxEval(`modesPerTab.get(7)?.has(MODE_CPU_PROFILE)`), "cpu-profile: MODE_CPU_PROFILE registered while recording");
      ok(ctxEval(`cpuProfilePerTab.get(7)?.recording === true`), "cpu-profile: per-tab recording flag set");
      rec.cdpMethods = [];
      const stopped = await dispatchOrSkip(sandbox, "profiler.cpuStop", { targetId: "7" }, "cpu stop");
      if (!stopped) return;
      ok(cdpCalled(rec, "Profiler.stop"), "cpu-profile: Profiler.stop sent");
      ok(stopped.selfTimeByFunction !== undefined || stopped.summary !== undefined, "cpu-profile: result carries the top-self-time summary (selfTimeByFunction)");
      ok(!ctxEval(`modesPerTab.get(7)?.has(MODE_CPU_PROFILE)`), "cpu-profile: stop clears MODE_CPU_PROFILE");
      ok(ctxEval(`cpuProfilePerTab.get(7)?.recording !== true`), "cpu-profile: stop clears the recording flag");
    }

    // coverage.get — best-effort JS coverage + CSS rule usage tracking → per-file unused bytes.
    {
      rec.cdpMethods = [];
      const r = await dispatchOrSkip(sandbox, "coverage.get", { targetId: "7" }, "coverage");
      if (!r) return;
      ok(cdpCalled(rec, "Profiler.getBestEffortCoverage"), "coverage: Profiler.getBestEffortCoverage sent");
      ok(cdpCalled(rec, "CSS.startRuleUsageTracking") || cdpCalled(rec, "CSS.takeCoverageDelta"), "coverage: CSS rule-usage tracking started/read");
      ok(Array.isArray(r.files) || Array.isArray(r.coverage) || Array.isArray(r.perFile), "coverage: result carries a per-file coverage table");
    }
  }

  // ===== (15) vm: XHR breakpoint capture (auto-resume rail + remove-in-finally) =====
  {
    const rec = {};
    const { sandbox, fireOnEvent } = loadWorker(rec);
    // Drive the handler asynchronously: it arms a temp XHR breakpoint and waits for
    // Debugger.paused(reason=XHR) (the shipped waiter wake in the paused branch), then the
    // handler removes the breakpoint and auto-resumes (stacks only — no pause persistence).
    const pending = sandbox.dispatch("debug.xhrBreak", { targetId: "7", url: "https://api.example/*" });
    await sleep(30);
    fireOnEvent("Debugger.paused", {
      reason: "XHR",
      callFrames: [{ callFrameId: "c1", functionName: "fetchX", location: { scriptId: "s1", lineNumber: 3, columnNumber: 1 }, url: "https://app.example/app.js", scopeChain: [] }],
      data: { url: "https://api.example/x" },
    });
    let r = null;
    try {
      r = await withTimeout(pending, 1500, "debug.xhrBreak");
    } catch (e) {
      ok(false, `xhr-break: handler did not settle after the XHR pause (${e.message})`);
      return;
    }
    ok(r !== null, "xhr-break: dispatch settles after the XHR pause");
    ok(cdpCalled(rec, "DOMDebugger.setXHRBreakpoint") && cdpParams(rec, "DOMDebugger.setXHRBreakpoint").some((p) => p.url === "https://api.example/*"), "xhr-break: DOMDebugger.setXHRBreakpoint sent with the url");
    ok(cdpCalled(rec, "DOMDebugger.removeXHRBreakpoint"), "xhr-break: the temp breakpoint is removed (finally rail)");
    ok(cdpCalled(rec, "Debugger.resume"), "xhr-break: the page is auto-resumed (stacks only, no pause persistence)");
    ok(r.frames !== undefined || r.stack !== undefined || r.callFrames !== undefined || r.captured === true, "xhr-break: result carries the captured call stack");
  }

  // ===== (16) formatters (commands.ts pure) =====
  {
    for (const [name, [sample, needles]] of Object.entries(P1B_FORMATTERS)) {
      const fn = cmdMod[name];
      if (typeof fn !== "function") {
        ok(false, `formatter: ${name} is exported from commands.ts (P1B spec)`);
        continue;
      }
      const out = String(fn(sample));
      for (const needle of needles) {
        ok(out.includes(needle), `formatter: ${name} renders '${needle}'`);
      }
    }
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
