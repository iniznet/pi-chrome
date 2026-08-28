// Unit harness for pi-chrome's dedicated automation tab/window isolation in service_worker.js.
//
// Feature under test: pi-chrome must never navigate or replace the user's active tab. Page and
// navigation actions without an explicit target are routed to a dedicated automation target that
// the *calling Pi session* created and owns. Ownership is session-scoped (one extension brokers
// every session) and mirrored to chrome.storage.session so a service-worker restart re-hydrates
// it instead of orphaning the window. Cleanup closes only the calling session's owned target.
//
// Like csp-eval.test.mjs we load the *real* worker into a vm sandbox with a stateful chrome.*
// mock, then exercise the real helpers and the real dispatch() paths. Chrome state (tabs/windows/
// storage.session) can be shared across two sandbox loads to simulate a service-worker restart.

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
async function throwsWith(fn, re, msg) {
  try { await fn(); ok(false, `${msg} (expected throw)`); }
  catch (e) { ok(re.test(String(e.message || e)), `${msg} (got: ${e.message})`); }
}
async function errorOf(fn) {
  try { await fn(); return null; }
  catch (e) { return e; }
}

// ---- stateful Chrome mock. `state` (tabs/windows/storage) can be shared to simulate a
// service-worker restart: the browser keeps its tabs/windows/session-storage, the worker memory
// is wiped (a fresh sandbox).
function makeChromeState() {
  const tabs = new Map(); // id -> { id, windowId, url, active, groupId }
  const windows = new Map(); // id -> { id }
  const groups = new Map(); // groupId -> { id, title, color, collapsed, windowId }
  const storage = {}; // chrome.storage.session backing
  let nextTabId = 1;
  let nextWindowId = 1;
  let nextGroupId = 1;
  const alloc = { tab: () => nextTabId++, window: () => nextWindowId++, group: () => nextGroupId++ };

  // Seed a user window with two real user tabs (Gmail + a research article, the active one).
  const userWindowId = alloc.window();
  windows.set(userWindowId, { id: userWindowId });
  const userGmail = { id: alloc.tab(), windowId: userWindowId, url: "https://mail.google.com/", active: false, groupId: -1 };
  const userArticle = { id: alloc.tab(), windowId: userWindowId, url: "https://example.com/research-article", active: true, groupId: -1 };
  tabs.set(userGmail.id, userGmail);
  tabs.set(userArticle.id, userArticle);

  return { tabs, windows, groups, storage, alloc, userWindowId, userGmail, userArticle };
}

function makeChrome(state, { withWindows = true, withStorage = true, withTabGroups = false } = {}) {
  const { tabs, windows, groups, storage, alloc, userWindowId } = state;
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };

  const chrome = {
    runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener },
    debugger: { sendCommand: noop, attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]), onDetach: listener },
    scripting: { executeScript: async () => [{ result: undefined }], registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
    webNavigation: { onCommitted: listener },
    tabs: {
      onUpdated: listener,
      query: async (q = {}) => {
        let list = [...tabs.values()];
        if (q.active === true) list = list.filter((t) => t.active);
        if (typeof q.windowId === "number") list = list.filter((t) => t.windowId === q.windowId);
        return list.map((t) => ({ ...t }));
      },
      get: async (id) => { const t = tabs.get(id); if (!t) throw new Error(`No tab with id ${id}`); return { ...t }; },
      create: async ({ url = "about:blank", active = false, windowId = userWindowId } = {}) => {
        const tab = { id: alloc.tab(), windowId, url, active, groupId: -1 };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      update: async (id, props = {}) => { const t = tabs.get(id); if (!t) throw new Error(`No tab with id ${id}`); Object.assign(t, props); return { ...t }; },
      remove: async (id) => { tabs.delete(id); },
      group: async ({ groupId, tabIds = [] } = {}) => {
        let gid = groupId;
        if (typeof gid !== "number") {
          gid = alloc.group();
          const firstTab = tabs.get(tabIds[0]);
          groups.set(gid, { id: gid, title: "", color: "grey", collapsed: false, windowId: firstTab ? firstTab.windowId : userWindowId });
        }
        for (const tid of tabIds) { const t = tabs.get(tid); if (t) t.groupId = gid; }
        return gid;
      },
      ungroup: async (id) => { const ids = Array.isArray(id) ? id : [id]; for (const tid of ids) { const t = tabs.get(tid); if (t) t.groupId = -1; } },
    },
    storage: withStorage ? {
      session: {
        get: async (key) => (key in storage ? { [key]: storage[key] } : {}),
        set: async (obj) => { Object.assign(storage, obj); },
      },
    } : undefined,
  };

  if (withTabGroups) {
    chrome.tabGroups = {
      query: async ({ windowId } = {}) => [...groups.values()].filter((g) => windowId === undefined || g.windowId === windowId).map((g) => ({ ...g })),
      get: async (id) => { const g = groups.get(id); if (!g) throw new Error(`No group ${id}`); return { ...g }; },
      update: async (id, props = {}) => { const g = groups.get(id); if (!g) throw new Error(`No group ${id}`); Object.assign(g, props); return { ...g }; },
    };
  }

  if (withWindows) {
    chrome.windows = {
      create: async ({ url = "about:blank", focused = false } = {}) => {
        const id = alloc.window();
        windows.set(id, { id });
        const tab = { id: alloc.tab(), windowId: id, url, active: true, groupId: -1 };
        tabs.set(tab.id, tab);
        return { id, focused, tabs: [{ ...tab }] };
      },
      get: async (id) => { const w = windows.get(id); if (!w) throw new Error(`No window with id ${id}`); return { ...w }; },
      remove: async (id) => { windows.delete(id); for (const [tid, t] of [...tabs]) if (t.windowId === id) tabs.delete(tid); },
      update: async () => {},
    };
  } else {
    chrome.windows = { update: async () => {} }; // no create/get/remove -> tab fallback path
  }

  return chrome;
}

function loadWorker(chrome) {
  const noop = () => {};
  const sandbox = {
    console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    fetch: async () => { throw new Error("no network in unit test"); },
    navigator: { userAgent: "unit-test" },
    WebSocket: function () {},
    chrome,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

const SK = "session:alpha"; // a representative sessionKey

async function run() {
  // ===== Isolation: navigation does not touch the user's active/other tabs. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const userActiveUrl = state.userArticle.url;

    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/task", waitUntilLoad: false, sessionKey: SK });
    ok(state.userArticle.url === userActiveUrl, "navigate: active user tab (research article) is not overwritten");
    ok(state.userGmail.url === "https://mail.google.com/", "navigate: other user tab (Gmail) untouched");
    ok(nav.url === "https://pi.test/task", "navigate: automation target navigated to requested URL");
    ok(nav.id !== state.userArticle.id && nav.id !== state.userGmail.id, "navigate: did not reuse any user tab");
    ok(nav.windowId !== state.userWindowId, "navigate: automation target lives in a dedicated window");

    const status = await w.dispatch("automation.status", { sessionKey: SK });
    ok(status.tabId === nav.id && status.windowId === nav.windowId, "ownership: target ids tracked for the session");
    ok(w.isPiChromeOwnedTarget(nav.id, SK) === true, "ownership: isPiChromeOwnedTarget(owned, session) === true");
    ok(w.isPiChromeOwnedTarget(state.userArticle.id) === false, "ownership: user tab is never owned (any session)");

    // Reuse: a later navigation reuses the same owned target.
    const nav2 = await w.dispatch("page.navigate", { url: "https://pi.test/step-2", waitUntilLoad: false, sessionKey: SK });
    ok(nav2.id === nav.id && nav2.windowId === nav.windowId, "reuse: second navigation reuses the same automation window/tab");
    ok(state.userArticle.url === userActiveUrl, "reuse: user tab still untouched after second navigation");

    // Cleanup closes only the owned window; user tabs/windows survive.
    const cleanup = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(cleanup.closedWindowId === nav.windowId, "cleanup: closed the owned window");
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), "cleanup: user tabs never closed");
    ok(state.windows.has(state.userWindowId), "cleanup: user window never closed");
    ok(!state.tabs.has(nav.id), "cleanup: the owned automation tab is gone");
    const status2 = await w.dispatch("automation.status", { sessionKey: SK });
    ok(status2.tabId === null && status2.windowId === null, "cleanup: ownership cleared");
  }

  // ===== Session-group integration: the dedicated-window tab joins this session's group. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    // index.ts tags page.* actions with joinSessionGroup + sessionGroupTitle; replicate that here.
    const groupTitle = "Pi Session: alpha";
    const nav = await w.dispatch("page.navigate", {
      url: "https://pi.test/grouped", waitUntilLoad: false,
      sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    const navTab = state.tabs.get(nav.id);
    ok(navTab.windowId !== state.userWindowId, "group: automation tab is in its dedicated window");
    ok(typeof navTab.groupId === "number" && navTab.groupId >= 0, "group: automation tab joined a tab group");
    const grp = state.groups.get(navTab.groupId);
    ok(grp && grp.title === groupTitle, "group: the group is titled with this session's title");
    ok(grp.windowId === navTab.windowId, "group: the session group lives inside the dedicated automation window (not the user window)");

    // A second page action reuses the same tab and does not spawn a second group.
    const groupsBefore = state.groups.size;
    await w.dispatch("page.navigate", { url: "https://pi.test/grouped-2", waitUntilLoad: false, sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: groupTitle });
    ok(state.groups.size === groupsBefore, "group: reusing the automation tab does not create a second group");
  }

  // ===== tab.new joins the existing session group instead of creating one group per window. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const groupTitle = "Pi Session: alpha";
    const nav = await w.dispatch("page.navigate", {
      url: "https://pi.test/group-owner", waitUntilLoad: false,
      sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    const navTab = state.tabs.get(nav.id);
    const groupId = navTab.groupId;
    const groupsBefore = state.groups.size;

    const opened = await w.dispatch("tab.new", { url: "https://pi.test/new-tab", groupTitle, sessionKey: SK });
    ok(state.groups.size === groupsBefore, "tab.new-group: did not create another same-session group");
    ok(opened.tab.groupId === groupId, "tab.new-group: opened tab joined the existing session group");
    ok(opened.tab.windowId === nav.windowId, "tab.new-group: opened tab was created in the existing group's window");

    const forced = await w.dispatch("tab.new", { url: "https://pi.test/no-opt-out", groupTitle, group: false, sessionKey: SK });
    ok(forced.tab.groupId === groupId, "tab.new-group: group:false is ignored; tab still joins the session group");
    ok(state.groups.size === groupsBefore, "tab.new-group: group:false does not create another group");

    const blankTitle = await w.dispatch("tab.new", { url: "https://pi.test/blank-title", groupTitle: "", group: false, sessionKey: SK });
    ok(typeof blankTitle.tab.groupId === "number" && blankTitle.tab.groupId >= 0, "tab.new-group: groupTitle:'' still creates a grouped tab");
    ok(blankTitle.group.title === "Pi", "tab.new-group: blank groupTitle falls back to a group instead of opting out");

    const nav2 = await w.dispatch("page.navigate", {
      url: "https://pi.test/new-automation-target", waitUntilLoad: false,
      sessionKey: "session:beta", joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    ok(state.groups.size === groupsBefore + 1, "automation-target-group: reused the existing session group, only blank-title Pi group was extra");
    ok(nav2.groupId === groupId, "automation-target-group: new automation target joined the existing session group");
    ok(nav2.windowId === nav.windowId, "automation-target-group: new automation target was created in the existing group's window");
  }

  // ===== tab.new never leaves an ungrouped tab behind when grouping fails. =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    const w = loadWorker(chrome);
    const tabsBefore = state.tabs.size;
    chrome.tabs.group = async () => { throw new Error("group blew up"); };

    await throwsWith(
      () => w.dispatch("tab.new", { url: "https://pi.test/group-fail", groupTitle: "Pi Session: alpha", sessionKey: SK }),
      /group blew up/,
      "tab.new-group-fail: surfaces grouping error",
    );
    ok(state.tabs.size === tabsBefore, "tab.new-group-fail: closes the created tab instead of leaving it ungrouped");
  }

  // ===== Grouping is best-effort: a tabGroups failure must not break navigation. =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    chrome.tabs.group = async () => { throw new Error("group blew up"); };
    const w = loadWorker(chrome);
    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/group-fail", waitUntilLoad: false, sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: "Pi Session: alpha" });
    ok(nav.url === "https://pi.test/group-fail", "group-fail: navigation still succeeds when grouping throws");
    ok(state.tabs.get(nav.id).windowId !== state.userWindowId, "group-fail: still used the dedicated automation window");
  }

  // ===== Concurrency: two sessions get separate windows; cleanup is per-session. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const a = await w.dispatch("page.navigate", { url: "https://pi.test/a", waitUntilLoad: false, sessionKey: "session:A" });
    const b = await w.dispatch("page.navigate", { url: "https://pi.test/b", waitUntilLoad: false, sessionKey: "session:B" });
    ok(a.id !== b.id && a.windowId !== b.windowId, "concurrency: each session gets its own dedicated window/tab");
    ok(w.isPiChromeOwnedTarget(a.id, "session:A") && !w.isPiChromeOwnedTarget(a.id, "session:B"), "concurrency: ownership is scoped to the creating session");

    // Cleaning up session A must not touch session B's target.
    await w.dispatch("automation.cleanup", { sessionKey: "session:A" });
    ok(!state.tabs.has(a.id), "concurrency: cleanup closed session A's tab");
    ok(state.tabs.has(b.id), "concurrency: cleanup left session B's tab open");
    const bStatus = await w.dispatch("automation.status", { sessionKey: "session:B" });
    ok(bStatus.tabId === b.id, "concurrency: session B still owns its target after A cleanup");
  }

  // ===== Service-worker restart / reconnect: persisted ownership re-hydrates from storage. =====
  {
    const state = makeChromeState();
    const w1 = loadWorker(makeChrome(state));
    const nav = await w1.dispatch("page.navigate", { url: "https://pi.test/persist", waitUntilLoad: false, sessionKey: SK });
    ok(typeof state.storage.piChromeAutomationTargets === "object", "restart: ownership was persisted to storage.session");

    // Simulate the MV3 service worker being suspended and restarted: fresh sandbox (memory wiped),
    // same browser tabs/windows + same session storage.
    const w2 = loadWorker(makeChrome(state));
    const statusAfterRestart = await w2.dispatch("automation.status", { sessionKey: SK });
    ok(statusAfterRestart.tabId === nav.id && statusAfterRestart.windowId === nav.windowId, "restart: re-hydrated the owned target from storage");

    // A navigation after restart must REUSE the existing window, not orphan it with a new one.
    const windowsBefore = state.windows.size;
    const nav2 = await w2.dispatch("page.navigate", { url: "https://pi.test/persist-2", waitUntilLoad: false, sessionKey: SK });
    ok(nav2.id === nav.id && nav2.windowId === nav.windowId, "restart: navigation after restart reuses the persisted window (no orphan)");
    ok(state.windows.size === windowsBefore, "restart: no new window created after restart");

    // Cleanup after restart works and clears persisted state.
    await w2.dispatch("automation.cleanup", { sessionKey: SK });
    const persisted = state.storage.piChromeAutomationTargets || {};
    ok(!(SK in persisted), "restart: cleanup removed the session from persisted storage");
  }

  // ===== Restart after the user manually closed the window: no orphan, fresh target. =====
  {
    const state = makeChromeState();
    const w1 = loadWorker(makeChrome(state));
    const nav = await w1.dispatch("page.navigate", { url: "https://pi.test/closed", waitUntilLoad: false, sessionKey: SK });
    await state.windows.delete(nav.windowId); // user closed pi-chrome's window
    for (const [tid, t] of [...state.tabs]) if (t.windowId === nav.windowId) state.tabs.delete(tid);

    const w2 = loadWorker(makeChrome(state)); // SW restart
    const nav2 = await w2.dispatch("page.navigate", { url: "https://pi.test/reopened", waitUntilLoad: false, sessionKey: SK });
    ok(nav2.id !== nav.id, "restart-after-close: a fresh automation target is created when the persisted one is gone");
    ok(state.tabs.has(nav2.id), "restart-after-close: new target exists");
  }

  // ===== tab.* management never auto-creates / never falls back to the user's active tab. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const windowsBefore = state.windows.size;
    const tabsBefore = state.tabs.size;

    await throwsWith(
      () => w.dispatch("tab.close", { sessionKey: SK }),
      /no automation tab yet|Pass targetId/,
      "tab.close: with no target and no owned target, errors instead of closing the user's active tab",
    );
    ok(state.tabs.has(state.userArticle.id), "tab.close: user's active tab was NOT closed");
    ok(state.windows.size === windowsBefore && state.tabs.size === tabsBefore, "tab.close: did not spawn a throwaway tab/window");

    await throwsWith(() => w.dispatch("tab.activate", { sessionKey: SK }), /no automation tab yet|Pass targetId/, "tab.activate: errors with no target/owned target");

    // Once an automation target exists, management actions operate on it (not on the user tab).
    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/manage", waitUntilLoad: false, sessionKey: SK });
    const closed = await w.dispatch("tab.close", { sessionKey: SK });
    ok(closed.closed === nav.id, "tab.close: with an owned target, closes that target");
    ok(state.tabs.has(state.userArticle.id), "tab.close: user tab still safe after closing the owned target");
  }

  // ===== Explicit targeting still works on any existing tab (no regression). =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/explicit", targetId: String(state.userGmail.id), waitUntilLoad: false, sessionKey: SK });
    ok(nav.id === state.userGmail.id, "explicit: targetId routes to the requested existing tab");
    ok(state.userGmail.url === "https://pi.test/explicit", "explicit: explicitly targeted tab is navigated");
    const status = await w.dispatch("automation.status", { sessionKey: SK });
    ok(status.tabId === null, "explicit: explicit targeting does not create/claim an automation target");
  }

  // ===== Window-unavailable fallback: a dedicated TAB is used, and the user's window is safe. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withWindows: false }));
    const target = await w.getOrCreateAutomationTarget(SK);
    ok(target.id !== state.userArticle.id && target.id !== state.userGmail.id, "fallback: created a dedicated tab, not a user tab");
    ok(w.isPiChromeOwnedTarget(target.id, SK) === true, "fallback: dedicated tab is owned");
    const cleanup = await w.cleanupAutomationTarget(SK);
    ok(cleanup.closedTabId === target.id && cleanup.closedWindowId === null, "fallback: cleanup closes only the owned tab (never the shared window)");
    ok(state.windows.has(state.userWindowId), "fallback: cleanup never closes the user/shared window");
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), "fallback: cleanup leaves user tabs intact");
  }

  // ===== Robust cleanup: no-op when nothing created, and when target already closed manually. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const empty = await w.cleanupAutomationTarget(SK);
    ok(empty.closedWindowId === null && empty.closedTabId === null, "cleanup: no-op when nothing was ever created");

    const t = await w.getOrCreateAutomationTarget(SK);
    // User closed pi-chrome's window manually (Chrome closes its tabs too).
    state.windows.delete(t.windowId);
    for (const [tid, tab] of [...state.tabs]) if (tab.windowId === t.windowId) state.tabs.delete(tid);
    const stale = await w.cleanupAutomationTarget(SK);
    ok(stale.closedWindowId === null && stale.closedTabId === null, "cleanup: robust when owned window was already closed");
  }

  // ===== getTabByParams resolution: urlIncludes ambiguity is an error, never a silent first match. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    // Seed two distinct tabs sharing one urlIncludes fragment.
    const tabA = { id: state.alloc.tab(), windowId: state.userWindowId, url: "https://news.example.com/breaking", active: false, groupId: -1 };
    const tabB = { id: state.alloc.tab(), windowId: state.userWindowId, url: "https://news.example.com/analysis", active: false, groupId: -1 };
    state.tabs.set(tabA.id, tabA);
    state.tabs.set(tabB.id, tabB);
    const windowsBefore = state.windows.size;

    const err = await errorOf(() => w.dispatch("page.navigate", {
      url: "https://pi.test/never", urlIncludes: "news.example.com", waitUntilLoad: false, sessionKey: SK,
    }));
    ok(/2 tabs match urlIncludes "news.example.com"/.test(err?.message || ""), "ambiguity: two urlIncludes matches raise ambiguityError");
    ok((err?.message || "").includes("pass targetId or a more specific urlIncludes"), "ambiguity: error tells the caller how to re-target");
    ok((err?.message || "").includes(String(tabA.id)) && (err?.message || "").includes(String(tabB.id)), "ambiguity: error lists both candidate tabs");
    ok(tabA.url === "https://news.example.com/breaking" && tabB.url === "https://news.example.com/analysis", "ambiguity: neither matching tab was driven");
    ok(state.windows.size === windowsBefore, "ambiguity: no automation window/tab was created for an ambiguous target");

    // Single-match urlIncludes still resolves (no over-broad regression).
    state.tabs.delete(tabB.id);
    const resolved = await w.dispatch("page.navigate", {
      url: "https://pi.test/single-match", urlIncludes: "news.example.com", waitUntilLoad: false, sessionKey: SK,
    });
    ok(resolved.id === tabA.id && tabA.url === "https://pi.test/single-match", "ambiguity: a single urlIncludes match resolves and navigates");
  }

  // ===== getTabByParams resolution: a stale targetId errors and lists the current tabs. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const windowsBefore = state.windows.size;

    const err = await errorOf(() => w.dispatch("page.navigate", {
      url: "https://pi.test/never", targetId: "999999", waitUntilLoad: false, sessionKey: SK,
    }));
    ok(/No Chrome tab with id 999999/.test(err?.message || ""), "stale-id: an unknown targetId surfaces an error naming the id");
    ok((err?.message || "").includes("Current tabs:"), "stale-id: the error enumerates the current tabs");
    ok((err?.message || "").includes(String(state.userArticle.id)), "stale-id: listing includes the active user tab");
    ok((err?.message || "").includes(String(state.userGmail.id)), "stale-id: listing includes the other user tab");
    ok(state.userArticle.url === "https://example.com/research-article" && state.userGmail.url === "https://mail.google.com/", "stale-id: no tab was navigated");
    ok(state.windows.size === windowsBefore, "stale-id: no automation window/tab was created for a stale id");
  }

  // ===== getTabByParams resolution: chrome-extension:// targets are refused as protected URLs. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const extTab = { id: state.alloc.tab(), windowId: state.userWindowId, url: "chrome-extension://abcabcabcabcabcabcabcabcabcabc/options.html", active: false, groupId: -1 };
    state.tabs.set(extTab.id, extTab);

    const err = await errorOf(() => w.dispatch("page.navigate", {
      url: "https://pi.test/never", targetId: String(extTab.id), waitUntilLoad: false, sessionKey: SK,
    }));
    ok(/Chrome blocks extension automation on protected URL/.test(err?.message || ""), "protected: a chrome-extension:// tab is refused");
    ok((err?.message || "").includes(String(extTab.id)) && (err?.message || "").includes("chrome-extension://"), "protected: the error names the offending tab and URL");
    ok(extTab.url.startsWith("chrome-extension://"), "protected: the extension tab was never navigated");
  }

  // ===== getTabByParams resolution: joinSessionGroup adopts only ungrouped tabs. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const groupTitle = "Pi Session: alpha";

    // A user-grouped tab (the user already organized it) and an ungrouped user tab.
    const userGroupId = state.alloc.group();
    state.groups.set(userGroupId, { id: userGroupId, title: "User Work", color: "blue", collapsed: false, windowId: state.userWindowId });
    const groupedTab = { id: state.alloc.tab(), windowId: state.userWindowId, url: "https://example.com/ticket-42", active: false, groupId: userGroupId };
    const ungroupedTab = { id: state.alloc.tab(), windowId: state.userWindowId, url: "https://example.com/todo", active: false, groupId: -1 };
    state.tabs.set(groupedTab.id, groupedTab);
    state.tabs.set(ungroupedTab.id, ungroupedTab);

    // page.* action on the already-grouped tab: adoption is skipped, the user's group is untouched.
    await w.dispatch("page.navigate", {
      url: "https://example.com/ticket-42-updated", targetId: String(groupedTab.id), waitUntilLoad: false,
      sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    ok(groupedTab.groupId === userGroupId, "group-adopt: an already-grouped tab stays in its user group");
    ok(state.groups.get(userGroupId).title === "User Work", "group-adopt: the user group title is never renamed");
    ok(state.groups.size === 1, "group-adopt: no extra group was created for the already-grouped tab");

    // page.* action on the ungrouped tab: it IS adopted into this session's titled group.
    await w.dispatch("page.navigate", {
      url: "https://example.com/todo-done", targetId: String(ungroupedTab.id), waitUntilLoad: false,
      sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    ok(typeof ungroupedTab.groupId === "number" && ungroupedTab.groupId >= 0, "group-adopt: an ungrouped tab is adopted into a group");
    const adoptedGroup = state.groups.get(ungroupedTab.groupId);
    ok(adoptedGroup && adoptedGroup.title === groupTitle, "group-adopt: the adopted group carries the session title");
  }

  // ===== A page.* action on a grouped tab must not rename the group (groupTab rename hazard). =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const groupTitle = "Pi Session: alpha";

    // The session creates its automation target and joins its titled group.
    const nav = await w.dispatch("page.navigate", {
      url: "https://pi.test/work", waitUntilLoad: false, sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    const piGroupId = state.tabs.get(nav.id).groupId;
    ok(state.groups.get(piGroupId).title === groupTitle, "grouped-tab: automation tab starts in the session group");

    // The user takes over: drags the automation tab into their own group.
    const userGroupId = state.alloc.group();
    state.groups.set(userGroupId, { id: userGroupId, title: "User Work", color: "red", collapsed: false, windowId: nav.windowId });
    state.tabs.get(nav.id).groupId = userGroupId;

    // The next page.* action must NOT rename the user's group back to the Pi title.
    await w.dispatch("page.navigate", {
      url: "https://pi.test/work-2", targetId: String(nav.id), waitUntilLoad: false,
      sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    ok(state.tabs.get(nav.id).groupId === userGroupId, "grouped-tab: the tab stays in the user's group after the action");
    ok(state.groups.get(userGroupId).title === "User Work", "grouped-tab: the user's group title survives the page.* action");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
