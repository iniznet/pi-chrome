// Unit harness for the P1A debugger family — chrome_pause / chrome_resume / chrome_step /
// chrome_breakpoint / chrome_get_call_stack / chrome_evaluate_in_frame / chrome_get_script_source /
// chrome_set_pause_on_exceptions (TOOL_CONTRACTS.md §6 rows 29–36, §3.5 rail, §3.2 registry).
//
// Loads the REAL service_worker.js into a vm sandbox (sw-lifecycle / keepalive-registry pattern)
// with an emittable chrome.debugger.onEvent/onDetach, a CDP method recorder that (like real
// Chrome) synchronously emits Debugger.paused/resumed for pause/step commands, per-method
// responses/errors, stateful chrome.storage.session, and recording setTimeout/setInterval (sub-
// second timers auto-execute so the sleep(30) pause-wait loops progress; the ≥1s timers are
// recorded and fired manually — no real waits, no hangs).
//
// Sections 1–7 drive the M0 plumbing (paused tracker, auto-resume rail, resumed event, idle
// sweep, onDetach cleanup). Section 8 exercises the P1A debugger-family dispatch surface against
// the real handlers. All sections must stay green with the P1A SW batch in the tree.
//
// Run: node test-suite/unit/debugger-family.test.mjs  (package.json test script is owned by Verify)

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

// ---- Emittable listener: fire(...) drives the REAL SW listeners (Debugger.paused, onDetach). ----
function makeListener() {
  const cbs = [];
  return { addListener: (cb) => { cbs.push(cb); }, removeListener: () => {}, fire: (...a) => { for (const cb of cbs.slice()) cb(...a); } };
}

// ---- Stateful chrome mock: records every CDP method + params; per-method responses/errors. ----
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
        const source = { tabId: debuggee?.tabId ?? debuggee?.targetId };
        // Mirror real Chrome: Debugger.pause/step commands synchronously produce the paused
        // event so the handlers' wait loops observe the new paused stack without real sleeps.
        if (method === "Debugger.pause") {
          chrome.debugger.onEvent.fire(source, "Debugger.paused", {
            reason: "debugCommand",
            callFrames: [{ callFrameId: "cf0", functionName: "main", url: "https://app.example/app.js", scriptId: "s1", lineNumber: 1, columnNumber: 0 }],
          });
        }
        if (method === "Debugger.stepInto" || method === "Debugger.stepOver" || method === "Debugger.stepOut") {
          chrome.debugger.onEvent.fire(source, "Debugger.resumed", {});
          chrome.debugger.onEvent.fire(source, "Debugger.paused", {
            reason: "step",
            callFrames: [{ callFrameId: "cf0", functionName: "main", url: "https://app.example/app.js", scriptId: "s1", lineNumber: 2, columnNumber: 0 }],
          });
        }
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

// ---- Load the real worker. Sub-second timers (sleep(30)/80/500) auto-execute so the
// debugger wait loops progress; ≥1s timers are recorded for manual firing. ----
function loadWorker(rec) {
  const chrome = makeChrome(rec);
  const warns = [];
  const consoleSpy = { log: () => {}, warn: (...a) => { warns.push(a.map(String).join(" ")); }, error: () => {}, info: () => {} };
  const timeouts = [];
  const intervals = [];
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
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
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
    sandbox, chrome, rec, warns, ctxEval, timeouts, intervals,
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
  // 1. Debugger.paused tracker shape (M0 + P1A callFrameId/scopeChain) — GREEN
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);
    const frames = Array.from({ length: 60 }, (_, i) => ({
      callFrameId: `cf${i}`, functionName: `f${i}`, url: "https://app.example/app.js",
      scriptId: `s${i}`, lineNumber: i, columnNumber: 0,
      scopeChain: [{ type: "local", object: { objectId: `obj${i}` } }, { type: "global", object: { objectId: `g${i}` } }],
    }));
    h.emitEvent("Debugger.paused", { reason: "debugCommand", callFrames: frames });
    const paused = h.ctxEval(`pausedTabs.get(7)`);
    ok(!!paused && paused.reason === "debugCommand", "paused: reason recorded from the event");
    ok(Array.isArray(paused.callFrames) && paused.callFrames.length === 50, `paused: call frames capped at 50 (got ${paused.callFrames.length})`);
    ok(paused.callFrames[0].callFrameId === "cf0" && paused.callFrames[0].scriptId === "s0", "paused: callFrameId/scriptId preserved for evalFrame");
    ok(paused.callFrames[0].scopeChain.length === 2, "paused: scope chain capped and kept for callStack previews");
    ok(paused.callFrames[0].functionName === "f0" && paused.callFrames[0].lineNumber === 0, "paused: frame fields normalized");
    ok(typeof paused.timestamp === "number", "paused: timestamp recorded");
    ok(h.ctxEval(`modesPerTab.get(7)?.has(MODE_PAUSED)`), "paused: MODE_PAUSED registered in the keepalive registry");
    h.emitEvent("Debugger.paused", {});
    const degraded = h.ctxEval(`pausedTabs.get(7)`);
    ok(degraded.reason === "other" && Array.isArray(degraded.callFrames) && degraded.callFrames.length === 0, "paused: reason-less event degrades to 'other' + empty frames");
  }

  // =====================================================================
  // 2. Auto-resume rail — ensurePageUsable (M0, GREEN)
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);
    h.ctxEval(`pausedTabs.set(7, { reason: "debugCommand", callFrames: [], timestamp: Date.now() });`);
    h.sandbox.registerMode(7, h.ctxEval(`MODE_PAUSED`));

    const note = await h.sandbox.ensurePageUsable(7, "evaluate");
    ok(rec.cdpCalls.some((c) => c.method === "Debugger.resume"), "rail: Debugger.resume sent before the frozen-page command");
    ok(note && note.wasPaused === true && note.reason === "debugCommand" && note.resumedBefore === "evaluate", "rail: resume note carries wasPaused/reason/resumedBefore");
    ok(typeof note.at === "number", "rail: resume note carries a timestamp");
    ok(h.ctxEval(`pausedTabs.has(7)`) === false, "rail: paused state cleared after auto-resume");
    ok(h.ctxEval(`modesPerTab.get(7)?.has(MODE_PAUSED)`) !== true, "rail: MODE_PAUSED unregistered after auto-resume");
    ok(h.ctxEval(`pauseResumeEvents`).some((e) => e.resumedBefore === "evaluate"), "rail: the resume is recorded in the diagnostics ring");

    const before = rec.cdpCalls.filter((c) => c.method === "Debugger.resume").length;
    const none = await h.sandbox.ensurePageUsable(7, "snapshot");
    ok(none === null, "rail: not-paused tab returns null");
    ok(rec.cdpCalls.filter((c) => c.method === "Debugger.resume").length === before, "rail: no resume CDP call for an unpaused tab");
  }

  // =====================================================================
  // 3. Rail failure path: a failed Debugger.resume must NOT throw and must NOT hang
  //    (falls through to the CDP command's own timeout instead — constraint #3).
  // =====================================================================
  {
    const rec = { sessionStore: {}, cdpErrors: { "Debugger.resume": "Debugger is not attached" } };
    const h = loadWorker(rec);
    h.ctxEval(`pausedTabs.set(7, { reason: "debugCommand", callFrames: [], timestamp: Date.now() });`);
    let resolved = false;
    const p = h.sandbox.ensurePageUsable(7, "evaluate").then((n) => { resolved = true; return n; });
    const note = await Promise.race([p, new Promise((r) => setTimeout(() => r("TIMEOUT"), 1500))]);
    ok(resolved && note !== "TIMEOUT", "rail-fail: ensurePageUsable resolves even when the resume CDP call fails (never hangs)");
    ok(note && note.wasPaused === true, "rail-fail: resume note still returned");
    ok(h.ctxEval(`pausedTabs.has(7)`) === false, "rail-fail: paused state cleared despite the failed resume");
    ok(h.warns.some((w) => w.includes("auto-resume")), "rail-fail: the failed resume is logged as a warning");
  }

  // =====================================================================
  // 4. Full paused-page flow: Debugger.paused → withPauseRail(evaluate) auto-resumes
  //    (resume strictly before the evaluate CDP call), never hangs, note merged.
  // =====================================================================
  {
    const rec = { sessionStore: {}, cdpResponses: { "Runtime.evaluate": { result: { type: "number", value: 2 } } } };
    const h = loadWorker(rec);
    h.emitEvent("Debugger.paused", { reason: "debugCommand", callFrames: [{ functionName: "main", url: "https://app.example/app.js", lineNumber: 1, columnNumber: 0 }] });
    let resolved = false;
    const p = h.sandbox.withPauseRail(7, "evaluate", () => h.sandbox.cdp(7, "Runtime.evaluate", { expression: "1+1" })).then((v) => { resolved = true; return v; });
    const result = await Promise.race([p, new Promise((r) => setTimeout(() => r("TIMEOUT")), 1500)]);
    ok(resolved && result !== "TIMEOUT", "flow: pause → evaluate auto-resumes and resolves (never hangs)");
    ok(rec.cdpCalls.some((c) => c.method === "Debugger.resume"), "flow: Debugger.resume sent");
    ok(rec.cdpCalls.some((c) => c.method === "Runtime.evaluate"), "flow: evaluate actually ran after the resume");
    const ri = rec.cdpCalls.findIndex((c) => c.method === "Debugger.resume");
    const ei = rec.cdpCalls.findIndex((c) => c.method === "Runtime.evaluate");
    ok(ri !== -1 && ei !== -1 && ri < ei, "flow: resume strictly precedes the evaluate CDP call");
    ok(result.pausedAutoResumed && result.pausedAutoResumed.wasPaused === true && result.pausedAutoResumed.resumedBefore === "evaluate", "flow: pausedAutoResumed note merged into the object result");
    ok(result.result && result.result.value === 2, "flow: the evaluate result is intact");

    h.ctxEval(`pausedTabs.set(7, { reason: "debugCommand", callFrames: [], timestamp: Date.now() });`);
    const raw = await h.sandbox.withPauseRail(7, "input", () => undefined);
    ok(raw === undefined, "flow: undefined (non-object) result passes through untouched");
  }

  // =====================================================================
  // 5. Debugger.resumed clears the paused tracker + MODE_PAUSED (M0, GREEN)
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);
    h.emitEvent("Debugger.paused", { reason: "debugCommand", callFrames: [] });
    ok(h.ctxEval(`pausedTabs.has(7)`), "resumed: pause recorded first");
    h.emitEvent("Debugger.resumed", {});
    ok(h.ctxEval(`pausedTabs.has(7)`) === false, "resumed: Debugger.resumed clears the paused tracker");
    ok(h.ctxEval(`modesPerTab.get(7)?.has(MODE_PAUSED)`) !== true, "resumed: MODE_PAUSED unregistered");
  }

  // =====================================================================
  // 6. Idle-detach sweep: paused/mode tabs are exempt (re-extended), idle tabs detach (M0, GREEN)
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);
    const sweep = h.intervals.find((i) => i.ms === 5000);
    ok(!!sweep, "sweep: the 5s idle-detach sweep interval is armed at load");

    h.ctxEval(`attachedTabs.set(7, { detachAt: Date.now() - 10, pointer: {x:0,y:0}, debuggee: { tabId: 7 } });`);
    h.sandbox.registerMode(7, h.ctxEval(`MODE_PAUSED`));
    h.ctxEval(`attachedTabs.get(7).detachAt = Date.now() - 10;`); // force the expired branch AFTER register
    sweep.fn();
    await tick();
    ok(h.ctxEval(`attachedTabs.has(7)`), "sweep: paused tab kept attached despite expired detachAt");
    ok(h.ctxEval(`attachedTabs.get(7).detachAt`) > Date.now() + 60_000, "sweep: paused tab re-extended to the paused keepalive window");

    h.ctxEval(`attachedTabs.set(8, { detachAt: Date.now() - 10, pointer: {x:0,y:0}, debuggee: { tabId: 8 } });`);
    sweep.fn();
    await tick();
    ok(h.ctxEval(`attachedTabs.has(8)`) === false, "sweep: idle tab with no active modes is detached");
    ok(rec.detaches.includes(8), "sweep: chrome.debugger.detach called for the idle tab");
    h.ctxEval(`attachedTabs.delete(7)`);
  }

  // =====================================================================
  // 7. onDetach centralizes cleanup: MODE_PAUSED.onDetach drains the paused tracker,
  //    membership is dropped, the attach entry is removed (M0, GREEN)
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);
    h.ctxEval(`pausedTabs.set(7, { reason: "debugCommand", callFrames: [], timestamp: Date.now() });`);
    h.sandbox.registerMode(7, h.ctxEval(`MODE_PAUSED`));
    h.ctxEval(`attachedTabs.set(7, { detachAt: Date.now() + 999999, pointer: {x:0,y:0}, debuggee: { tabId: 7 } });`);
    h.fireDetach("target_closed");
    ok(h.ctxEval(`pausedTabs.has(7)`) === false, "detach: MODE_PAUSED.onDetach cleared the paused tracker");
    ok(h.ctxEval(`modesPerTab.has(7)`) === false, "detach: per-tab keepalive membership drained");
    ok(h.ctxEval(`attachedTabs.has(7)`) === false, "detach: attach entry dropped");
  }

  // =====================================================================
  // 8. P1A debugger-family dispatch surface (TOOL_CONTRACTS §6 rows 29–36) — real handlers.
  // =====================================================================
  {
    const rec = { sessionStore: {} };
    const h = loadWorker(rec);
    const { sandbox, ctxEval } = h;

    // --- MODE_BREAKPOINTS + MODE_PAUSE_EXCEPTIONS descriptors ---
    for (const mode of ["breakpoints", "pauseExceptions"]) {
      const desc = ctxEval(`keepaliveModes[${JSON.stringify(mode)}]`);
      ok(desc !== undefined, `contract: MODE_${mode} is registered in keepaliveModes`);
      if (desc) {
        ok(desc.keepaliveMs > 0, `contract: MODE_${mode} extends the keepalive`);
        ok(desc.persist === true, `contract: MODE_${mode} persists intent (dies with the attach)`);
        ok(["snapshot", "restore", "reapply", "onDetach"].every((k) => typeof desc[k] === "function"), `contract: MODE_${mode} exposes snapshot/restore/reapply/onDetach`);
      }
    }

    // --- chrome_pause (debug.pause) → Debugger.pause + cached callFrames + MODE_PAUSED ---
    const pause = await dispatchR(sandbox, "debug.pause", { targetId: 7 });
    ok(pause.ok, `contract: debug.pause resolves (got: ${pause.ok ? "" : String(pause.error?.message || pause.error)})`);
    if (pause.ok) {
      ok(rec.cdpCalls.some((c) => c.method === "Debugger.pause"), "contract: debug.pause sends Debugger.pause");
      ok(pause.value.paused === true && Array.isArray(pause.value.callFrames), "contract: debug.pause returns the cached callFrames snapshot");
      ok(ctxEval(`modesPerTab.get(7)?.has(MODE_PAUSED)`), "contract: MODE_PAUSED registered (idle-detach exempt)");
    }

    // --- chrome_pause on an already-paused page returns the cached stack without re-pausing ---
    const before = rec.cdpCalls.filter((c) => c.method === "Debugger.pause").length;
    const pauseAgain = await dispatchR(sandbox, "debug.pause", { targetId: 7 });
    ok(pauseAgain.ok && pauseAgain.value.alreadyPaused === true, "contract: debug.pause on a paused page reports alreadyPaused");
    ok(rec.cdpCalls.filter((c) => c.method === "Debugger.pause").length === before, "contract: already-paused page is not re-paused");

    // --- chrome_resume (debug.resume) → Debugger.resume + clears MODE_PAUSED (unstick tool) ---
    const resume = await dispatchR(sandbox, "debug.resume", { targetId: 7 });
    ok(resume.ok, `contract: debug.resume resolves (got: ${resume.ok ? "" : String(resume.error?.message || resume.error)})`);
    if (resume.ok) {
      ok(resume.value.resumed === true && resume.value.paused === false, "contract: debug.resume reports resumed");
      ok(rec.cdpCalls.some((c) => c.method === "Debugger.resume"), "contract: debug.resume sends Debugger.resume");
      ok(ctxEval(`pausedTabs.has(7)`) === false, "contract: debug.resume clears the paused tracker");
      ok(ctxEval(`modesPerTab.get(7)?.has(MODE_PAUSED)`) !== true, "contract: debug.resume unregisters MODE_PAUSED");
    }
    const resumeIdle = await dispatchR(sandbox, "debug.resume", { targetId: 7 });
    ok(resumeIdle.ok && resumeIdle.value.resumed === false, "contract: debug.resume on an unpaused page is a no-op, not an error");

    // --- chrome_step (debug.step): requires paused; maps into/over/out ---
    const stepNotPaused = await dispatchR(sandbox, "debug.step", { targetId: 7, action: "into" });
    ok(!stepNotPaused.ok && /requires a paused page/.test(String(stepNotPaused.error?.message || "")), "contract: debug.step errors when the page is not paused");
    ctxEval(`pausedTabs.set(7, { reason: "debugCommand", callFrames: [], timestamp: Date.now() });`);
    const stepInto = await dispatchR(sandbox, "debug.step", { targetId: 7, action: "into" });
    ok(stepInto.ok && rec.cdpCalls.some((c) => c.method === "Debugger.stepInto"), "contract: action 'into' maps to Debugger.stepInto");
    ok(stepInto.ok && stepInto.value.stepped === true && Array.isArray(stepInto.value.callFrames), "contract: debug.step returns the refreshed paused stack");
    const stepOver = await dispatchR(sandbox, "debug.step", { targetId: 7, action: "over" });
    ok(stepOver.ok && rec.cdpCalls.some((c) => c.method === "Debugger.stepOver"), "contract: action 'over' maps to Debugger.stepOver");
    const stepOut = await dispatchR(sandbox, "debug.step", { targetId: 7, action: "out" });
    ok(stepOut.ok && rec.cdpCalls.some((c) => c.method === "Debugger.stepOut"), "contract: action 'out' maps to Debugger.stepOut");

    // --- chrome_breakpoint (debug.breakpoint): set/remove/list via setBreakpointByUrl ---
    rec.cdpResponses["Debugger.setBreakpointByUrl"] = { breakpointId: "bp-1", locations: [{ scriptId: "s1", lineNumber: 10, columnNumber: 0 }] };
    const bpSet = await dispatchR(sandbox, "debug.breakpoint", { targetId: 7, action: "set", url: "https://app.example/app.js", lineNumber: 10 });
    ok(bpSet.ok, `contract: debug.breakpoint set resolves (got: ${bpSet.ok ? "" : String(bpSet.error?.message || bpSet.error)})`);
    if (bpSet.ok) {
      const call = rec.cdpCalls.find((c) => c.method === "Debugger.setBreakpointByUrl");
      ok(!!call && call.params.url === "https://app.example/app.js" && call.params.lineNumber === 10, "contract: setBreakpointByUrl carries url + lineNumber");
      ok(bpSet.value.breakpoint && bpSet.value.breakpoint.breakpointId === "bp-1", "contract: breakpoint set returns the breakpoint record");
      ok(ctxEval(`modesPerTab.get(7)?.has(MODE_BREAKPOINTS)`), "contract: MODE_BREAKPOINTS registered on set");
      await tick();
      const stored = rec.sessionStore[ctxEval(`KEEPALIVE_MODE_STORAGE_KEY`)];
      ok(stored && stored["7"] && stored["7"].breakpoints && stored["7"].breakpoints.breakpoints[0].breakpointId === "bp-1", "contract: breakpoint intent persisted for re-apply on re-attach");
    }
    const bpList = await dispatchR(sandbox, "debug.breakpoint", { targetId: 7, action: "list" });
    ok(bpList.ok && Array.isArray(bpList.value.breakpoints) && bpList.value.count === 1, "contract: debug.breakpoint list returns the breakpoints array");
    const bpRemove = await dispatchR(sandbox, "debug.breakpoint", { targetId: 7, action: "remove", breakpointId: "bp-1" });
    ok(bpRemove.ok && rec.cdpCalls.some((c) => c.method === "Debugger.removeBreakpoint" && c.params.breakpointId === "bp-1"), "contract: debug.breakpoint remove sends Debugger.removeBreakpoint");
    ok(bpRemove.ok && bpRemove.value.removed === "bp-1" && bpRemove.value.count === 0, "contract: debug.breakpoint remove reports the removed id");
    ok(ctxEval(`modesPerTab.get(7)?.has(MODE_BREAKPOINTS)`) !== true, "contract: last breakpoint removal unregisters MODE_BREAKPOINTS");

    // --- chrome_get_call_stack (debug.callStack): frames capped at 50 ---
    ctxEval(`pausedTabs.set(7, { reason: "debugCommand", callFrames: [{ callFrameId: "cf0", functionName: "f0", url: "https://app.example/app.js", scriptId: "s1", lineNumber: 1, columnNumber: 0 }], timestamp: Date.now() });`);
    const cs = await dispatchR(sandbox, "debug.callStack", { targetId: 7 });
    ok(cs.ok, `contract: debug.callStack resolves (got: ${cs.ok ? "" : String(cs.error?.message || cs.error)})`);
    if (cs.ok) {
      ok(Array.isArray(cs.value.frames) && cs.value.frames.length === 1, "contract: debug.callStack returns the frames array");
      ok(cs.value.frames[0].callFrameId === "cf0" && cs.value.frames[0].functionName === "f0", "contract: frame identity carried");
      ok(cs.value.frames.length <= 50, "contract: debug.callStack frames capped at 50");
    }

    // --- chrome_evaluate_in_frame (debug.evalFrame): requires paused; evaluateOnCallFrame ---
    ctxEval(`pausedTabs.delete(7);`);
    const evNotPaused = await dispatchR(sandbox, "debug.evalFrame", { targetId: 7, callFrameId: "cf0", expression: "x + 1" });
    ok(!evNotPaused.ok && /requires a paused page/.test(String(evNotPaused.error?.message || "")), "contract: debug.evalFrame errors when the page is not paused");
    ctxEval(`pausedTabs.set(7, { reason: "debugCommand", callFrames: [], timestamp: Date.now() });`);
    rec.cdpResponses["Debugger.evaluateOnCallFrame"] = { result: { type: "number", value: 2 } };
    const ev = await dispatchR(sandbox, "debug.evalFrame", { targetId: 7, callFrameId: "cf0", expression: "x + 1" });
    ok(ev.ok, `contract: debug.evalFrame resolves while paused (got: ${ev.ok ? "" : String(ev.error?.message || ev.error)})`);
    if (ev.ok) {
      const call = rec.cdpCalls.find((c) => c.method === "Debugger.evaluateOnCallFrame");
      ok(!!call && call.params.callFrameId === "cf0" && call.params.expression === "x + 1", "contract: evaluateOnCallFrame carries callFrameId + expression");
      ok(ev.value.ok === true && ev.value.result.value === 2, "contract: eval result returned by value");
    }

    // --- chrome_get_script_source (debug.scriptSource): getScriptSource; >2MB → truncated ---
    rec.cdpResponses["Debugger.getScriptSource"] = { scriptSource: "function main() {}" };
    const ss = await dispatchR(sandbox, "debug.scriptSource", { targetId: 7, scriptId: "s1" });
    ok(ss.ok, `contract: debug.scriptSource resolves (got: ${ss.ok ? "" : String(ss.error?.message || ss.error)})`);
    if (ss.ok) {
      ok(rec.cdpCalls.some((c) => c.method === "Debugger.getScriptSource" && c.params.scriptId === "s1"), "contract: getScriptSource carries scriptId");
      ok(ss.value.source === "function main() {}" && ss.value.truncated === false, "contract: script source text returned untruncated");
    }
    rec.cdpResponses["Debugger.getScriptSource"] = { scriptSource: "x".repeat(2_100_000) };
    const ssBig = await dispatchR(sandbox, "debug.scriptSource", { targetId: 7, scriptId: "s2" });
    ok(ssBig.ok && ssBig.value.truncated === true, "contract: >2MB script source is flagged truncated (payload cap #4)");

    // --- chrome_set_pause_on_exceptions (debug.pauseOnExceptions): state passthrough + mode ---
    const poe = await dispatchR(sandbox, "debug.pauseOnExceptions", { targetId: 7, state: "uncaught" });
    ok(poe.ok, `contract: debug.pauseOnExceptions resolves (got: ${poe.ok ? "" : String(poe.error?.message || poe.error)})`);
    if (poe.ok) {
      const call = rec.cdpCalls.find((c) => c.method === "Debugger.setPauseOnExceptions");
      ok(!!call && call.params.state === "uncaught", "contract: setPauseOnExceptions carries the state");
      ok(poe.value.state === "uncaught", "contract: response echoes the state");
      ok(ctxEval(`modesPerTab.get(7)?.has(MODE_PAUSE_EXCEPTIONS)`), "contract: MODE_PAUSE_EXCEPTIONS registered for uncaught");
      await tick();
      const stored = rec.sessionStore[ctxEval(`KEEPALIVE_MODE_STORAGE_KEY`)];
      ok(stored && stored["7"] && stored["7"].pauseExceptions && stored["7"].pauseExceptions.state === "uncaught", "contract: pause-on-exceptions intent persisted");
    }
    const poeAll = await dispatchR(sandbox, "debug.pauseOnExceptions", { targetId: 7, state: "all" });
    ok(poeAll.ok && poeAll.value.state === "all", "contract: pauseOnExceptions 'all' accepted");
    const poeNone = await dispatchR(sandbox, "debug.pauseOnExceptions", { targetId: 7, state: "none" });
    ok(poeNone.ok && poeNone.value.state === "none", "contract: pauseOnExceptions 'none' accepted");
    ok(ctxEval(`modesPerTab.get(7)?.has(MODE_PAUSE_EXCEPTIONS)`) !== true, "contract: 'none' unregisters MODE_PAUSE_EXCEPTIONS");
  }

  console.log(`\ndebugger-family: ${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
