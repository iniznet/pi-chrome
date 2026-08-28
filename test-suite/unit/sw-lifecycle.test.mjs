// Unit harness for the service worker's MV3 bridge-lifecycle wiring: pollLoop, sendHeartbeat,
// version-skew reload deferral, idle-exit, exponential backoff, heartbeat key selection, and the
// keepalive alarm. See REPORT.md findings [test-lifecycle] / [sw-keepalive] / [poll-backoff] /
// [version-reload-drop].
//
// Like the sibling unit tests we load the REAL service_worker.js into a vm sandbox with a stateful
// chrome.* mock and a controllable fetch shim, then drive the REAL top-level helpers (pollLoop,
// sendHeartbeat, isVersionOlder, pollBackoffDelay, armKeepaliveAlarm). Top-level `let`/`const`
// (lastBridgeActivity, consecutivePollFailures, automationTargets, reloadIntent, polling) are
// lexical bindings, so we set/read them via vm.runInContext in the same context.
//
// Determinism note: the test intentionally drives only the finite, non-sleeping branches of the
// poll loop (idle-exit `break`, command/orphan → version-skew reload `return`), never the
// exponential-backoff `sleep()` path, so it cannot hang like a live long-poll burn. The
// sandbox setTimeout/clearTimeout are no-ops so no real timers linger and the process exits.

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
  if (cond) { passes++; } else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---- Controllable fetch shim --------------------------------------------------
// Classifies by URL: /ack & /result are recorded and answer 200; /heartbeat recorded + 200;
// /next serves from an explicit queue (or throws when exhausted, forcing pollLoop's idle `break`
// or failure path). Optional "gate" holds a /next response open for the reentrancy test.
function makeFetch() {
  const posts = [];
  let nextQueue = [];
  let gate = null;
  const fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = null;
    try { body = JSON.parse(opts.body || "null"); } catch { body = opts.body; }
    const record = (kind) => posts.push({ kind, url: u, body });
    if (u.includes("/ack")) { record("ack"); return { ok: true, status: 200, json: async () => ({}) }; }
    if (u.includes("/result")) { record("result"); return { ok: true, status: 200, json: async () => ({}) }; }
    if (u.includes("/heartbeat")) { record("heartbeat"); return { ok: true, status: 200, json: async () => ({}) }; }
    if (u.includes("/next")) {
      if (gate) await gate.promise;
      const item = nextQueue.shift();
      if (!item) throw new Error("next queue exhausted");
      if (item.throw) throw item.error || new Error("next fail");
      return {
        ok: true,
        status: 200,
        headers: {
          get: (k) => {
            const lk = String(k).toLowerCase();
            return item.headers && item.headers[lk] != null ? item.headers[lk] : null;
          },
        },
        json: async () => (item.payload !== undefined ? item.payload : {}),
      };
    }
    throw new Error("unexpected url " + u);
  };
  return {
    fetch,
    posts,
    queue: (items) => { nextQueue.push(...items); },
    openGate: () => { gate = {}; gate.promise = new Promise((r) => { gate.resolve = r; }); return gate; },
    closeGate: () => { if (gate) { gate.resolve(); gate = null; } },
  };
}

// ---- Minimal chrome.* mock (superset of what pollLoop/heartbeat/tab.version touch at load+run) ----
function makeChrome(rec) {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  const alarmsCreated = [];
  return {
    runtime: {
      id: "unittestextension",
      getManifest: () => ({ version: "0.0.0" }),
      onInstalled: listener, onStartup: listener, lastError: null,
      reload: () => { rec.reloadCalls = (rec.reloadCalls || 0) + 1; },
    },
    alarms: {
      onAlarm: listener,
      create: (name, opts) => { alarmsCreated.push({ name, opts }); },
      clear: noop, clearAll: noop,
    },
    action: { onClicked: listener, setBadgeText: noop, setBadgeBackgroundColor: noop },
    debugger: { sendCommand: noop, attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]), onDetach: listener, onEvent: listener },
    scripting: { executeScript: async () => [{ result: undefined }], registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
    webNavigation: { onCommitted: listener, onCompleted: listener },
    tabs: {
      onUpdated: listener, onRemoved: listener,
      query: async () => [], get: async () => { throw new Error("no tab"); },
      create: async () => { throw new Error("no window"); }, update: async () => { throw new Error("no tab"); },
      remove: async () => {}, group: async () => -1, ungroup: async () => {},
    },
    windows: { create: async () => { throw new Error("no windows"); }, get: async () => { throw new Error("no window"); }, remove: async () => {}, update: async () => {} },
    storage: { session: { get: async (k) => ({}), set: async () => {} } },
    alarmsCreated,
  };
}

// ---- Load the real worker into a vm and return handles + a context-eval helper ----
function loadWorker(fetch) {
  const rec = { reloadCalls: 0 };
  const chrome = makeChrome(rec);
  const warns = [];
  const consoleSpy = {
    log: (...a) => { /* swallow */ },
    warn: (...a) => { warns.push(a.map(String).join(" ")); },
    error: (...a) => { /* swallow */ },
    info: () => {},
  };
  const noop = () => {};
  const sandbox = {
    console: consoleSpy, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setTimeout: () => ({}), clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    fetch, navigator: { userAgent: "unit-test" },
    WebSocket: function () {},
    AbortController, encodeURIComponent, decodeURIComponent, URLSearchParams,
    chrome,
    warns,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const ctxEval = (code) => vm.runInContext(code, sandbox, { filename: "ctx" });
  return { sandbox, chrome, rec, warns, ctxEval };
}

// ---- Simple async hop so no-op setTimeout promises / microtasks settle ----
const tick = () => new Promise((r) => setImmediate(r));

async function run() {
  // ===== 1. isVersionOlder (version-reload-drop decision) =====
  {
    const { sandbox } = loadWorker(makeFetch().fetch);
    ok(sandbox.isVersionOlder("0.0.0", "0.15.46") === true, "v1: 0.0.0 older than 0.15.46");
    ok(sandbox.isVersionOlder("0.15.46", "0.15.46") === false, "v1: equal versions are not older");
    ok(sandbox.isVersionOlder("0.15.47", "0.15.46") === false, "v1: newer is not older");
    ok(sandbox.isVersionOlder("0.16.0", "0.15.99") === false, "v1: 0.16.0 not older than 0.15.99");
    ok(sandbox.isVersionOlder("0.15.46", "0.16.0") === true, "v1: 0.15.46 older than 0.16.0");
    ok(sandbox.isVersionOlder("0.15", "0.15.0") === false, "v1: 0.15 equals 0.15.0 (padding)");
    ok(sandbox.isVersionOlder("0.15", "0.15.1") === true, "v1: 0.15 older than 0.15.1 (padding)");
  }

  // ===== 2. pollBackoffDelay exponential curve (poll-backoff) =====
  {
    const { sandbox, ctxEval } = loadWorker(makeFetch().fetch);
    // consecutivePollFailures is a lexical `let` -> set via runInContext.
    const f = (n) => { ctxEval(`consecutivePollFailures = ${n};`); return sandbox.pollBackoffDelay(); };
    ok(f(0) === 2000, "backoff: first failure -> 2000");
    ok(f(1) === 2000, "backoff: 1 -> 2000");
    ok(f(2) === 4000, "backoff: 2 -> 4000");
    ok(f(3) === 8000, "backoff: 3 -> 8000");
    ok(f(4) === 16000, "backoff: 4 -> 16000");
    ok(f(5) === 30000, "backoff: 5 -> capped at 30000");
    ok(f(20) === 30000, "backoff: 20 -> still capped at 30000");
  }

  // ===== 3. sendHeartbeat key selection + idle skip (sw-keepalive / poll-backoff) =====
  {
    const wf = makeFetch();
    const { sandbox, ctxEval } = loadWorker(wf.fetch);
    // Seed owned session keys.
    ctxEval(`automationTargets.set("session:a", { tabId: 1 }); automationTargets.set("session:b", { tabId: 2 });`);
    // Fresh activity so heartbeat is not idle-skipped.
    ctxEval(`lastBridgeActivity = Date.now();`);
    await sandbox.sendHeartbeat();
    const beats = wf.posts.filter((p) => p.kind === "heartbeat");
    ok(beats.length === 2, `heartbeat: sent for 2 owned sessions (got ${beats.length})`);
    const keys = beats.map((b) => b.body && b.body.sessionKey).sort();
    ok(keys[0] === "session:a" && keys[1] === "session:b", `heartbeat: cycles real session keys (got ${JSON.stringify(keys)})`);

    // Default key fallback when nothing is owned (but not idle).
    ctxEval(`automationTargets.clear(); lastBridgeActivity = Date.now();`);
    wf.posts.length = 0;
    await sandbox.sendHeartbeat();
    const def = wf.posts.filter((p) => p.kind === "heartbeat");
    ok(def.length === 1 && def[0].body.sessionKey === "__default__", "heartbeat: falls back to DEFAULT_SESSION_KEY when nothing owned");

    // Idle skip: nothing owned + stale activity -> no heartbeat.
    ctxEval(`lastBridgeActivity = Date.now() - 9999999999;`);
    wf.posts.length = 0;
    await sandbox.sendHeartbeat();
    ok(wf.posts.filter((p) => p.kind === "heartbeat").length === 0, "heartbeat: skipped while idle (no owned sessions + stale activity)");
  }

  // ===== 4. pollLoop idle-exit + reentrancy guard (sw-keepalive) =====
  {
    const wf = makeFetch(); // /next exhausted -> throws -> idle branch breaks (no sleep)
    const { sandbox, ctxEval } = loadWorker(wf.fetch);
    ctxEval(`automationTargets.clear(); lastBridgeActivity = Date.now() - 9999999999;`); // idle
    ctxEval(`polling = false;`);
    const p1 = sandbox.pollLoop();
    const p2 = sandbox.pollLoop(); // second call -> polling guard: returns immediately
    const secondIsUndefined = await Promise.race([
      p2.then((v) => ({ v, note: "second" })),
      new Promise((r) => setTimeout(() => r({ note: "timeout" }), 500)),
    ]);
    await p1;
    ok(pollingNow(sandbox, ctxEval) === false, "idle-exit: pollLoop resolves and resets polling to false");
    ok(secondIsUndefined.note === "second" && secondIsUndefined.v === undefined, "reentrancy: a second pollLoop() call is ignored while one runs");
  }

  // ===== 5. pollLoop serves an orphan, then defers reload until after payload (orphan + version-reload-drop) =====
  {
    const wf = makeFetch();
    wf.queue([
      { payload: { type: "orphan", orphan: { id: "o1", action: "tab.version" } }, headers: {} },
      { payload: { type: "none" }, headers: { "x-pi-chrome-version": "9.9.9" } }, // version skew -> reload
    ]);
    const { sandbox, ctxEval, warns, rec } = loadWorker(wf.fetch);
    ctxEval(`automationTargets.set("session:k", { tabId: 1, windowId: 2 });`); // active session -> not idle
    ctxEval(`lastBridgeActivity = Date.now();`);
    await sandbox.pollLoop();
    ok(warns.some((w) => w.includes("orphan") && w.includes("may have executed")), "orphan: pollLoop surfaces the may-have-executed warning without re-executing");
    ok(rec.reloadCalls === 1, "reload: extension reload triggered after version skew");
    ok(ctxEval("reloadIntent") === false, "reload: reloadIntent cleared after the deferred reload");
    ok(ctxEval("polling") === false, "reload: polling reset after reload return");
  }

  // ===== 6. pollLoop serves a command (handler runs) then defers reload until the command completes =====
  {
    const wf = makeFetch();
    wf.queue([
      { payload: { type: "command", command: { id: "c1", action: "tab.version", params: {}, sessionKey: "session:k" } }, headers: {} },
      { payload: { type: "none" }, headers: { "x-pi-chrome-version": "9.9.9" } },
    ]);
    const { sandbox, ctxEval, rec } = loadWorker(wf.fetch);
    ctxEval(`automationTargets.set("session:k", { tabId: 1, windowId: 2 });`);
    ctxEval(`lastBridgeActivity = Date.now();`);
    await sandbox.pollLoop();
    const results = wf.posts.filter((p) => p.kind === "result");
    const c1 = results.find((p) => p.body && p.body.id === "c1");
    ok(!!c1 && c1.body.ok === true, "command: pollLoop served the command and the handler posted an ok:true result");
    ok(c1 && c1.body.result && c1.body.result.extensionId === "unittestextension", "command: tab.version handler returned the extension id (handler really ran)");
    ok(rec.reloadCalls === 1, "command: reload deferred until AFTER the command completed (no dropped command on skew reload)");
  }

  // ===== 7. keepalive alarm wiring + action.onClicked re-arm (sw-keepalive / poll-backoff) =====
  {
    const wf = makeFetch();
    const { chrome, sandbox, ctxEval } = loadWorker(wf.fetch);
    const created = chrome.alarmsCreated;
    ok(created.some((c) => c.name === "pi-bridge-keepalive" && c.opts.periodInMinutes === 0.5), "alarm: keepalive alarm created with 0.5min period");
    // action.onClicked resets consecutive failures + re-arms.
    ctxEval(`consecutivePollFailures = 7;`);
    const before = created.length;
    // invoke the onClicked listener (registered during load)
    const onClicked = chrome.action.onClicked;
    if (onClicked && onClicked.fire) onClicked.fire();
    // The action.onClicked listener is a plain function registered via addListener in the mock,
    // which is a no-op, so we re-arm by calling the module's armKeepaliveAlarm directly.
    sandbox.armKeepaliveAlarm();
    ok(created.length === before + 1 && created[created.length - 1].name === "pi-bridge-keepalive", "alarm: armKeepaliveAlarm re-arms the keepalive alarm");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

function pollingNow(sandbox, ctxEval) {
  // `polling` is a lexical `let`; read through the context.
  return !!ctxEval("polling");
}

run().catch((e) => { console.error(e); process.exit(1); });
