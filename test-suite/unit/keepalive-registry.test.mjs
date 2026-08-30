// Unit harness for the M0 keepalive mode registry in service_worker.js (TOOL_CONTRACTS.md §3.2).
//
// Long-lived modes (network capture, device/emulation overrides, blocked URLs, paused pages, and
// the P0 batch's network_throttle / emulate-media modes) must be registered in the keepalive
// registry so they (a) exempt their tab from idle-detach (CDP domain state dies with the
// attach), (b) extend the attach keepalive, (c) persist intent to chrome.storage.session when
// persist:true, and (d) are re-applied on re-attach — never silently losing state.
//
// Like sw-lifecycle.test.mjs we load the REAL service_worker.js into a vm sandbox and drive the
// real helpers: registerMode / unregisterMode / extendAttachKeepalive / cleanupModesForTab /
// restoreModesForTab / persistKeepaliveIntent / hydrateKeepaliveIntent, plus the real
// keepaliveModes descriptors and modesPerTab membership. The mode identifiers (MODE_NETWORK,
// MODE_EMULATE, MODE_BLOCKED_URLS, MODE_PAUSED) ship today; MODE_THROTTLE and MODE_MEDIA are
// contract-pinned for the P0 batch (TOOL_CONTRACTS.md §5 tools 5 + 11) — those assertions are
// expected to fail until the P0 implementation lands in this same phase.

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
  return { addListener: (cb) => { cbs.push(cb); }, removeListener: () => {}, emit: (...a) => { for (const cb of cbs) cb(...a); } };
}

// ---- Stateful chrome mock: sessionStore can be SHARED across sandbox loads so a fresh worker
// (MV3 restart) sees the persisted mode intent. ----
function makeChrome(sessionStore) {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  return {
    runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null, reload: noop, getURL: (p) => p },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener, setBadgeText: noop, setBadgeBackgroundColor: noop },
    debugger: {
      sendCommand: async (_d, _m, _p, cb) => { cb({}); },
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
    storage: {
      session: {
        get: async (k) => (k in sessionStore ? { [k]: sessionStore[k] } : {}),
        set: async (o) => { Object.assign(sessionStore, o); },
      },
    },
    sessionStore,
  };
}

function loadWorker(sessionStore) {
  const chrome = makeChrome(sessionStore || {});
  const warns = [];
  const consoleSpy = { log: () => {}, warn: (...a) => { warns.push(a.map(String).join(" ")); }, error: () => {}, info: () => {} };
  const noop = () => {};
  const sandbox = {
    console: consoleSpy, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setTimeout: () => ({}), clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    fetch: async () => { throw new Error("no fetch in keepalive harness"); },
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
  // ===== 1. Membership + keepalive extension on register; idle fallback on unregister. =====
  {
    const { sandbox, ctxEval } = loadWorker();
    ctxEval(`attachedTabs.set(7, { detachAt: Date.now() + 100, debuggee: { tabId: 7 } });`);
    const before = ctxEval(`attachedTabs.get(7).detachAt`);
    sandbox.registerMode(7, ctxEval(`MODE_NETWORK`));
    const after = ctxEval(`attachedTabs.get(7).detachAt`);
    ok(after > before + 10_000, "membership: MODE_NETWORK extends the attach keepalive far past the idle window");
    ok(ctxEval(`modesPerTab.get(7).has(MODE_NETWORK)`), "membership: mode recorded in modesPerTab");
    ok(ctxEval(`modesPerTab.get(7).size`) === 1, "membership: exactly one membership entry");

    // registerMode is idempotent — no duplicate membership.
    sandbox.registerMode(7, ctxEval(`MODE_NETWORK`));
    ok(ctxEval(`modesPerTab.get(7).size`) === 1, "membership: re-registering the same mode is idempotent");

    sandbox.unregisterMode(7, ctxEval(`MODE_NETWORK`));
    const idle = ctxEval(`attachedTabs.get(7).detachAt`);
    ok(idle <= Date.now() + 20_000 && idle < after, "membership: unregister falls back to the idle-detach window");
    ok(ctxEval(`modesPerTab.has(7)`) === false, "membership: empty mode set removes the tab from modesPerTab");
    ctxEval(`attachedTabs.delete(7)`);
  }

  // ===== 2. Longest keepalive wins across concurrent modes. =====
  {
    const { sandbox, ctxEval } = loadWorker();
    ctxEval(`attachedTabs.set(5, { detachAt: Date.now() + 100, debuggee: { tabId: 5 } });`);
    sandbox.registerMode(5, ctxEval(`MODE_EMULATE`)); // 10 min
    const emu = ctxEval(`attachedTabs.get(5).detachAt`);
    sandbox.registerMode(5, ctxEval(`MODE_PAUSED`)); // 24 h
    const paused = ctxEval(`attachedTabs.get(5).detachAt`);
    ok(paused > emu + 10_000, "keepalive: the longest active mode keepalive wins (paused > emulate)");
    sandbox.unregisterMode(5, ctxEval(`MODE_PAUSED`));
    const backToEmu = ctxEval(`attachedTabs.get(5).detachAt`);
    ok(backToEmu <= emu + 2_000 && backToEmu > Date.now() + 60_000, "keepalive: dropping the longest mode recomputes from the remaining mode");
    ctxEval(`attachedTabs.delete(5)`);
  }

  // ===== 3. cleanupModesForTab runs onDetach hooks; persisted intent survives. =====
  {
    const { sandbox, chrome, ctxEval } = loadWorker();
    ctxEval(`networkModeTabs.add(9); blockedUrlsPerTab.set(9, ["*://ads.example/*"]); emulatedTabs.set(9, { width: 320, touch: true, ua: "test-ua" });`);
    sandbox.registerMode(9, ctxEval(`MODE_NETWORK`));
    sandbox.registerMode(9, ctxEval(`MODE_EMULATE`));
    sandbox.registerMode(9, ctxEval(`MODE_BLOCKED_URLS`));
    await tick(); // let persistKeepaliveIntent flush
    const stored = chrome.sessionStore[ctxEval(`KEEPALIVE_MODE_STORAGE_KEY`)];
    ok(stored && stored["9"] && stored["9"].network && stored["9"].network.enabled === true, "persist: MODE_NETWORK persisted with intent");
    ok(stored["9"].network.blockedUrls.includes("*://ads.example/*"), "persist: blocked-URL patterns ride the network intent snapshot");
    ok(stored["9"].emulate && stored["9"].emulate.ua === "test-ua", "persist: MODE_EMULATE persisted with its override snapshot");
    ok(stored["9"].blockedUrls === undefined, "persist: persist:false modes (blockedUrls) never appear as their own intent key");
    ok(stored["9"].paused === undefined, "persist: persist:false modes (paused) never appear as their own intent key");

    sandbox.cleanupModesForTab(9);
    ok(ctxEval(`networkModeTabs.has(9)`) === false, "cleanup: network onDetach dropped the in-memory store");
    ok(ctxEval(`emulatedTabs.has(9)`) === false, "cleanup: emulate onDetach dropped the in-memory store");
    ok(ctxEval(`blockedUrlsPerTab.has(9)`) === false, "cleanup: blocked-urls onDetach dropped the in-memory store");
    ok(ctxEval(`modesPerTab.has(9)`) === false, "cleanup: per-tab mode membership drained");
    const after = chrome.sessionStore[ctxEval(`KEEPALIVE_MODE_STORAGE_KEY`)];
    ok(after["9"] && after["9"].network, "cleanup: persisted intent survives cleanup (re-apply on next attach)");
  }

  // ===== 4. Worker-restart re-apply: a FRESH worker restores persisted modes. =====
  {
    const sessionStore = {};
    const first = loadWorker(sessionStore);
    ctxEvalOf(first, `networkModeTabs.add(11); emulatedTabs.set(11, { width: 375, touch: true, ua: "restart-ua" }); blockedUrlsPerTab.set(11, ["*://tracker.example/*"]);`);
    first.sandbox.registerMode(11, ctxEvalOf(first, `MODE_NETWORK`));
    first.sandbox.registerMode(11, ctxEvalOf(first, `MODE_EMULATE`));
    first.sandbox.registerMode(11, ctxEvalOf(first, `MODE_BLOCKED_URLS`));
    await tick();

    // MV3 suspend wipes worker memory: a second sandbox shares only chrome.storage.session.
    const second = loadWorker(sessionStore);
    await second.sandbox.restoreModesForTab(11);
    ok(ctxEvalOf(second, `emulatedTabs.has(11)`), "restart: emulation override restored from persisted intent");
    ok(ctxEvalOf(second, `emulatedTabs.get(11).ua`) === "restart-ua", "restart: restored snapshot carries the exact override");
    ok(ctxEvalOf(second, `networkModeTabs.has(11)`), "restart: network mode re-added to the in-memory store");
    ok(ctxEvalOf(second, `blockedUrlsPerTab.get(11)`).includes("*://tracker.example/*"), "restart: blocked URLs re-hydrated from the network intent snapshot");
    ok(ctxEvalOf(second, `modesPerTab.get(11).has(MODE_NETWORK)`) && ctxEvalOf(second, `modesPerTab.get(11).has(MODE_EMULATE)`), "restart: restored modes are members of the keepalive registry");
    ok(ctxEvalOf(second, `modesPerTab.get(11).has(MODE_BLOCKED_URLS)`) === false, "restart: persist:false modes are NOT restored across a worker restart");
  }

  // ===== 5. P0 long-lived modes: MODE_THROTTLE (network_throttle) + MODE_MEDIA (emulate_media). =====
  {
    const { sandbox, ctxEval } = loadWorker();
    // Contract-pinned (TOOL_CONTRACTS.md §5 tools 5 + 11): both modes must exist in the registry,
    // keep the attach alive, persist intent, and provide snapshot/restore/reapply/onDetach hooks.
    const throttle = ctxEval(`keepaliveModes[MODE_THROTTLE]`);
    ok(throttle !== undefined, "p0-modes: MODE_THROTTLE is registered in keepaliveModes (network_throttle)");
    if (throttle) {
      ok(throttle.keepaliveMs > 0, "p0-modes: MODE_THROTTLE extends the keepalive");
      ok(throttle.persist === true, "p0-modes: MODE_THROTTLE persists intent (re-apply on re-attach)");
      ok(typeof throttle.snapshot === "function" && typeof throttle.restore === "function" && typeof throttle.reapply === "function" && typeof throttle.onDetach === "function", "p0-modes: MODE_THROTTLE exposes snapshot/restore/reapply/onDetach");
    }
    const media = ctxEval(`keepaliveModes[MODE_MEDIA]`);
    ok(media !== undefined, "p0-modes: MODE_MEDIA is registered in keepaliveModes (chrome_emulate_media)");
    if (media) {
      ok(media.keepaliveMs > 0, "p0-modes: MODE_MEDIA extends the keepalive");
      ok(media.persist === true, "p0-modes: MODE_MEDIA persists intent");
      ok(typeof media.snapshot === "function" && typeof media.restore === "function" && typeof media.reapply === "function" && typeof media.onDetach === "function", "p0-modes: MODE_MEDIA exposes snapshot/restore/reapply/onDetach");
    }

    // Registering the P0 modes must actually extend the attach keepalive (membership in action).
    ctxEval(`attachedTabs.set(12, { detachAt: Date.now() + 100, debuggee: { tabId: 12 } });`);
    const base = ctxEval(`attachedTabs.get(12).detachAt`);
    sandbox.registerMode(12, ctxEval(`MODE_THROTTLE`));
    const throttled = ctxEval(`attachedTabs.get(12).detachAt`);
    ok(throttled > base + 10_000, "p0-modes: registering MODE_THROTTLE keeps the tab attached past the idle window");
    sandbox.unregisterMode(12, ctxEval(`MODE_THROTTLE`));
    ctxEval(`attachedTabs.delete(12)`);
  }

  // ===== 6. Idle-detach sweep exemption (sweep consults modesPerTab). =====
  {
    // The sweep (SW:986) re-extends any tab with active modes instead of detaching. We drive the
    // same decision path: an expired detachAt + active modes -> extendAttachKeepalive keeps it.
    const { sandbox, ctxEval } = loadWorker();
    ctxEval(`attachedTabs.set(6, { detachAt: Date.now() - 10, debuggee: { tabId: 6 } });`);
    sandbox.registerMode(6, ctxEval(`MODE_EMULATE`));
    const kept = ctxEval(`attachedTabs.get(6).detachAt`);
    ok(kept > Date.now() + 60_000, "sweep: an expired attach with active modes is re-extended, not detached");
    ok(ctxEval(`attachedTabs.has(6)`), "sweep: the tab stays attached");
    sandbox.cleanupModesForTab(6);
    ctxEval(`attachedTabs.delete(6)`);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

function ctxEvalOf({ ctxEval }, code) {
  return ctxEval(code);
}

run().catch((e) => { console.error(e); process.exit(1); });
