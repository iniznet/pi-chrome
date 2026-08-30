// Unit harness for the M0 node resolver in service_worker.js (TOOL_CONTRACTS.md §3.1) — the
// uid/selector → CDP nodeId resolution shared by every DOM/CSS tool (chrome_computed_style,
// chrome_box_model, chrome_event_listeners, ...).
//
// Like sw-lifecycle.test.mjs we load the REAL service_worker.js into a vm sandbox with a
// method-routable chrome.debugger mock and drive the real helpers:
//   (1) parseFrameUid — el-f<frameId>-<uid> frame-uid parsing + non-uid rejection
//   (2) resolveCdpNode top-frame — happy path (objectId + nodeId + frameId 0) and the two
//       staleness errors: `__piStale` (element disconnected) and `__piNotFound` (no element),
//       both surfaced with the contract "take a fresh chrome_snapshot" language
//   (3) resolveCdpNode sub-frame — DOM.getFrameOwner → resolveNode → callFunctionOn routing,
//       per-frame staleness error, and the cross-origin (OOPIF) rejection; the owner
//       objectId is released
//   (4) evaluation failures + DOM.requestNode returning no nodeId are surfaced cleanly
//
// Node-ids are document-scoped and invalidated on navigation (risk #8): the resolver never
// caches — every call re-resolves, and stale uids produce a clear error instead of a CDP
// failure. All assertions target already-shipped M0 code and must stay green.

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
async function errorOf(fn) {
  try { await fn(); return null; }
  catch (e) { return e; }
}
async function errorMatches(fn, re, msg) {
  const e = await errorOf(fn);
  ok(e !== null && re.test(String(e.message || e)), `${msg} (got: ${e ? e.message : "no throw"})`);
}

// ---- Method-routable chrome.debugger mock ------------------------------------
// scenarios.evaluate controls the top-frame Runtime.evaluate result; scenarios.callFunctionOn
// controls the sub-frame DOM lookup result; calls[] records every CDP command sent.
function makeChrome(scenarios, calls) {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  return {
    runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null, reload: noop, getURL: (p) => p },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener, setBadgeText: noop, setBadgeBackgroundColor: noop },
    debugger: {
      sendCommand: async (_debuggee, method, params, cb) => {
        calls.push(method);
        if (method === "Runtime.evaluate") {
          if (scenarios.evaluateException) return cb({ exceptionDetails: { text: scenarios.evaluateException } });
          if (scenarios.evaluate) return cb({ result: { value: scenarios.evaluate } });
          return cb({ result: { objectId: "obj-1" } });
        }
        if (method === "DOM.enable") return cb({});
        if (method === "DOM.requestNode") {
          if (scenarios.noNodeId) return cb({});
          return cb({ nodeId: scenarios.nodeId ?? 42 });
        }
        if (method === "DOM.getFrameOwner") return cb({ nodeId: 100 });
        if (method === "DOM.resolveNode") return cb({ object: { objectId: "frame-obj" } });
        if (method === "Runtime.callFunctionOn") {
          if (scenarios.callFunctionOn) return cb({ result: { value: scenarios.callFunctionOn } });
          return cb({ result: { objectId: "child-obj" } });
        }
        return cb({});
      },
      attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]), onDetach: listener, onEvent: listener,
    },
    scripting: { executeScript: async () => [{ result: undefined }], registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
    webNavigation: { onCommitted: listener, onCompleted: listener, getAllFrames: async () => [] },
    tabs: {
      onUpdated: listener, onRemoved: listener,
      query: async () => [], get: async () => { throw new Error("no tab"); },
      create: async () => { throw new Error("no window"); }, update: async () => {}, remove: async () => {}, group: async () => -1, ungroup: async () => {},
    },
    windows: { create: async () => { throw new Error("no windows"); }, get: async () => { throw new Error("no window"); }, remove: async () => {}, update: async () => {} },
    storage: { session: { get: async () => ({}), set: async () => {} } },
  };
}

function loadWorker(scenarios, calls) {
  const chrome = makeChrome(scenarios, calls);
  const warns = [];
  const consoleSpy = { log: () => {}, warn: (...a) => { warns.push(a.map(String).join(" ")); }, error: () => {}, info: () => {} };
  const noop = () => {};
  const sandbox = {
    console: consoleSpy, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setTimeout: () => ({}), clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    fetch: async () => { throw new Error("no fetch in node-resolver harness"); },
    navigator: { userAgent: "unit-test" },
    WebSocket: function () {}, AbortController, encodeURIComponent, decodeURIComponent, URLSearchParams,
    chrome,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const ctxEval = (code) => vm.runInContext(code, sandbox, { filename: "ctx" });
  return { sandbox, chrome, warns, ctxEval };
}

async function run() {
  // ===== 1. parseFrameUid. =====
  {
    const { sandbox } = loadWorker({}, []);
    const parse = sandbox.parseFrameUid;
    const valid = parse("el-f3-btn");
    ok(valid && valid.frameId === 3 && valid.localUid === "el-btn", "frameUid: el-f3-btn parses to frame 3 / el-btn");
    const multi = parse("el-f10-save-button");
    ok(multi && multi.frameId === 10 && multi.localUid === "el-save-button", "frameUid: multi-segment local uid keeps its el- prefix");
    ok(parse("el-1") === null, "frameUid: plain top-frame uid is not a frame uid");
    ok(parse("") === null && parse(null) === null && parse(42) === null, "frameUid: empty/null/non-string rejected");
    ok(parse("el-fx-btn") === null, "frameUid: non-numeric frame id rejected");
  }

  // ===== 2. resolveCdpNode top-frame happy path. =====
  {
    const scenarios = {};
    const calls = [];
    const { sandbox } = loadWorker(scenarios, calls);
    const resolved = await sandbox.resolveCdpNode(7, { selector: "#submit" });
    ok(resolved.objectId === "obj-1" && resolved.nodeId === 42 && resolved.frameId === 0, "resolve: returns { objectId, nodeId, frameId: 0 } for a top-frame selector");
    ok(calls.includes("Runtime.evaluate") && calls.includes("DOM.enable") && calls.includes("DOM.requestNode"), "resolve: evaluate -> DOM.enable -> DOM.requestNode sequence");
    // Same path for a snapshot uid.
    const byUid = await sandbox.resolveCdpNode(7, { uid: "el-5" });
    ok(byUid.nodeId === 42, "resolve: uid resolution follows the same CDP path");
  }

  // ===== 3. Staleness: element disconnected since the snapshot (top frame). =====
  {
    const scenarios = { evaluate: "__piStale" };
    const { sandbox } = loadWorker(scenarios, []);
    await errorMatches(
      () => sandbox.resolveCdpNode(7, { uid: "el-9" }),
      /Snapshot uid el-9 refers to an element that is no longer connected to the document — take a fresh chrome_snapshot and retry\./,
      "stale: disconnected element surfaces the contract fresh-snapshot error",
    );
  }

  // ===== 4. Staleness: no element for the uid/selector (top frame). =====
  {
    const scenarios = { evaluate: "__piNotFound" };
    const { sandbox } = loadWorker(scenarios, []);
    await errorMatches(
      () => sandbox.resolveCdpNode(7, { uid: "el-99" }),
      /No element found in the live document for snapshot uid el-99 — take a fresh chrome_snapshot or check the selector\./,
      "stale: missing uid surfaces the not-found error",
    );
    await errorMatches(
      () => sandbox.resolveCdpNode(7, { selector: "#gone" }),
      /No element found in the live document for selector #gone — take a fresh chrome_snapshot or check the selector\./,
      "stale: missing selector surfaces the not-found error",
    );
  }

  // ===== 5. Sub-frame resolution (OOPIF-adjacent same-origin frame routing). =====
  {
    const scenarios = {};
    const calls = [];
    const { sandbox } = loadWorker(scenarios, calls);
    const resolved = await sandbox.resolveCdpNode(7, { uid: "el-f4-save" });
    ok(resolved.objectId === "child-obj" && resolved.nodeId === 42 && resolved.frameId === 4, "resolve: sub-frame uid routes via frameId and returns the child object");
    ok(calls.includes("DOM.getFrameOwner") && calls.includes("DOM.resolveNode") && calls.includes("Runtime.callFunctionOn"), "resolve: sub-frame uses getFrameOwner -> resolveNode -> callFunctionOn");
    ok(calls.includes("Runtime.releaseObject"), "resolve: the frame-owner objectId is released after the lookup");
  }

  // ===== 6. Sub-frame staleness error. =====
  {
    const scenarios = { callFunctionOn: "__piStale" };
    const { sandbox } = loadWorker(scenarios, []);
    await errorMatches(
      () => sandbox.resolveCdpNode(7, { uid: "el-f4-save" }),
      /Snapshot uid el-save refers to an element that is no longer connected in frame 4 — take a fresh chrome_snapshot and retry\./,
      "stale: sub-frame disconnect surfaces the per-frame fresh-snapshot error",
    );
  }

  // ===== 7. Cross-origin (OOPIF) sub-frame rejection. =====
  {
    const scenarios = { callFunctionOn: "__piNotFound" };
    const { sandbox } = loadWorker(scenarios, []);
    await errorMatches(
      () => sandbox.resolveCdpNode(7, { uid: "el-f4-save" }),
      /No element found in frame 4 for snapshot uid el-save — cross-origin \(OOPIF\) frames cannot be reached for DOM resolution\./,
      "oopif: missing sub-frame element surfaces the cross-origin guidance",
    );
  }

  // ===== 8. Evaluation failure surfaced cleanly. =====
  {
    const scenarios = { evaluateException: "ReferenceError: nope" };
    const { sandbox } = loadWorker(scenarios, []);
    await errorMatches(
      () => sandbox.resolveCdpNode(7, { selector: "#x" }),
      /Could not resolve element: ReferenceError: nope/,
      "errors: Runtime.evaluate exceptionDetails are surfaced",
    );
  }

  // ===== 9. DOM.requestNode returning no nodeId. =====
  {
    const scenarios = { noNodeId: true };
    const { sandbox } = loadWorker(scenarios, []);
    await errorMatches(
      () => sandbox.resolveCdpNode(7, { selector: "#x" }),
      /Could not resolve element node \(DOM\.requestNode returned no nodeId\)/,
      "errors: requestNode without nodeId fails cleanly",
    );
  }

  // ===== 10. No params: resolver errors instead of guessing. =====
  {
    const scenarios = { evaluate: "__piNotFound" };
    const { sandbox } = loadWorker(scenarios, []);
    const err = await errorOf(() => sandbox.resolveCdpNode(7, {}));
    ok(err !== null, "errors: no selector/uid resolves to a not-found error, never a crash");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
