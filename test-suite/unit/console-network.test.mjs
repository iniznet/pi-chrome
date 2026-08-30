// Unit harness for the P1A console + network batch — chrome_list_js_exceptions /
// chrome_console_capture / chrome_browser_log / chrome_network_cause / chrome_network_headers /
// chrome_network_intercept / chrome_websocket_messages (TOOL_CONTRACTS.md §6 rows 37–42 + §4 kinds,
// devtools-gap-report §8.4).
//
// Loads the REAL service_worker.js into a vm sandbox (sw-lifecycle / keepalive-registry pattern)
// with an emittable chrome.debugger.onEvent (so Runtime.exceptionThrown / consoleAPICalled /
// Log.entryAdded / Network.webSocket* / Fetch.requestPaused can be driven through the REAL
// listener), a CDP method recorder with per-method responses/errors, stateful
// chrome.storage.session, and recording setTimeout — the 30s interception auto-timeout timer is
// fired manually (no real 30s wait, no hangs); sub-second timers auto-execute.
//
// Coverage (the six required areas): paused-rail adjacency is in debugger-family.test.mjs;
// here: interception auto-timeout cleanup (§8), exception ledger shape (§2), WS frame capture
// (§5), keepalive registry membership for the P1A modes (§1), detach cleanup (§8, §1), plus
// console/log/headers/cause read paths. All sections run against the real P1A handlers.
//
// Run: node test-suite/unit/console-network.test.mjs  (package.json test script is owned by Verify)

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const src = fs.readFileSync(workerPath, "utf8");

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; }
  else { failures++; console.error(`  ✗ ${msg}`); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeListener() {
  const cbs = [];
  return { addListener: (cb) => { cbs.push(cb); }, removeListener: () => {}, fire: (...a) => { for (const cb of cbs.slice()) cb(...a); } };
}

function makeChrome(rec) {
  rec.cdpCalls = rec.cdpCalls || [];
  rec.cdpResponses = rec.cdpResponses || {};
  rec.cdpErrors = rec.cdpErrors || {};
  const noop = () => {};
  const tab = { id: 7, windowId: 1, url: "https://app.example/", title: "App", active: false };
  const chrome = {
    runtime: {
      id: "unittestextension", getManifest: () => ({ version: "0.0.0" }),
      onInstalled: makeListener(), onStartup: makeListener(), lastError: null,
      reload: () => { rec.reloadCalls = (rec.reloadCalls || 0) + 1; }, getURL: (p) => p,
    },
    alarms: { onAlarm: makeListener(), create: noop, clear: noop, clearAll: noop },
    action: { onClicked: makeListener(), setBadgeText: noop, setBadgeBackgroundColor: noop },
    debugger: {
      attach: async () => {},
      detach: async (debuggee) => { rec.detaches = rec.detaches || []; rec.detaches.push(debuggee?.tabId ?? debuggee?.targetId ?? debuggee); },
      getTargets: (cb) => cb([]),
      onDetach: makeListener(), onEvent: makeListener(),
      sendCommand: (debuggee, method, params, cb) => {
        rec.cdpCalls.push({ method, params: params || {}, debuggee });
        if (rec.cdpErrors && rec.cdpErrors[method]) {
          chrome.runtime.lastError = { message: rec.cdpErrors[method] };
          cb({});
          chrome.runtime.lastError = null;
          return;
        }
        cb(rec.cdpResponses && rec.cdpResponses[method] ? rec.cdpResponses[method] : {});
      },
    },
    scripting: { executeScript: async () => [{ result: undefined }], registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
    webNavigation: { onCommitted: makeListener(), onCompleted: makeListener(), getAllFrames: async () => [] },
    tabs: {
      onUpdated: makeListener(), onRemoved: makeListener(),
      query: async () => [tab], get: async (id) => (Number(id) === tab.id ? { ...tab } : null),
      create: async () => ({ ...tab }), update: async () => ({ ...tab }), remove: async () => {},
      group: async () => -1, ungroup: async () => {},
    },
    windows: { create: async () => ({ id: 1 }), get: async () => ({ tabs: [] }), remove: async () => {}, update: async () => {} },
    storage: {
      session: {
        get: async (k) => (k in rec.sessionStore ? { [k]: rec.sessionStore[k] } : {}),
        set: async (o) => { Object.assign(rec.sessionStore, o); },
      },
    },
    downloads: { onChanged: makeListener() },
    cookies: { getAll: async () => [] },
  };
  return chrome;
}

function loadWorker(rec) {
  const chrome = makeChrome(rec);
  const warns = [];
  const consoleSpy = { log: () => {}, warn: (...a) => { warns.push(a.map(String).join(" ")); }, error: () => {}, info: () => {} };
  const timeouts = [];
  const sandbox = {
    console: consoleSpy, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setImmediate,
    setTimeout: (fn, ms) => {
      const id = timeouts.length + 1;
      timeouts.push({ fn, ms });
      if (ms === undefined || ms < 1000) setImmediate(() => { try { fn(); } catch {} });
      return id;
    },
    clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    fetch: async () => { throw new Error("no network in unit test"); },
    navigator: { userAgent: "unit-test" },
    WebSocket: function () {}, AbortController, encodeURIComponent, decodeURIComponent, URLSearchParams,
    chrome,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const ctxEval = (code) => vm.runInContext(code, sandbox, { filename: "ctx" });
  return {
    sandbox, chrome, rec, warns, ctxEval, timeouts,
    emitEvent: (method, params) => chrome.debugger.onEvent.fire({ tabId: 7 }, method, params),
    fireDetach: (reason = "target_closed") => chrome.debugger.onDetach.fire({ tabId: 7 }, reason),
  };
}

async function dispatchR(sandbox, action, params) {
  try { return { ok: true, value: await sandbox.dispatch(action, params) }; }
  catch (e) { return { ok: false, error: e }; }
}

async function run() {
  // =====================================================================
  // 1. P1A long-lived mode descriptors: MODE_HEADERS / MODE_CONSOLE_CAPTURE / MODE_INTERCEPT
  //    (TOOL_CONTRACTS §3.2 + §6 rows 38/40/41) + membership in action
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);
    for (const mode of ["headers", "consoleCapture", "intercept"]) {
      const desc = h.ctxEval(`keepaliveModes[${JSON.stringify(mode)}]`);
      ok(desc !== undefined, `keepalive: MODE_${mode} is registered in keepaliveModes`);
      if (desc) {
        ok(desc.keepaliveMs > 0, `keepalive: MODE_${mode} extends the attach keepalive`);
        ok(desc.persist === true, `keepalive: MODE_${mode} persists intent (re-apply on re-attach)`);
        ok(["snapshot", "restore", "reapply", "onDetach"].every((k) => typeof desc[k] === "function"), `keepalive: MODE_${mode} exposes snapshot/restore/reapply/onDetach`);
      }
    }
    // Membership in action: registering MODE_INTERCEPT must extend a tab's detachAt past the idle window.
    h.ctxEval(`attachedTabs.set(12, { detachAt: Date.now() + 100, pointer: {x:0,y:0}, debuggee: { tabId: 12 } });`);
    const base = h.ctxEval(`attachedTabs.get(12).detachAt`);
    h.sandbox.registerMode(12, h.ctxEval(`MODE_INTERCEPT`));
    ok(h.ctxEval(`attachedTabs.get(12).detachAt`) > base + 10_000, "keepalive: registering MODE_INTERCEPT keeps the tab attached past the idle window");
    h.sandbox.unregisterMode(12, h.ctxEval(`MODE_INTERCEPT`));
    h.ctxEval(`attachedTabs.delete(12)`);
  }

  // =====================================================================
  // 2. Exception ledger — chrome_list_js_exceptions (TOOL_CONTRACTS §6 row 37)
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);

    h.emitEvent("Runtime.exceptionThrown", {
      timestamp: 1000,
      exceptionDetails: {
        exceptionId: 1,
        text: "Uncaught ReferenceError: x is not defined",
        lineNumber: 5, columnNumber: 2,
        url: "https://app.example/app.js",
        stackTrace: { callFrames: [{ functionName: "main", url: "https://app.example/app.js", lineNumber: 5, columnNumber: 2 }] },
        exception: { type: "object", subtype: "error", description: "ReferenceError: x is not defined" },
      },
    });
    const ledger = h.ctxEval(`runtimeExceptionsPerTab.get(7)`);
    ok(Array.isArray(ledger) && ledger.length === 1, `exceptions: Runtime.exceptionThrown lands in the per-tab ledger (got ${ledger ? ledger.length : "no store"})`);
    if (Array.isArray(ledger) && ledger.length === 1) {
      const entry = ledger[0];
      ok(entry.url === "https://app.example/app.js" && entry.lineNumber === 5 && entry.columnNumber === 2, "exceptions: location fields normalized");
      ok(typeof entry.text === "string" && entry.text.includes("ReferenceError"), "exceptions: error text captured");
      ok(entry.exceptionId === 1, "exceptions: exceptionId preserved");
      ok(Array.isArray(entry.stackTrace) && entry.stackTrace.length === 1, "exceptions: stack frames array present");
      ok(entry.preview && entry.preview.type === "description", "exceptions: exception preview (description) captured");
      ok(typeof entry.timestamp === "number", "exceptions: timestamp present");
    }

    // Ring cap: EXCEPTION_RING_MAX = 500 (bounded buffers, risk #11).
    for (let i = 0; i < 520; i++) {
      h.emitEvent("Runtime.exceptionThrown", { exceptionDetails: { exceptionId: i + 10, text: `err ${i}`, url: "u.js", lineNumber: i, columnNumber: 0 } });
    }
    const capped = h.ctxEval(`runtimeExceptionsPerTab.get(7)`);
    ok(capped && capped.length === 500, `exceptions: ring capped at 500 (got ${capped ? capped.length : "no store"})`);

    // debug.exceptions read path: count + limit + clear.
    const read = await dispatchR(h.sandbox, "debug.exceptions", { targetId: 7 });
    ok(read.ok, `exceptions: debug.exceptions dispatch resolves (got: ${read.ok ? "" : String(read.error?.message || read.error)})`);
    if (read.ok) {
      ok(Array.isArray(read.value.exceptions) && read.value.exceptions.length === 500, "exceptions: exceptions array returned");
      ok(read.value.count === 500, "exceptions: count reported");
      const lim = await dispatchR(h.sandbox, "debug.exceptions", { targetId: 7, limit: 10 });
      ok(lim.ok && lim.value.exceptions.length === 10, "exceptions: limit caps the response");
      const clr = await dispatchR(h.sandbox, "debug.exceptions", { targetId: 7, clear: true });
      ok(clr.ok && clr.value.cleared === 500 && (h.ctxEval(`runtimeExceptionsPerTab.get(7)?.length ?? 0`) === 0), "exceptions: clear empties the ledger");
    }
  }

  // =====================================================================
  // 3. Console capture — chrome_console_capture (TOOL_CONTRACTS §6 row 38)
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);

    // consoleAPICalled is only recorded while the persistent mode is on (chatty family gate).
    h.emitEvent("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "before mode" }], executionContextId: 1, timestamp: 1 });
    ok((h.ctxEval(`consoleEntriesPerTab.get(7)?.length ?? 0`) === 0), "console: calls before the mode is on are not captured");

    const on = await dispatchR(h.sandbox, "console.capture", { targetId: 7, enabled: true });
    ok(on.ok, `console: console.capture on resolves (got: ${on.ok ? "" : String(on.error?.message || on.error)})`);
    if (on.ok) {
      ok(rec.cdpCalls.some((c) => c.method === "Runtime.enable"), "console: Runtime.enable sent");
      ok(rec.cdpCalls.some((c) => c.method === "Log.enable"), "console: Log.enable sent (Log.entryAdded family)");
      ok(on.value.enabled === true, "console: response echoes enabled");
      ok(h.ctxEval(`modesPerTab.get(7)?.has(MODE_CONSOLE_CAPTURE)`), "console: MODE_CONSOLE_CAPTURE registered");
      await tick();
      const stored = rec.sessionStore[h.ctxEval(`KEEPALIVE_MODE_STORAGE_KEY`)];
      ok(stored && stored["7"] && stored["7"].consoleCapture && stored["7"].consoleCapture.enabled === true, "console: intent persisted to chrome.storage.session");
    }

    // Three event families land in the shared read surface (console.capture totals).
    h.emitEvent("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "hello from page" }], executionContextId: 1, timestamp: 123 });
    h.emitEvent("Runtime.exceptionThrown", { exceptionDetails: { exceptionId: 9, text: "boom", url: "u.js", lineNumber: 1, columnNumber: 0 } });
    h.emitEvent("Log.entryAdded", { entry: { level: "warning", text: "Mixed Content blocked", source: "security", timestamp: 125 } });

    const ring = h.ctxEval(`consoleEntriesPerTab.get(7)`);
    ok(Array.isArray(ring) && ring.length === 1, `console: consoleAPICalled captured while the mode is on (got ${ring ? ring.length : "no store"})`);
    if (Array.isArray(ring) && ring.length === 1) {
      ok(ring[0].type === "log" && ring[0].args[0].value === "hello from page", "console: consoleAPICalled entry carries type + args");
    }
    ok((h.ctxEval(`runtimeExceptionsPerTab.get(7)?.length ?? 0`) === 1), "console: exceptionThrown recorded regardless of the mode");
    ok((h.ctxEval(`logEntriesPerTab.get(7)?.length ?? 0`) === 1), "console: Log.entryAdded recorded regardless of the mode");

    // Ring cap 500.
    for (let i = 0; i < 520; i++) {
      h.emitEvent("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: `m${i}` }], executionContextId: 1, timestamp: i });
    }
    const capped = h.ctxEval(`consoleEntriesPerTab.get(7)`);
    ok(capped && capped.length === 500, `console: ring capped at 500 (got ${capped ? capped.length : "no store"})`);

    // The capture read surface merges all three families.
    const read = await dispatchR(h.sandbox, "console.capture", { targetId: 7 });
    ok(read.ok && read.value.entries && read.value.entries.length === 502, `console: capture read returns the merged families (got ${read.ok ? read.value.entries.length : "err"})`);
    if (read.ok) {
      ok(read.value.totals.console === 500 && read.value.totals.exceptions === 1 && read.value.totals.log === 1, "console: totals per family reported");
      ok(read.value.entries.every((e) => ["console", "exception", "log"].includes(e.family)), "console: entries carry their family tag");
    }

    // Off: unregister + mode intent dropped.
    const off = await dispatchR(h.sandbox, "console.capture", { targetId: 7, enabled: false });
    ok(off.ok && off.value.enabled === false, "console: console.capture off echoes disabled");
    ok(h.ctxEval(`modesPerTab.get(7)?.has(MODE_CONSOLE_CAPTURE)`) !== true, "console: MODE_CONSOLE_CAPTURE unregistered on off");
    // Clear variant empties the rings.
    const offClear = await dispatchR(h.sandbox, "console.capture", { targetId: 7, enabled: false, clear: true });
    ok(offClear.ok && (h.ctxEval(`consoleEntriesPerTab.get(7)?.length ?? 0`) === 0), "console: clear:true empties the console ring");
  }

  // =====================================================================
  // 4. Browser log — chrome_browser_log (TOOL_CONTRACTS §6 row 44)
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);
    h.emitEvent("Log.entryAdded", { entry: { level: "error", text: "Refused to connect to 'https://x.test'", source: "network", timestamp: 200 } });
    h.emitEvent("Log.entryAdded", { entry: { level: "verbose", text: "deprecation warning", source: "javascript", timestamp: 201 } });
    const list = await dispatchR(h.sandbox, "log.list", { targetId: 7 });
    ok(list.ok, `log: log.list dispatch resolves (got: ${list.ok ? "" : String(list.error?.message || list.error)})`);
    if (list.ok) {
      ok(Array.isArray(list.value.entries) && list.value.entries.length === 2, "log: Log.entryAdded entries listed");
      ok(list.value.entries[0].level === "error" && list.value.entries[0].text.includes("Refused to connect"), "log: entry carries level + text");
      ok(list.value.entries[0].source === "network", "log: entry carries its source");
      const lim = await dispatchR(h.sandbox, "log.list", { targetId: 7, limit: 1 });
      ok(lim.ok && lim.value.entries.length === 1, "log: limit caps the response");
      const clr = await dispatchR(h.sandbox, "log.list", { targetId: 7, clear: true });
      ok(clr.ok && clr.value.cleared === 2 && (h.ctxEval(`logEntriesPerTab.get(7)`) === undefined), "log: clear empties the buffer");
    }
  }

  // =====================================================================
  // 5. WS frame capture — chrome_websocket_messages (TOOL_CONTRACTS §6 row 42)
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);
    // Network-domain events only flow while the capture attach is active.
    h.ctxEval(`networkModeTabs.add(7);`);

    h.emitEvent("Network.webSocketCreated", { requestId: "ws1", url: "wss://echo.example/sock", timestamp: 100 });
    h.emitEvent("Network.webSocketFrameSent", { requestId: "ws1", timestamp: 101, response: { opcode: 1, payloadData: "hello" } });
    h.emitEvent("Network.webSocketFrameReceived", { requestId: "ws1", timestamp: 102, response: { opcode: 1, payloadData: "world" } });
    h.emitEvent("Network.webSocketClosed", { requestId: "ws1", timestamp: 103 });

    const ring = h.ctxEval(`wsFramesPerTab.get(7)`);
    ok(Array.isArray(ring) && ring.length === 4, `ws: lifecycle + frames recorded in the flat per-tab ring (got ${ring ? ring.length : "no store"})`);
    if (Array.isArray(ring) && ring.length === 4) {
      ok(ring[0].direction === "created" && ring[0].url === "wss://echo.example/sock", "ws: created event carries direction + url");
      ok(ring[1].direction === "sent" && ring[1].payloadPreview === "hello", "ws: sent frame carries direction + payload preview");
      ok(ring[2].direction === "received" && ring[2].payloadPreview === "world", "ws: received frame carries direction + payload preview");
      ok(ring[3].direction === "closed", "ws: closed event recorded");
      ok(ring.every((f) => typeof f.timestamp === "number"), "ws: every frame carries a timestamp");
    }

    // Payload preview cap: WS_PAYLOAD_PREVIEW_MAX = 2048 (payload caps, constraint #4).
    h.emitEvent("Network.webSocketFrameSent", { requestId: "ws1", timestamp: 104, response: { opcode: 2, payloadData: "z".repeat(10_000) } });
    const last = h.ctxEval(`wsFramesPerTab.get(7)`).at(-1);
    ok(last.payloadPreview.length <= 2_048 && last.payloadTruncated === true, `ws: >2KB payload is preview-truncated (got ${last.payloadPreview.length} chars, truncated=${last.payloadTruncated})`);

    // Ring cap: WS_FRAMES_MAX = 2000.
    for (let i = 0; i < 2010; i++) {
      h.emitEvent("Network.webSocketCreated", { requestId: `ws${i}`, url: `wss://x.test/${i}`, timestamp: i });
    }
    const capped = h.ctxEval(`wsFramesPerTab.get(7)`);
    ok(capped && capped.length === 2000, `ws: ring capped at 2000 (got ${capped ? capped.length : "no store"})`);

    // Read path: network.websockets list/limit/clear.
    const list = await dispatchR(h.sandbox, "network.websockets", { targetId: 7 });
    ok(list.ok, `ws: network.websockets dispatch resolves (got: ${list.ok ? "" : String(list.error?.message || list.error)})`);
    if (list.ok) {
      ok(Array.isArray(list.value.frames) && list.value.frames.length === 2000, "ws: frames array returned");
      ok(list.value.count === 2000, "ws: count reported");
      const lim = await dispatchR(h.sandbox, "network.websockets", { targetId: 7, limit: 5 });
      ok(lim.ok && lim.value.frames.length === 5, "ws: limit caps the response");
      const clr = await dispatchR(h.sandbox, "network.websockets", { targetId: 7, clear: true });
      ok(clr.ok && clr.value.cleared === 2000 && (h.ctxEval(`wsFramesPerTab.get(7)?.length ?? 0`) === 0), "ws: clear empties the per-tab ring");
    }
    h.ctxEval(`networkModeTabs.delete(7);`);
  }

  // =====================================================================
  // 6. Injected headers — chrome_network_headers (TOOL_CONTRACTS §6 row 40) + redaction
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);
    const set = await dispatchR(h.sandbox, "network.headers", { targetId: 7, headers: { Authorization: "Bearer sekret" } });
    ok(set.ok, `headers: network.headers set resolves (got: ${set.ok ? "" : String(set.error?.message || set.error)})`);
    if (set.ok) {
      const call = rec.cdpCalls.find((c) => c.method === "Network.setExtraHTTPHeaders");
      ok(!!call && call.params.headers.Authorization === "Bearer sekret", "headers: Network.setExtraHTTPHeaders sent with the injected header");
      ok(Array.isArray(set.value.injected) && set.value.injected.includes("Authorization"), "headers: response reports injected header NAMES");
      ok(set.value.summary && set.value.summary.count === 1 && set.value.summary.names[0] === "Authorization", "headers: summary carries names + count");
      ok(!JSON.stringify(set.value).includes("sekret"), "headers: header VALUES never leave the SW (redaction #10)");
      ok(h.ctxEval(`modesPerTab.get(7)?.has(MODE_HEADERS)`), "headers: MODE_HEADERS registered");
      await tick();
      const stored = rec.sessionStore[h.ctxEval(`KEEPALIVE_MODE_STORAGE_KEY`)];
      ok(stored && stored["7"] && stored["7"].headers && stored["7"].headers.headers.Authorization === "Bearer sekret", "headers: intent persisted (headers die with the attach, re-applied on re-attach)");
    }
    const clr = await dispatchR(h.sandbox, "network.headers", { targetId: 7, clear: true });
    ok(clr.ok && clr.value.clear === true && clr.value.injected.length === 0, "headers: clear reports empty injection");
    ok(rec.cdpCalls.some((c) => c.method === "Network.setExtraHTTPHeaders" && Object.keys(c.params.headers).length === 0), "headers: clear sends empty extra headers");
    ok(h.ctxEval(`modesPerTab.get(7)?.has(MODE_HEADERS)`) !== true, "headers: clear unregisters MODE_HEADERS");
  }

  // =====================================================================
  // 7. Request-cause enrichment — chrome_network_cause (TOOL_CONTRACTS §6 row 39)
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);
    h.ctxEval(`networkModeTabs.add(7);`);
    h.emitEvent("Network.requestWillBeSent", { requestId: "req-c", request: { url: "https://api.example.com/data", method: "POST", headers: { "Content-Type": "application/json" } }, type: "XHR", timestamp: 100 });
    h.emitEvent("Network.requestWillBeSentExtraInfo", { requestId: "req-c", associatedCookies: [{ cookie: { name: "sid" } }], headers: { "X-Custom": "v" }, timestamp: 101 });
    h.emitEvent("Network.responseReceived", { requestId: "req-c", response: { status: 200, headers: { "Content-Type": "application/json" } }, timestamp: 102 });
    h.emitEvent("Network.responseReceivedExtraInfo", { requestId: "req-c", blockedCookies: [{ cookie: { name: "blocked" }, blockedReasons: ["SecureOnly"] }], statusCode: 200, headers: {}, timestamp: 103 });

    const cause = await dispatchR(h.sandbox, "network.cause", { targetId: 7, requestId: "req-c" });
    ok(cause.ok, `cause: network.cause dispatch resolves (got: ${cause.ok ? "" : String(cause.error?.message || cause.error)})`);
    if (cause.ok) {
      ok(cause.value.requestId === "req-c", "cause: requestId echoed");
      ok(cause.value.url === "https://api.example.com/data" && cause.value.method === "POST", "cause: request URL + method resolved");
      ok(cause.value.status === 200, "cause: status resolved");
      ok(Array.isArray(cause.value.blockedCookies) && cause.value.blockedCookies.length === 1, "cause: blockedCookies from responseReceivedExtraInfo surfaced");
      ok(cause.value.blockedCookies[0].name === "blocked" && cause.value.blockedCookies[0].blockedReasons.includes("SecureOnly"), "cause: blocked cookie name + reasons carried");
      ok(Array.isArray(cause.value.associatedCookies) && cause.value.associatedCookies[0].name === "sid", "cause: associatedCookies from requestExtraInfo surfaced");
    }
    const missing = await dispatchR(h.sandbox, "network.cause", { targetId: 7, requestId: "never-seen" });
    ok(!missing.ok && /Specify requestId or requestUrlIncludes/.test(String(missing.error?.message || "")), "cause: unknown requestId errors");
    h.ctxEval(`networkModeTabs.delete(7);`);
  }

  // =====================================================================
  // 8. Fetch interception — chrome_network_intercept (TOOL_CONTRACTS §6 row 41).
  //    Includes the 30s per-paused-request auto-timeout cleanup + onDetach Fetch.disable.
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);

    // --- on: Fetch.enable with patterns + MODE_INTERCEPT registered + persisted ---
    const on = await dispatchR(h.sandbox, "network.intercept.on", { targetId: 7, patterns: ["*://*/*"] });
    ok(on.ok, `intercept: network.intercept.on resolves (got: ${on.ok ? "" : String(on.error?.message || on.error)})`);
    if (on.ok) {
      const call = rec.cdpCalls.filter((c) => c.method === "Fetch.enable").at(-1);
      ok(!!call && Array.isArray(call.params.patterns) && call.params.patterns[0].urlPattern === "*://*/*", "intercept: Fetch.enable sent with urlPattern patterns");
      ok(on.value.enabled === true && Array.isArray(on.value.patterns), "intercept: response echoes enabled + patterns");
      ok(h.ctxEval(`modesPerTab.get(7)?.has(MODE_INTERCEPT)`), "intercept: MODE_INTERCEPT registered");
      await tick();
      const stored = rec.sessionStore[h.ctxEval(`KEEPALIVE_MODE_STORAGE_KEY`)];
      ok(stored && stored["7"] && stored["7"].intercept && stored["7"].intercept.patterns[0] === "*://*/*", "intercept: intent persisted (interception dies with the attach)");
    }

    // --- Fetch.requestPaused → pending record + 30s auto-timeout armed ---
    const timersBefore = h.timeouts.length;
    h.emitEvent("Fetch.requestPaused", { requestId: "req1", request: { url: "https://api.example.com/x", method: "POST" }, frameId: "f1", resourceType: "XHR" });
    const pausedMap = h.ctxEval(`interceptPerTab.get(7)?.paused`);
    ok(pausedMap && pausedMap.has("req1"), "intercept: paused request recorded in the per-tab paused map");
    const pending = h.ctxEval(`interceptPerTab.get(7).paused.get("req1")`);
    ok(pending && pending.url === "https://api.example.com/x" && pending.method === "POST", "intercept: pending record carries url + method");
    const autoTimer = h.timeouts.slice(timersBefore).find((t) => t.ms === 30_000);
    ok(!!autoTimer, "intercept: a 30s auto-timeout timer is armed per paused request (constraint #5)");
    if (autoTimer) {
      autoTimer.fn();
      await tick();
      ok(rec.cdpCalls.some((c) => c.method === "Fetch.continueRequest" && c.params.requestId === "req1"), "intercept: the auto-timeout continues the still-paused request");
      ok(!h.ctxEval(`interceptPerTab.get(7).paused.has("req1")`), "intercept: auto-timed-out request is evicted from the paused map (no wedge)");
      ok(h.ctxEval(`interceptPerTab.get(7).resolved.some((r) => r.requestId === "req1" && r.action === "auto-continue-timeout")`), "intercept: the timeout is recorded in the resolved ring");
    }

    // --- Stray paused request with interception OFF is auto-continued immediately ---
    h.ctxEval(`interceptPerTab.delete(7);`);
    h.emitEvent("Fetch.requestPaused", { requestId: "stray", request: { url: "https://api.example.com/s", method: "GET" }, resourceType: "XHR" });
    await tick();
    ok(rec.cdpCalls.some((c) => c.method === "Fetch.continueRequest" && c.params.requestId === "stray"), "intercept: a stray paused request is auto-continued, never lingered");

    // --- resolve: continue / fulfill / fail (resolveAction) ---
    const on2 = await dispatchR(h.sandbox, "network.intercept.on", { targetId: 7, patterns: ["*://api.example.com/*"] });
    ok(on2.ok, "intercept: re-on for the resolve flow");
    h.emitEvent("Fetch.requestPaused", { requestId: "req2", request: { url: "https://api.example.com/y", method: "GET" }, frameId: "f1", resourceType: "XHR" });
    const cont = await dispatchR(h.sandbox, "network.intercept.resolve", { targetId: 7, action: "resolve", requestId: "req2", resolveAction: "continue" });
    ok(cont.ok, `intercept: resolve continue resolves (got: ${cont.ok ? "" : String(cont.error?.message || cont.error)})`);
    ok(cont.ok && cont.value.resolved === true && rec.cdpCalls.some((c) => c.method === "Fetch.continueRequest" && c.params.requestId === "req2"), "intercept: continueRequest sent with the requestId");

    h.emitEvent("Fetch.requestPaused", { requestId: "req3", request: { url: "https://api.example.com/z", method: "GET" }, frameId: "f1", resourceType: "XHR" });
    const ful = await dispatchR(h.sandbox, "network.intercept.resolve", { targetId: 7, action: "resolve", requestId: "req3", resolveAction: "fulfill", responseCode: 200, body: "e30=" });
    ok(ful.ok, `intercept: resolve fulfill resolves (got: ${ful.ok ? "" : String(ful.error?.message || ful.error)})`);
    ok(ful.ok && rec.cdpCalls.some((c) => c.method === "Fetch.fulfillRequest" && c.params.requestId === "req3" && c.params.responseCode === 200), "intercept: fulfillRequest sent with the requestId + responseCode");

    h.emitEvent("Fetch.requestPaused", { requestId: "req4", request: { url: "https://api.example.com/w", method: "GET" }, frameId: "f1", resourceType: "XHR" });
    const fail = await dispatchR(h.sandbox, "network.intercept.resolve", { targetId: 7, action: "resolve", requestId: "req4", resolveAction: "fail", errorReason: "BlockedByClient" });
    ok(fail.ok, `intercept: resolve fail resolves (got: ${fail.ok ? "" : String(fail.error?.message || fail.error)})`);
    ok(fail.ok && rec.cdpCalls.some((c) => c.method === "Fetch.failRequest" && c.params.requestId === "req4" && c.params.errorReason === "BlockedByClient"), "intercept: failRequest sent with the errorReason");

    // Resolving an already-resolved / unknown request errors.
    const bad = await dispatchR(h.sandbox, "network.intercept.resolve", { targetId: 7, action: "resolve", requestId: "req2", resolveAction: "continue" });
    ok(!bad.ok && /not currently paused/.test(String(bad.error?.message || "")), "intercept: resolving a non-paused request errors");

    // --- list ---
    const list = await dispatchR(h.sandbox, "network.intercept.list", { targetId: 7, action: "list" });
    ok(list.ok && list.value.enabled === true && Array.isArray(list.value?.paused), "intercept: network.intercept.list returns the pending array");
    ok(list.ok && list.value.paused.every((p) => typeof p.pausedAt === "number"), "intercept: listed pauses carry pausedAt");

    // --- off: Fetch.disable + MODE_INTERCEPT unregistered ---
    const off = await dispatchR(h.sandbox, "network.intercept.off", { targetId: 7, action: "off" });
    ok(off.ok, `intercept: network.intercept.off resolves (got: ${off.ok ? "" : String(off.error?.message || off.error)})`);
    ok(off.ok && off.value.enabled === false && rec.cdpCalls.some((c) => c.method === "Fetch.disable"), "intercept: off sends Fetch.disable");
    ok(h.ctxEval(`modesPerTab.get(7)?.has(MODE_INTERCEPT)`) !== true, "intercept: off unregisters MODE_INTERCEPT");
    ok(h.ctxEval(`interceptPerTab.has(7)`) === false, "intercept: off drops the per-tab intercept state");

    // --- detach cleanup: onDetach → cleanupModesForTab → MODE_INTERCEPT.onDetach → Fetch.disable ---
    h.ctxEval(`attachedTabs.set(7, { detachAt: Date.now() + 999999, pointer: {x:0,y:0}, debuggee: { tabId: 7 } });`);
    h.sandbox.registerMode(7, h.ctxEval(`MODE_INTERCEPT`));
    h.ctxEval(`interceptPerTab.set(7, { patterns: ["*://*/*"], paused: new Map([["req5", { requestId: "req5", url: "u", method: "GET", pausedAt: Date.now(), timer: null }]]), resolved: [] });`);
    const disablesBefore = rec.cdpCalls.filter((c) => c.method === "Fetch.disable").length;
    h.fireDetach("target_closed");
    await tick();
    ok(rec.cdpCalls.filter((c) => c.method === "Fetch.disable").length > disablesBefore, "detach: MODE_INTERCEPT.onDetach sends Fetch.disable (no orphaned paused requests)");
    ok(h.ctxEval(`interceptPerTab.has(7)`) === false, "detach: per-tab intercept state dropped");
    ok(h.ctxEval(`modesPerTab.has(7)`) === false, "detach: per-tab membership drained");
  }

  console.log(`\nconsole-network: ${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
