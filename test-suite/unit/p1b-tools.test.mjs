// P1B-batch harness (test-p1b): CSS/A11y + input/events + storage/system/visual/perf.
//
// Pins the P1B tool surface of tasks/impl/TOOL_CONTRACTS.md §6 rows 22-27, 43, 45-59 against the
// REAL shipped sources (source-level for index.ts, vm-load for service_worker.js, type-stripped
// import for commands.ts):
//   (1) catalog consistency — every P1B CHROME_TOOL_NAMES entry has a pi.registerTool block
//   (2) schema surface — distinguishing inputs present per tool
//   (3) wire routing — every P1B kind has a `case` in the SW dispatch switch; tools route via
//       authorizedBridgeSend
//   (4) CDP mapping — the SW implements the contract CDP methods/events
//   (5) safety rails — keepalive modes (pseudo/inputLock/animations/cpuProfile) registered;
//       XHR-break capture removes the breakpoint + auto-resumes; clear-site-data gate; input-lock
//       auto-clear on detach; CPU profile summary-first; coverage tables capped
//   (6) pure helpers — summarizeCpuProfile / buildCoverageTables / normalizeAxNode /
//       cssStyleProperties / axValueText / formatters (commands.ts)

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

// ---- P1B catalog fixture (TOOL_CONTRACTS.md §6 rows 22-27, 43, 45-59) ----------------------
// params: distinguishing schema keys that MUST appear in the tool's parameters Type.Object.
// sw: contract CDP methods/events the SW MUST implement (searched in service_worker.js).
const P1B_TOOLS = [
  { name: "chrome_matched_css_rules", kind: "css.matchedRules", params: ["uid", "selector"], sw: [/CSS\.getMatchedStylesForNode/, /CSS\.getInlineStylesForNode/, /CSS_MATCHED_RULES_MAX/] },
  { name: "chrome_force_pseudo_state", kind: "css.pseudoState", params: ["forcedPseudoClasses", "clear"], sw: [/CSS\.forcePseudoState/, /MODE_PSEUDO/, /PSEUDO_CLASS_VALUES/] },
  { name: "chrome_media_queries", kind: "css.mediaQueries", params: [], sw: [/CSS\.getMediaQueries/, /CSS_MEDIA_QUERIES_MAX/] },
  { name: "chrome_background_colors", kind: "css.backgroundColors", params: ["uid", "selector"], sw: [/CSS\.getBackgroundColors/] },
  { name: "chrome_platform_fonts", kind: "css.platformFonts", params: ["uid", "selector"], sw: [/CSS\.getPlatformFontsForNode/] },
  { name: "chrome_a11y_tree", kind: "a11y.tree", params: ["depth"], sw: [/Accessibility\.getFullAXTree/, /AX_TREE_MAX_NODES/, /AX_TREE_DEPTH_MAX/] },
  { name: "chrome_a11y_node", kind: "a11y.node", params: ["uid", "selector"], sw: [/Accessibility\.getPartialAXTree/] },
  { name: "chrome_mutation_wait", kind: "page.mutationWait", params: ["attributeFilter", "childList", "timeoutMs"], sw: [/__piChromeWaitForMutation/, /MUTATION_WAIT_MAX_MS/] },
  { name: "chrome_capture_fetch_stack", kind: "debug.xhrBreak", params: ["url", "timeoutMs"], sw: [/DOMDebugger\.setXHRBreakpoint/, /DOMDebugger\.removeXHRBreakpoint/, /xhrBreakWaiters/, /XHR_BREAK_MAX_WAIT_MS/] },
  { name: "chrome_input_lock", kind: "input.setIgnore", params: ["ignore"], sw: [/Input\.setIgnoreInputEvents/, /MODE_INPUT_LOCK/] },
  { name: "chrome_touch_gesture", kind: "page.gesture", params: ["type", "points", "scale"], sw: [/Input\.dispatchTouchEvent/, /Input\.synthesizePinchGesture/, /Input\.synthesizeScrollGesture/] },
  { name: "chrome_storage_usage", kind: "storage.usage", params: ["origin"], sw: [/Storage\.getUsageAndQuota/] },
  { name: "chrome_cache_storage", kind: "cache.op", params: ["action", "cacheId", "requestUrl"], sw: [/CacheStorage\.requestCacheNames/, /CacheStorage\.requestEntries/, /CacheStorage\.deleteCache/, /CacheStorage\.deleteEntry/, /CACHE_STORAGE_ENTRIES_MAX/] },
  { name: "chrome_clear_site_data", kind: "storage.clearSiteData", params: ["confirm", "origin"], sw: [/Storage\.clearDataForOrigin/, /Network\.clearBrowserCache/] },
  { name: "chrome_service_worker", kind: "serviceworker", params: ["action", "versionId", "scopeURL"], sw: [/ServiceWorker\.startWorker/, /ServiceWorker\.stopWorker/, /ServiceWorker\.unregister/, /ServiceWorker\.inspectWorker/, /SERVICE_WORKER_RING_MAX/] },
  { name: "chrome_system_info", kind: "system.info", params: ["processes"], sw: [/SystemInfo\.getInfo/, /SystemInfo\.getProcessInfo/] },
  { name: "chrome_target_evaluate", kind: "target.evaluate", params: ["targetId", "expression"], sw: [/attachedTargets/, /TARGET_EVAL_ATTACH_TIMEOUT_MS/] },
  { name: "chrome_set_permission", kind: "browser.setPermission", params: ["origin", "permission", "setting"], sw: [/Browser\.setPermission/] },
  { name: "chrome_layout_metrics", kind: "page.layoutMetrics", params: [], sw: [/Page\.getLayoutMetrics/] },
  { name: "chrome_animations", kind: "page.animations", params: ["action", "animationId", "playbackRate"], sw: [/Animation\.setPaused/, /Animation\.seekAnimations/, /Animation\.setPlaybackRate/, /MODE_ANIMATIONS/] },
  { name: "chrome_pdf", kind: "page.pdf", params: ["path", "landscape", "paperWidth", "pageRanges"], sw: [/Page\.printToPDF/, /PDF_MAX_BASE64_CHARS/, /PRINT_TO_PDF_TIMEOUT_MS/] },
  { name: "chrome_cpu_profile", kind: "profiler.cpuStart", params: ["action", "samplingInterval"], sw: [/Profiler\.start/, /Profiler\.stop/, /MODE_CPU_PROFILE/, /summarizeCpuProfile/, /CPU_PROFILE_INLINE_MAX_CHARS/] },
  { name: "chrome_coverage", kind: "coverage.get", params: [], sw: [/Profiler\.getBestEffortCoverage/, /CSS\.startRuleUsageTracking/, /CSS\.takeCoverageDelta/, /buildCoverageTables/, /COVERAGE_MAX_FILES/] },
];

// ---- String-aware brace matching (same helper as p0/p1a harnesses) -------------------------
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

// Load the real shipped commands.ts once via node's type stripping (same as p0/p1a).
const cmdJs = stripTypeScriptTypes(fs.readFileSync(commandsPath, "utf8"), { mode: "strip" });
const cmdMod = await import("data:text/javascript;base64," + Buffer.from(cmdJs).toString("base64"));

// ---- VM harness (real SW, controllable chrome.* mock + fake timers) ------------------------
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
  return { sandbox, ctxEval, timers, fireTimer };
}

await run();

async function run() {
  // ===== (1) catalog consistency =====
  {
    for (const t of P1B_TOOLS) {
      ok(toolNames.includes(t.name), `catalog: ${t.name} is listed in CHROME_TOOL_NAMES`);
      ok(blocksByName.has(t.name), `catalog: ${t.name} has a pi.registerTool block`);
    }
    const registeredNames = new Set(toolBlocks.map((b) => b.name));
    for (const name of toolNames) ok(registeredNames.has(name), `catalog: every CHROME_TOOL_NAMES entry has a matching registerTool block (${name})`);
  }

  // ===== (2) schema surface =====
  {
    for (const t of P1B_TOOLS) {
      const block = blocksByName.get(t.name);
      if (!block) continue;
      const paramsSection = extractParameters(block);
      for (const marker of t.params) ok(paramsSection.includes(marker), `schema: ${t.name} parameters list '${marker}'`);
      // Shared tab-resolution params stay on every P1B tool.
      ok(paramsSection.includes("targetId"), `schema: ${t.name} keeps targetId tab-resolution param`);
      ok(paramsSection.includes("background"), `schema: ${t.name} keeps background tab-resolution param`);
    }
  }

  // ===== (3) wire routing =====
  {
    for (const t of P1B_TOOLS) {
      const block = blocksByName.get(t.name);
      if (!block) continue;
      if (t.kind === "serviceworker") {
        ok(block.includes('"serviceworker.list"') && block.includes('"serviceworker.action"'), `routing: ${t.name} routes list vs action kinds`);
      } else if (t.kind === "profiler.cpuStart") {
        ok(block.includes('"profiler.cpuStart"') && block.includes('"profiler.cpuStop"'), `routing: ${t.name} routes cpuStart vs cpuStop kinds`);
      } else {
        ok(block.includes(`authorizedBridgeSend("${t.kind}"`), `routing: ${t.name} sends kind '${t.kind}' via authorizedBridgeSend`);
      }
      ok(!block.includes("bridge.send("), `routing: ${t.name} never bypasses authorization with a raw bridge.send`);
    }
    const expectedCases = [
      "css.matchedRules", "css.pseudoState", "css.mediaQueries", "css.backgroundColors", "css.platformFonts",
      "a11y.tree", "a11y.node", "page.mutationWait", "debug.xhrBreak", "input.setIgnore", "page.gesture",
      "storage.usage", "cache.op", "storage.clearSiteData", "serviceworker.list", "serviceworker.action",
      "system.info", "target.evaluate", "browser.setPermission", "page.layoutMetrics", "page.animations",
      "page.pdf", "profiler.cpuStart", "profiler.cpuStop", "coverage.get",
    ];
    for (const kind of expectedCases) {
      ok(workerSrc.includes(`case "${kind}":`), `routing: SW dispatch has a case for '${kind}'`);
    }
  }

  // ===== (4) CDP mapping =====
  {
    for (const t of P1B_TOOLS) {
      for (const re of t.sw) ok(re.test(workerSrc), `cdp: SW implements ${re} for ${t.name}`);
    }
    // snapshot_injected exposes the mutation helper the SW calls.
    ok(injectedSrc.includes("__piChromeWaitForMutation"), "cdp: snapshot_injected.js exposes __piChromeWaitForMutation");
  }

  // ===== (5) vm safety rails =====
  {
    const rec = {};
    const { sandbox, ctxEval, timers, fireTimer } = loadWorker(rec);

    // 5a. keepalive registry carries the new modes with the right persist flags.
    {
      const modes = ctxEval("keepaliveModes");
      ok(!!modes.pseudo, "rails: keepaliveModes.pseudo registered");
      ok(modes.pseudo.persist === true, "rails: MODE_PSEUDO persists (re-applies on re-attach)");
      ok(!!modes.inputLock, "rails: keepaliveModes.inputLock registered");
      ok(modes.inputLock.persist === false, "rails: MODE_INPUT_LOCK is session-scoped (auto-clear on detach)");
      ok(!!modes.animations, "rails: keepaliveModes.animations registered");
      ok(!!modes.cpuProfile, "rails: keepaliveModes.cpuProfile registered");
      ok(typeof modes.pseudo.onDetach === "function", "rails: MODE_PSEUDO clears on detach");
      ok(typeof modes.inputLock.onDetach === "function", "rails: MODE_INPUT_LOCK clears on detach");
    }

    // 5b. clear-site-data gate: no confirm / no origin → throws before any CDP call.
    {
      let threw = false;
      try { await ctxEval(`chromeClearSiteData({ targetId: 7, origin: "" })`); } catch { threw = true; }
      ok(threw, "rails: chrome_clear_site_data refuses without confirm/origin");
      rec.cdpMethods = [];
      try { await ctxEval(`chromeClearSiteData({ targetId: 7, origin: "https://example.com", confirm: true })`); } catch {}
      const methods = (rec.cdpMethods || []).map((m) => m.method);
      ok(methods.includes("Storage.clearDataForOrigin"), "rails: confirm+origin clears via Storage.clearDataForOrigin");
    }

    // 5c. cpu profile: stop without start → clear error; summarizeCpuProfile caps rows + computes self-time.
    {
      let threw = false;
      try { await ctxEval(`chromeCpuProfile({ targetId: 7, action: "stop" })`); } catch { threw = true; }
      ok(threw, "rails: chrome_cpu_profile stop without start errors");
      const profile = {
        startTime: 0, endTime: 10000,
        nodes: [
          { id: 1, callFrame: { functionName: "a", url: "a.js", lineNumber: 1, columnNumber: 2 } },
          { id: 2, callFrame: { functionName: "b", url: "b.js", lineNumber: 3, columnNumber: 4 } },
          { id: 3, callFrame: { functionName: "c", url: "c.js", lineNumber: 5, columnNumber: 6 } },
        ],
        samples: [1, 2, 2, 3, 3, 3],
        timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000],
      };
      const summary = sandbox.summarizeCpuProfile(profile, 2);
      ok(summary.selfTimeByFunction.length === 2, "rails: summarizeCpuProfile caps rows at maxFrames");
      const top = summary.selfTimeByFunction[0];
      ok(top.functionName === "c" && top.selfTimeUs === 3000, "rails: summarizeCpuProfile computes top self-time (c=3000us)");
      ok(summary.totalTimeUs === 6000 && summary.sampleCount === 6, "rails: summarizeCpuProfile totals samples/time");
    }

    // 5d. coverage tables: unused-byte aggregation across JS + CSS, sorted, capped.
    {
      const js = { result: [
        { url: "app.js", functions: [
          { functionName: "used", ranges: [{ startOffset: 0, endOffset: 100, count: 3 }] },
          { functionName: "dead", ranges: [{ startOffset: 100, endOffset: 300, count: 0 }] },
        ] },
      ] };
      const css = { coverage: [
        { url: "app.js", startOffset: 0, endOffset: 50, used: true },
        { url: "style.css", startOffset: 0, endOffset: 500, used: false },
      ] };
      const tables = sandbox.buildCoverageTables(js, css, 10);
      const app = tables.find((f) => f.url === "app.js");
      const cssFile = tables.find((f) => f.url === "style.css");
      ok(app.kind === "js" && app.unusedBytes === 200 && app.usedBytes === 150 && app.totalBytes === 350, "rails: buildCoverageTables aggregates JS ranges into used/unused bytes");
      ok(cssFile.kind === "css" && cssFile.unusedBytes === 500, "rails: buildCoverageTables counts unused CSS rule bytes");
      ok(tables[0].url === "style.css", "rails: buildCoverageTables sorts by unused bytes descending");
      const capped = sandbox.buildCoverageTables(js, css, 1);
      ok(capped.length === 1, "rails: buildCoverageTables honors maxFiles cap");
    }

    // 5e. AX normalization + summary.
    {
      const raw = { nodeId: "n1", ignored: false, role: { value: "button", type: "string" }, name: { value: "Submit" }, childIds: ["n2", "n3"], properties: [{ name: "focusable", value: { value: true, type: "boolean" } }] };
      const node = sandbox.normalizeAxNode(raw, 2);
      ok(node.role === "button" && node.name === "Submit" && node.childIds.length === 2, "rails: normalizeAxNode keeps role/name/childIds within depth");
      const pruned = sandbox.normalizeAxNode(raw, 0);
      ok(pruned.childIds.length === 0, "rails: normalizeAxNode prunes childIds beyond depth");
      const summary = sandbox.buildAxTreeSummary([node, { nodeId: "x", ignored: true, role: "generic" }], 10);
      ok(summary.total === 2 && summary.ignored === 1, "rails: buildAxTreeSummary counts total + ignored");
    }

    // 5f. XHR break waiter wiring: Debugger.paused with reason XHR resolves the waiter.
    {
      const p = ctxEval(`(async () => {
        let resolveFn = null;
        const w = new Promise((r) => { resolveFn = r; });
        xhrBreakWaiters.set(7, { resolve: resolveFn, reject: () => {}, timer: null, url: "*" });
        return w;
      })()`);
      if (rec.onEventListener) {
        rec.onEventListener({ tabId: 7 }, "Debugger.paused", {
          reason: "XHR",
          callFrames: [{ callFrameId: "f0", functionName: "doFetch", url: "app.js", lineNumber: 9, columnNumber: 1, scopeChain: [] }],
        });
      }
      const result = await Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), 500))]);
      ok(result && result.pausedAt, "rails: Debugger.paused(reason=XHR) resolves the xhrBreak waiter");
    }

    // 5g. input lock registers MODE_INPUT_LOCK and unregisters on release.
    {
      await ctxEval(`chromeInputLock({ targetId: 7, ignore: true })`);
      ok(ctxEval(`modesForTab(7).has("inputLock")`), "rails: chrome_input_lock(true) registers MODE_INPUT_LOCK");
      await ctxEval(`chromeInputLock({ targetId: 7, ignore: false })`);
      ok(!ctxEval(`modesForTab(7).has("inputLock")`), "rails: chrome_input_lock(false) unregisters MODE_INPUT_LOCK");
    }
  }

  // ===== (6) pure formatters (commands.ts) =====
  {
    const f = (name) => cmdMod[name];
    ok(typeof f("formatMatchedRules") === "function" && f("formatMatchedRules")({ matchedRules: [{ group: "matched", origin: "author", selectorText: ".x", specificity: { a: 0, b: 1, c: 0 }, properties: [{ name: "color", value: "red" }] }] }).includes(".x"), "formatters: formatMatchedRules renders selector + origin");
    ok(f("formatPseudoState")({ forcedPseudoClasses: ["hover", "focus"] }).includes(":hover"), "formatters: formatPseudoState renders forced classes");
    ok(f("formatMediaQueries")({ queries: [{ source: "linkedSheet", text: "@media (min-width: 768px)" }] }).includes("768px"), "formatters: formatMediaQueries renders query text");
    ok(f("formatBackgroundColors")({ backgroundColors: ["rgb(255, 255, 255)"] }).includes("rgb(255, 255, 255)"), "formatters: formatBackgroundColors renders the color stack");
    ok(f("formatPlatformFonts")({ fonts: [{ familyName: "Roboto", isCustomFont: true }] }).includes("Roboto"), "formatters: formatPlatformFonts renders family");
    ok(f("formatA11yTree")({ summary: { total: 2, ignored: 1, roleCounts: [{ role: "button", count: 1 }] }, nodes: [] }).includes("button"), "formatters: formatA11yTree renders role counts");
    ok(f("formatA11yNode")({ ax: { nodeId: "n1", role: "button", name: "Go", ignored: true, ignoredReasons: [{ reason: "not rendered" }] } }).includes("IGNORED"), "formatters: formatA11yNode surfaces ignored reasons");
    ok(f("formatMutationWait")({ records: [{ type: "attributes", attributeName: "class" }] }).includes("attributes"), "formatters: formatMutationWait renders mutation type");
    ok(f("formatFetchStack")({ breakpointed: true, url: "x.js", stack: [{ functionName: "f", url: "a.js", lineNumber: 2 }] }).includes("f"), "formatters: formatFetchStack renders frames");
    ok(f("formatInputLock")({ ignoring: true }).includes("ignored"), "formatters: formatInputLock renders lock state");
    ok(f("formatGesture")({ type: "pinch", scaleFactor: 2 }).includes("scale=2"), "formatters: formatGesture renders scale");
    ok(f("formatStorageUsage")({ origin: "https://x", usage: 1024, quota: 2048 }).includes("1.0 KB"), "formatters: formatStorageUsage renders bytes");
    ok(f("formatCacheStorage")({ action: "list", origin: "https://x", caches: [{ cacheName: "v1" }] }).includes("v1"), "formatters: formatCacheStorage renders cache names");
    ok(f("formatClearSiteData")({ origin: "https://x", httpCacheCleared: true }).includes("Cleared site data"), "formatters: formatClearSiteData confirms the wipe");
    ok(f("formatServiceWorker")({ action: "list", versions: [{ versionId: "1", status: "activated", scriptURL: "sw.js" }] }).includes("activated"), "formatters: formatServiceWorker renders versions");
    ok(f("formatSystemInfo")({ info: { platform: "Windows", arch: "x64", osVersion: "10" } }).includes("Windows"), "formatters: formatSystemInfo renders platform");
    ok(f("formatTargetEvaluate")({ ok: true, targetId: "t1", result: 42 }).includes("42"), "formatters: formatTargetEvaluate renders the value");
    ok(f("formatSetPermission")({ permission: "geolocation", setting: "granted", origin: "https://x" }).includes("granted"), "formatters: formatSetPermission renders the setting");
    ok(f("formatLayoutMetrics")({ layoutViewport: { width: 1280, height: 800 } }).includes("1280x800"), "formatters: formatLayoutMetrics renders viewport");
    ok(f("formatAnimations")({ action: "list", animations: [{ id: "a1", playState: "running", target: { tag: "div" } }] }).includes("a1"), "formatters: formatAnimations renders animation ids");
    ok(f("formatPdfResult")({ supported: false, reason: "headless only", hint: "use --headless" }).includes("unsupported"), "formatters: formatPdfResult surfaces the headless gate");
    ok(f("formatCpuProfile")({ elapsedMs: 100, sampleCount: 5, rowCount: 3, selfTimeByFunction: [{ functionName: "hot", url: "a.js", lineNumber: 1, selfTimeMs: 2.5, pct: 50 }] }).includes("hot"), "formatters: formatCpuProfile renders top-self-time");
    ok(f("formatCoverage")({ files: [{ url: "app.js", unusedBytes: 1024, totalBytes: 2048, unusedPct: 50, kind: "js" }] }).includes("app.js"), "formatters: formatCoverage renders per-file bytes");
  }

  console.log(`\np1b-tools: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}
