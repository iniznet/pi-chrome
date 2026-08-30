// P1A-batch harness (test-p1a): Debugger family + console/exceptions + network deep-dive.
//
// Pins the P1A tool surface of tasks/impl/TOOL_CONTRACTS.md §6 rows 29-42 against the REAL
// shipped sources (source-level for index.ts, vm-load for service_worker.js, type-stripped
// import for commands.ts):
//   (1) catalog consistency — every P1A CHROME_TOOL_NAMES entry has a pi.registerTool block
//   (2) schema surface — distinguishing inputs present per tool
//   (3) wire routing — every P1A kind has a `case` in the SW dispatch switch and every tool
//       routes via authorizedBridgeSend
//   (4) CDP mapping — the SW implements the contract CDP methods/events
//   (5) safety rails — Fetch interception auto-timeout (30s) + bounded paused ring; the debugger
//       family enforces paused-state; the keepalive registry carries the new modes
//   (6) pure helpers — ringPush / normalizeCdpTimestamp / summarizeException /
//       recordWebSocketEvent / formatters (commands.ts)

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/index.ts");
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const commandsPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/commands.ts");

const indexSrc = fs.readFileSync(indexPath, "utf8");
const workerSrc = fs.readFileSync(workerPath, "utf8");

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; } else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---- P1A catalog fixture (TOOL_CONTRACTS.md §6 rows 29-42) -------------------
// params: distinguishing schema keys that MUST appear in the tool's parameters Type.Object.
// sw: contract CDP methods/events the SW MUST implement (searched in service_worker.js).
const P1A_TOOLS = [
  { name: "chrome_breakpoint", kind: "debug.breakpoint", params: ["action", "lineNumber", "condition"], sw: [/Debugger\.setBreakpointByUrl/, /Debugger\.removeBreakpoint/, /MODE_BREAKPOINTS/] },
  { name: "chrome_pause", kind: "debug.pause", params: [], sw: [/Debugger\.pause/, /MODE_PAUSED/] },
  { name: "chrome_resume", kind: "debug.resume", params: [], sw: [/Debugger\.resume/] },
  { name: "chrome_step", kind: "debug.step", params: ["action"], sw: [/Debugger\.stepInto/, /Debugger\.stepOver/, /Debugger\.stepOut/] },
  { name: "chrome_get_call_stack", kind: "debug.callStack", params: [], sw: [/Runtime\.getProperties/, /PAUSED_FRAMES_MAX/] },
  { name: "chrome_evaluate_in_frame", kind: "debug.evalFrame", params: ["callFrameId", "expression"], sw: [/Debugger\.evaluateOnCallFrame/] },
  { name: "chrome_get_script_source", kind: "debug.scriptSource", params: ["scriptId", "list"], sw: [/Debugger\.getScriptSource/, /SCRIPT_SOURCE_MAX_CHARS/] },
  { name: "chrome_set_pause_on_exceptions", kind: "debug.pauseOnExceptions", params: ["state"], sw: [/Debugger\.setPauseOnExceptions/, /MODE_PAUSE_EXCEPTIONS/] },
  { name: "chrome_list_js_exceptions", kind: "debug.exceptions", params: ["clear", "limit"], sw: [/Runtime\.exceptionThrown/, /EXCEPTION_RING_MAX/] },
  { name: "chrome_console_capture", kind: "console.capture", params: ["enabled", "clear", "limit"], sw: [/MODE_CONSOLE_CAPTURE/, /consoleAPICalled/, /Log\.entryAdded/] },
  { name: "chrome_browser_log", kind: "log.list", params: ["clear", "limit"], sw: [/enableCdpDomain\(tab\.id, \"Log\"\)/, /logEntriesPerTab/] },
  { name: "chrome_network_cause", kind: "network.cause", params: ["requestId", "requestUrlIncludes"], sw: [/Network\.requestWillBeSentExtraInfo/, /Network\.responseReceivedExtraInfo/, /Network\.getCertificate/, /blockedReason/] },
  { name: "chrome_network_headers", kind: "network.headers", params: ["headers", "clear"], sw: [/Network\.setExtraHTTPHeaders/, /MODE_HEADERS/] },
  { name: "chrome_network_intercept", kind: "network.intercept", params: ["action", "patterns", "resolveAction"], sw: [/Fetch\.enable/, /Fetch\.continueRequest/, /Fetch\.fulfillRequest/, /Fetch\.failRequest/, /INTERCEPT_PAUSED_TIMEOUT_MS/, /MODE_INTERCEPT/] },
  { name: "chrome_websocket_messages", kind: "network.websockets", params: ["clear", "limit"], sw: [/Network\.webSocketCreated/, /Network\.webSocketFrameSent/, /WS_FRAMES_MAX/, /WS_PAYLOAD_PREVIEW_MAX/] },
];

// ---- String-aware brace matching (copied from p0-tools.test.mjs) --------------
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

// Load the real shipped commands.ts once via node's type stripping (same as p0-tools).
const cmdJs = stripTypeScriptTypes(fs.readFileSync(commandsPath, "utf8"), { mode: "strip" });
const cmdMod = await import("data:text/javascript;base64," + Buffer.from(cmdJs).toString("base64"));

// ---- VM harness (real SW, controllable chrome.* mock + fake timers) -----------
function makeChrome(rec) {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  const tab = { id: 7, windowId: 1, url: "https://example.test/", active: false, title: "Test" };
  return {
    runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null, reload: noop, getURL: (p) => p },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener, setBadgeText: noop, setBadgeBackgroundColor: noop },
    debugger: {
      attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]), onDetach: listener, onEvent: listener,
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

async function run(cmdMod) {
  // ===== (1) catalog consistency =====
  {
    for (const t of P1A_TOOLS) {
      ok(toolNames.includes(t.name), `catalog: ${t.name} is listed in CHROME_TOOL_NAMES`);
      ok(blocksByName.has(t.name), `catalog: ${t.name} has a pi.registerTool block`);
    }
    const registeredNames = new Set(toolBlocks.map((b) => b.name));
    for (const name of toolNames) ok(registeredNames.has(name), `catalog: every CHROME_TOOL_NAMES entry has a matching registerTool block (${name})`);
  }

  // ===== (2) schema surface =====
  {
    for (const t of P1A_TOOLS) {
      const block = blocksByName.get(t.name);
      if (!block) continue;
      const paramsSection = extractParameters(block);
      for (const marker of t.params) ok(paramsSection.includes(marker), `schema: ${t.name} parameters list '${marker}'`);
      // Shared tab-resolution params stay on every tab-resolving P1A tool.
      ok(paramsSection.includes("targetId"), `schema: ${t.name} keeps targetId tab-resolution param`);
      ok(paramsSection.includes("background"), `schema: ${t.name} keeps background tab-resolution param`);
    }
  }

  // ===== (3) wire routing =====
  {
    for (const t of P1A_TOOLS) {
      const block = blocksByName.get(t.name);
      if (!block) continue;
      const kindPattern = t.kind === "network.intercept"
        ? /authorizedBridgeSend\("network\.intercept\.\$\{/
        : block.includes(`authorizedBridgeSend("${t.kind}"`);
      ok(kindPattern, `routing: ${t.name} sends kind '${t.kind}' via authorizedBridgeSend`);
      ok(!block.includes("bridge.send("), `routing: ${t.name} never bypasses authorization with a raw bridge.send`);
    }
    for (const t of P1A_TOOLS) {
      if (t.kind === "network.intercept") {
        for (const sub of ["on", "off", "list", "resolve"]) {
          ok(workerSrc.includes(`case "network.intercept.${sub}":`), `routing: SW dispatch has a case for 'network.intercept.${sub}'`);
        }
      } else {
        ok(workerSrc.includes(`case "${t.kind}":`), `routing: SW dispatch has a case for '${t.kind}' (${t.name})`);
      }
    }
  }

  // ===== (4) CDP mapping =====
  {
    for (const t of P1A_TOOLS) {
      for (const re of t.sw) ok(re.test(workerSrc), `cdp: SW implements ${re} for ${t.name}`);
    }
  }

  // ===== (5) vm safety rails =====
  {
    const rec = {};
    const { sandbox, ctxEval, timers, fireTimer } = loadWorker(rec);

    // 5a. ringPush caps at the given cap and drops oldest-first.
    {
      const ring = [];
      for (let i = 0; i < 12; i++) sandbox.ringPush(ring, i, 10);
      ok(ring.length === 10 && ring[0] === 2 && ring[9] === 11, "rails: ringPush keeps the newest `cap` entries");
    }

    // 5b. normalizeCdpTimestamp converts CDP seconds -> ms.
    {
      ok(sandbox.normalizeCdpTimestamp(1.5) === 1500, "rails: normalizeCdpTimestamp converts seconds to ms");
      ok(typeof sandbox.normalizeCdpTimestamp(undefined) === "number", "rails: normalizeCdpTimestamp falls back to Date.now()");
    }

    // 5c. summarizeException caps the stack at 20 frames and captures the exception preview.
    {
      const frames = Array.from({ length: 30 }, (_, i) => ({ functionName: `f${i}`, url: `u${i}.js`, lineNumber: i, columnNumber: 0 }));
      const summary = sandbox.summarizeException({ text: "Oops", url: "a.js", lineNumber: 3, columnNumber: 1, stackTrace: { callFrames: frames }, exception: { description: "Error: Oops\n at f0 (u0.js:0:0)" } }, 1700000000.5);
      ok(summary.stackTrace.length === 20, "rails: summarizeException caps stack at 20 frames");
      ok(summary.text === "Oops" && summary.url === "a.js" && summary.lineNumber === 3, "rails: summarizeException keeps text/url/line");
      ok(summary.preview && summary.preview.type === "description", "rails: summarizeException extracts exception description preview");
      ok(summary.timestamp === 1700000000500, "rails: summarizeException normalizes the timestamp to ms");
    }

    // 5d. recordWebSocketEvent maps directions and caps payload previews.
    {
      ctxEval(`wsFramesPerTab.set(7, [])`);
      sandbox.recordWebSocketEvent(7, "Network.webSocketCreated", { requestId: "ws1", url: "wss://a.example/" });
      sandbox.recordWebSocketEvent(7, "Network.webSocketFrameReceived", { requestId: "ws1", response: { opcode: 1, mask: false, payloadData: "x".repeat(5000) } });
      sandbox.recordWebSocketEvent(7, "Network.webSocketClosed", { requestId: "ws1" });
      const ring = ctxEval(`wsFramesPerTab.get(7)`);
      ok(ring.length === 3, "rails: recordWebSocketEvent records created/frame/closed");
      ok(ring[0].direction === "created" && ring[0].url === "wss://a.example/", "rails: webSocketCreated direction + url");
      ok(ring[1].direction === "received" && ring[1].opcode === 1, "rails: frame direction + opcode");
      ok(ring[1].payloadPreview.length === 2048 && ring[1].payloadTruncated === true, "rails: WS payload preview capped at 2048 with truncated flag");
      ok(ring[2].direction === "closed", "rails: webSocketClosed direction");
    }

    // 5e. Fetch interception auto-timeout: a paused request with no resolve is auto-continued
    //     after the 30s timer fires, and the paused ring is bounded.
    {
      ctxEval(`interceptPerTab.set(7, { patterns: ["*"], paused: new Map(), resolved: [] })`);
      sandbox.handleFetchRequestPaused(7, { requestId: "r1", request: { url: "https://api.example/x", method: "GET" }, resourceType: "XHR" });
      ok(ctxEval(`interceptPerTab.get(7).paused.has("r1")`), "rails: requestPaused records the pause");
      ok(!(rec.cdpMethods || []).some((m) => m.method === "Fetch.continueRequest"), "rails: recording a pause sends no immediate CDP command");
      // The auto-timeout was armed via the fake setTimeout registry — fire it and assert the
      // request is auto-continued (the mandatory 30s rail, risk #5).
      const ids = Array.from(timers.keys());
      ok(ids.length === 1, `rails: exactly one auto-timeout timer armed (got ${ids.length})`);
      fireTimer(ids[0]);
      ok(!ctxEval(`interceptPerTab.get(7).paused.has("r1")`), "rails: auto-timeout removed the paused request");
      const continued = (rec.cdpMethods || []).filter((m) => m.method === "Fetch.continueRequest" && m.params.requestId === "r1");
      ok(continued.length === 1, `rails: auto-timeout continued the paused request (got ${(rec.cdpMethods || []).map((m) => m.method).join(",")})`);

      // Bounded paused ring: 205 pauses without resolving -> size capped at 200, oldest evicted.
      ctxEval(`interceptPerTab.set(7, { patterns: ["*"], paused: new Map(), resolved: [] })`);
      for (const id of Array.from(timers.keys())) timers.delete(id);
      rec.cdpMethods = [];
      for (let i = 0; i < 205; i++) {
        sandbox.handleFetchRequestPaused(7, { requestId: `b${i}`, request: { url: `u${i}`, method: "GET" }, resourceType: "XHR" });
      }
      const bounded = ctxEval(`interceptPerTab.get(7).paused.size`);
      ok(bounded === 200, `rails: paused-request ring bounded at 200 (got ${bounded})`);
      const evicted = (rec.cdpMethods || []).filter((m) => m.method === "Fetch.continueRequest" && m.params.requestId === "b0");
      ok(evicted.length === 1, "rails: oldest paused request force-continued when the ring overflowed");
    }

    // 5f. New keepalive mode descriptors are registered with the full contract surface.
    {
      for (const mode of ["MODE_BREAKPOINTS", "MODE_PAUSE_EXCEPTIONS", "MODE_CONSOLE_CAPTURE", "MODE_HEADERS", "MODE_INTERCEPT"]) {
        const desc = ctxEval(`keepaliveModes[${mode}]`);
        ok(desc !== undefined, `rails: ${mode} is registered in keepaliveModes`);
        ok(desc && desc.keepaliveMs > 0, `rails: ${mode} extends the attach keepalive`);
        ok(desc && desc.persist === true, `rails: ${mode} persists intent (re-apply on re-attach)`);
        ok(desc && typeof desc.snapshot === "function" && typeof desc.restore === "function" && typeof desc.reapply === "function" && typeof desc.onDetach === "function", `rails: ${mode} exposes snapshot/restore/reapply/onDetach`);
      }
    }

    // 5g. Debugger family enforces paused state; resume is idempotent.
    {
      let threw = false;
      try { await sandbox.chromeStep({ targetId: "7" }); } catch { threw = true; }
      ok(threw, "rails: chrome_step throws when the page is not paused");
      threw = false;
      try { await sandbox.chromeGetCallStack({ targetId: "7" }); } catch { threw = true; }
      ok(threw, "rails: chrome_get_call_stack throws when the page is not paused");
      threw = false;
      try { await sandbox.chromeEvaluateInFrame({ targetId: "7", callFrameId: "c1", expression: "1" }); } catch { threw = true; }
      ok(threw, "rails: chrome_evaluate_in_frame throws when the page is not paused");
      const resumed = await sandbox.chromeResume({ targetId: "7" });
      ok(resumed.resumed === false, "rails: chrome_resume on an unpaused page reports resumed:false (idempotent)");
    }

    // 5h. chrome_set_pause_on_exceptions defaults to "uncaught" and registers MODE_PAUSE_EXCEPTIONS.
    {
      const r = await sandbox.chromeSetPauseOnExceptions({ targetId: "7" });
      ok(r.state === "uncaught", "rails: pause-on-exceptions defaults to uncaught");
      ok(ctxEval(`modesPerTab.get(7)?.has(MODE_PAUSE_EXCEPTIONS)`), "rails: pause-on-exceptions registers MODE_PAUSE_EXCEPTIONS");
      ok((rec.cdpMethods || []).some((m) => m.method === "Debugger.setPauseOnExceptions" && m.params.state === "uncaught"), "rails: Debugger.setPauseOnExceptions sent with state=uncaught");
    }
  }

  // ===== (6) formatters (commands.ts pure) =====
  {
    const {
      formatBreakpointResult, formatCallStack, formatConsoleCapture, formatJsExceptions,
      formatNetworkCause, formatPauseState, formatWebsocketFrames, formatInterceptStatus,
      formatNetworkHeaders, formatEvalFrameResult, formatScriptSource, formatBrowserLog,
    } = cmdMod;

    const callStack = formatCallStack({ reason: "other", frames: [{ functionName: "main", url: "https://a/app.js", lineNumber: 12, columnNumber: 3, scopes: [{ type: "local", properties: [{ name: "x", value: 1 }] }] }] });
    ok(callStack.includes("main") && callStack.includes("app.js:12"), "formatter: formatCallStack renders frames + scopes");

    const ex = formatJsExceptions({ exceptions: [{ text: "TypeError: x", url: "https://a/app.js", lineNumber: 4, stackTrace: [{ functionName: "boom", url: "https://a/app.js", lineNumber: 4 }] }] });
    ok(ex.includes("TypeError: x") && ex.includes("boom"), "formatter: formatJsExceptions renders message + top frame");

    const bp = formatBreakpointResult({ action: "set", breakpoint: { breakpointId: "bp1", url: "https://a/app.js", lineNumber: 3 }, count: 1 });
    ok(bp.includes("bp1") && bp.includes(":3"), "formatter: formatBreakpointResult renders set");

    const ps = formatPauseState({ paused: true, reason: "other", callFrames: [{ functionName: "f", url: "u", lineNumber: 1 }] });
    ok(ps.includes("Page paused") && ps.includes("f"), "formatter: formatPauseState renders paused state");

    const res = formatPauseState({ resumed: true });
    ok(res.includes("resumed"), "formatter: formatPauseState renders resume");

    const cc = formatConsoleCapture({ enabled: true, entries: [{ family: "exception", timestamp: Date.now(), text: "boom" }], totals: { console: 0, exceptions: 1, log: 0 } });
    ok(cc.includes("EXC boom"), "formatter: formatConsoleCapture renders exception entries");

    const nc = formatNetworkCause({ method: "GET", url: "https://x/fail", failure: { errorText: "net::ERR_CERT_DATE_INVALID", blockedReason: null } });
    ok(nc.includes("net::ERR_CERT_DATE_INVALID"), "formatter: formatNetworkCause renders failure cause");

    const ws = formatWebsocketFrames({ frames: [{ direction: "received", opcode: 1, payloadPreview: "hi", timestamp: Date.now() }], totalCaptured: 1, captureMode: true });
    ok(ws.includes("received") && ws.includes("opcode=1"), "formatter: formatWebsocketFrames renders frame direction + opcode");

    ok(formatInterceptStatus({ enabled: true, patterns: ["*"], pausedCount: 1 }).includes("30s"), "formatter: formatInterceptStatus mentions the 30s auto-continue rail");
    ok(formatNetworkHeaders({ clear: true }).includes("cleared"), "formatter: formatNetworkHeaders renders clear");
    ok(formatEvalFrameResult({ ok: true, result: { value: 42 } }).includes("42"), "formatter: formatEvalFrameResult renders value");
    ok(formatScriptSource({ scriptId: "s1", url: "a.js", source: "var x = 1;" }).includes("var x = 1;"), "formatter: formatScriptSource renders source");
    ok(formatBrowserLog({ entries: [{ level: "error", text: "Mixed Content", source: "security" }] }).includes("Mixed Content"), "formatter: formatBrowserLog renders entries");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

// Fire every armed timer (FIFO) so the Fetch auto-timeout callback runs; the timeout callback
// sends Fetch.continueRequest through the (recording) CDP mock.
run(cmdMod).catch((e) => { console.error(e); process.exit(1); });
