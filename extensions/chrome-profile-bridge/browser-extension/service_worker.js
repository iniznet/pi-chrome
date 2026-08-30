const BRIDGE_URL = "http://127.0.0.1:17318";
const CLIENT_NAME = `Pi Chrome Connector ${chrome.runtime.id}`;
const POLL_ERROR_BACKOFF_MS = 2000;
const DEFAULT_GROUP_COLOR = "blue";
const PI_GROUP_RE = /^Pi(\b|\s*-)/i;
const VALID_GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
const COMMAND_TIMEOUT_MS = 25_000;
// Safety ceiling for host-provided per-command timeouts (the host budget already reaches 120s
// for fullPage screenshots and 60s+ for waitFor); commands beyond this are clamped, never ignored.
const COMMAND_TIMEOUT_CEILING_MS = 300_000;
// Non-destructive timeout for Runtime.evaluate: slow page.evaluate (awaitPromise) must reject
// WITHOUT detaching the debugger, unlike input-dispatch CDP calls (see cdpRaw).
const CDP_EVALUATE_TIMEOUT_MS = 30_000;
const CDP_COMMAND_TIMEOUT_MS = 5_000;
const SCRIPTING_TIMEOUT_MS = 8_000;
const ATTACH_TIMEOUT_MS = 3_000;
const JOURNAL_STORAGE_KEY = "piChromeExecutedCommands";
const JOURNAL_MAX_ENTRIES = 200;
const JOURNAL_TTL_MS = 10 * 60 * 1000; // 10 minutes
// The journal persists only compact digests (never full results), so a total byte budget plus
// oldest-first eviction keeps it far under storage.session's quota.
const JOURNAL_MAX_BYTES = 256 * 1024; // 256KB
// Small in-memory LRU of recent full results used to replay a deduplicated id's real outcome.
const RECENT_RESULTS_MAX = 40;
const RECENT_RESULTS_MAX_BYTES = 2 * 1024 * 1024;
const RECENT_RESULT_MAX_ENTRY_BYTES = 512 * 1024;
// Sub-frame snapshot merge: bounded concurrency plus a total wall-clock budget; frames beyond
// the budget become 'skipped' placeholders instead of failing the whole snapshot command.
const SUBFRAME_SNAPSHOT_CONCURRENCY = 4;
const SUBFRAME_SNAPSHOT_BUDGET_MS = 10_000;
// Full-page screenshots default to jpeg (far smaller than PNG tiles) and cap pathological pages.
const MAX_FULLPAGE_TILES = 30;
// Bridge-down polling: exponential backoff capped at ~30s, and stop after N consecutive failures
// (re-armed by the keepalive alarm / action.onClicked).
const POLL_BACKOFF_CAP_MS = 30_000;
const POLL_MAX_CONSECUTIVE_FAILURES = 10;
// No session traffic for this long (and no owned automation targets) => the extension is idle;
// polling stops and heartbeats are skipped so the MV3 worker can suspend.
const POLL_IDLE_EXIT_MS = 5 * 60 * 1000;
const HEARTBEAT_IDLE_SKIP_MS = 2 * 60 * 1000;
// When idle, the /next probe aborts after this long so the SW does not sit in the bridge's 25s
// long-poll forever; the keepalive alarm re-arms the probe each cycle.
const POLL_IDLE_PROBE_MS = 5000;
const TAB_REGISTRY_STORAGE_KEY = "piChromeTabRegistry";
const SNAPSHOT_DOM_NODE_BUDGET = 8000;
const SNAPSHOT_DOM_TIME_BUDGET_MS = 250;
const SNAPSHOT_MAX_MERGED_ELEMENTS = 400;
let polling = false;

// =================== pi-chrome automation target ownership ===================
// pi-chrome must never hijack the user's active tab. When a page/navigation action runs without
// an explicit target (targetId/urlIncludes/titleIncludes), we route it to a dedicated automation
// target that pi-chrome created and owns. We prefer a separate Chrome window so the user's
// windows are left untouched; if the windows API is unavailable we fall back to a dedicated tab.
//
// Ownership is SESSION-SCOPED, keyed by the calling Pi session's `sessionKey` (forwarded on the
// wire). One Chrome extension / service worker brokers commands for *all* Pi sessions (see the
// client/server bridge in index.ts), so a single global target would make concurrent sessions
// fight over one window. A per-session map gives each session its own isolated window and lets
// cleanup close exactly that session's target — never another session's, never a user's.
//
// State is mirrored to chrome.storage.session so a service-worker restart (MV3 can suspend the
// worker at any time) re-hydrates ownership instead of orphaning the window it already created.
// storage.session is cleared on browser restart; any window restored by Chrome's session-restore
// is then untracked and simply left alone (we only ever close ids we still recognize as ours).
const automationTargets = new Map(); // sessionKey -> { windowId?: number, tabId: number }
const DEFAULT_SESSION_KEY = "__default__";
const AUTOMATION_STORAGE_KEY = "piChromeAutomationTargets";
let automationHydrated = false;

function sessionKeyOf(params) {
  return params && typeof params.sessionKey === "string" && params.sessionKey
    ? params.sessionKey
    : DEFAULT_SESSION_KEY;
}

// Re-hydrate the in-memory ownership map from storage.session once per worker lifetime. Best
// effort: storage may be unavailable on old Chrome, and a failure just means we may create a
// fresh window (a harmless orphan) rather than reusing one.
async function hydrateAutomationTargets() {
  if (automationHydrated) return;
  automationHydrated = true;
  try {
    const stored = await chrome.storage?.session?.get?.(AUTOMATION_STORAGE_KEY);
    const saved = stored && stored[AUTOMATION_STORAGE_KEY];
    if (saved && typeof saved === "object") {
      for (const [key, value] of Object.entries(saved)) {
        if (value && typeof value.tabId === "number") {
          automationTargets.set(key, {
            windowId: typeof value.windowId === "number" ? value.windowId : undefined,
            tabId: value.tabId,
          });
        }
      }
    }
  } catch {
    // Ignore: treat as "no persisted state".
  }
}

async function persistAutomationTargets() {
  try {
    const obj = {};
    for (const [key, value] of automationTargets) {
      obj[key] = { windowId: typeof value.windowId === "number" ? value.windowId : null, tabId: value.tabId };
    }
    await chrome.storage?.session?.set?.({ [AUTOMATION_STORAGE_KEY]: obj });
  } catch {
    // Ignore: persistence is an optimization, not a correctness requirement.
  }
}

// =================== named tab registry (tab.save / tab.list) ===================
// Subagents and workflows can bind names to tabs ("handles") so a label->tabId binding survives
// worker restarts and each Pi session can enumerate/clean up exactly its own handles. Ownership
// is session-scoped like automation targets: a name may only be re-bound by the session that
// created it, and automation.cleanup drops that session's handles too. Mirrored to
// chrome.storage.session so MV3 worker suspension does not lose the registry.
const tabRegistry = new Map(); // name -> RegistryEntry {name, tabId, windowId?, url?, title?, ownerSessionKey, savedAt}
let registryHydrated = false;

async function hydrateTabRegistry() {
  if (registryHydrated) return;
  registryHydrated = true;
  try {
    const stored = await chrome.storage?.session?.get?.(TAB_REGISTRY_STORAGE_KEY);
    const saved = stored && stored[TAB_REGISTRY_STORAGE_KEY];
    if (saved && typeof saved === "object") {
      for (const [name, entry] of Object.entries(saved)) {
        if (entry && typeof entry.tabId === "number") tabRegistry.set(name, { ...entry, name });
      }
    }
  } catch {
    // Ignore: treat as "no persisted state".
  }
}

async function persistTabRegistry() {
  try {
    const obj = {};
    for (const [name, entry] of tabRegistry) obj[name] = { ...entry };
    await chrome.storage?.session?.set?.({ [TAB_REGISTRY_STORAGE_KEY]: obj });
  } catch {
    // Ignore: persistence is an optimization, not a correctness requirement.
  }
}

// True if `tabId` is a pi-chrome-owned automation tab. Pass `sessionKey` to check a specific
// session; omit it to check ownership across *any* session (used as a safety predicate so we
// never operate on a user-created tab). Never infers ownership from "active".
function isPiChromeOwnedTarget(tabId, sessionKey) {
  if (typeof tabId !== "number") return false;
  if (sessionKey !== undefined) {
    const t = automationTargets.get(sessionKey);
    return !!t && t.tabId === tabId;
  }
  for (const t of automationTargets.values()) if (t.tabId === tabId) return true;
  return false;
}

// QoL blank-automation-tab flag: true when the resolved target is this session's OWNED
// automation tab (came via the implicit automation-target path, never an explicit targetId) and
// its page is blank (about:blank / '' / chrome://newtab). The host appends a hint telling the
// agent to run chrome_tab list instead of being stuck on pi-chrome's empty dedicated tab.
function isBlankAutomationTarget(tab, params, resolution) {
  if (!tab || typeof tab.id !== "number") return false;
  if (!resolution || !resolution.viaAutomationTarget) return false;
  if (!isPiChromeOwnedTarget(tab.id, sessionKeyOf(params))) return false;
  const url = String(tab.url || "");
  return url === "" || url === "about:blank" || url === "chrome://newtab";
}

// Create a fresh automation target for `sessionKey`. If this session already has a tab group,
// create the tab inside that group's window so one Pi session keeps one Chrome tab group (Chrome
// groups cannot span windows). If no group exists yet, prefer an isolated window; fall back to a
// tab. When the tab is created in a pre-existing group window, leave windowId unset so cleanup only
// closes our tab, never that whole window.
async function createAutomationTarget(sessionKey, groupTitle) {
  const existingGroup = groupTitle ? await findGroupRecordByTitle(groupTitle) : null;
  if (existingGroup && typeof existingGroup.windowId === "number") {
    const tab = await chrome.tabs.create({ url: "about:blank", active: false, windowId: existingGroup.windowId });
    automationTargets.set(sessionKey, { windowId: undefined, tabId: typeof tab.id === "number" ? tab.id : undefined });
    await persistAutomationTargets();
    return tab;
  }
  if (chrome.windows && typeof chrome.windows.create === "function") {
    try {
      const win = await chrome.windows.create({ url: "about:blank", focused: false });
      const created = win && Array.isArray(win.tabs) ? win.tabs[0] : undefined;
      if (created && typeof created.id === "number") {
        automationTargets.set(sessionKey, { windowId: typeof win.id === "number" ? win.id : undefined, tabId: created.id });
        await persistAutomationTargets();
        return created;
      }
    } catch {
      // Window creation can fail (policy, headless, etc.); fall back to a dedicated tab below.
    }
  }
  // Tab fallback: the tab lives in a pre-existing (user/shared) window we did NOT create, so we
  // must leave windowId unset — cleanup then closes only our tab, never the user's window.
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  automationTargets.set(sessionKey, { windowId: undefined, tabId: typeof tab.id === "number" ? tab.id : undefined });
  await persistAutomationTargets();
  return tab;
}

// Return the session's owned automation target if it still exists, else null. Robust to the user
// (or Chrome) having closed it: a stale entry is forgotten so callers can recreate cleanly.
async function resolveOwnedAutomationTarget(sessionKey) {
  await hydrateAutomationTargets();
  const t = automationTargets.get(sessionKey);
  if (!t || typeof t.tabId !== "number") return null;
  const existing = await chrome.tabs.get(t.tabId).catch(() => null);
  if (existing && typeof existing.id === "number") return existing;
  automationTargets.delete(sessionKey);
  await persistAutomationTargets();
  return null;
}

// Return the session's dedicated automation target, creating it on first use (or after the user
// closed it). Used by page/navigation actions that need a live surface to drive.
async function getOrCreateAutomationTarget(sessionKey, groupTitle) {
  return (await resolveOwnedAutomationTarget(sessionKey)) || createAutomationTarget(sessionKey, groupTitle);
}

// Close only the session's pi-chrome-owned window/tab, and only if it still exists. Never touches
// user tabs/windows or other sessions' targets. Safe to call repeatedly and when nothing exists.
async function cleanupAutomationTarget(sessionKey) {
  await hydrateAutomationTargets();
  const t = automationTargets.get(sessionKey);
  automationTargets.delete(sessionKey);
  await persistAutomationTargets();
  if (!t) return { closedWindowId: null, closedTabId: null };
  const { windowId, tabId } = t;
  // The session's target tab is going away; drop its network-capture state and captured entries.
  if (typeof tabId === "number") {
    networkModeTabs.delete(tabId);
    blockedUrlsPerTab.delete(tabId);
    cdpNetworkEntries.delete(tabId);
  }
  if (typeof windowId === "number" && chrome.windows && typeof chrome.windows.remove === "function") {
    const win = await chrome.windows.get(windowId, { populate: true }).catch(() => null);
    if (win) {
      // Only remove the whole window when it still contains exactly the owned tab. A user may
      // have dragged other tabs into the Pi window since we created it — removing the window
      // then would silently close the user's tabs. Fall back to closing just our tab.
      let tabs = Array.isArray(win.tabs) ? win.tabs : null;
      if (!tabs) tabs = await chrome.tabs.query({ windowId }).catch(() => []);
      const onlyOwnedTab = tabs.length === 1 && tabs[0] && tabs[0].id === tabId;
      if (onlyOwnedTab) {
        await chrome.windows.remove(windowId).catch(() => {});
        return { closedWindowId: windowId, closedTabId: typeof tabId === "number" ? tabId : null };
      }
      if (typeof tabId === "number") {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab) {
          await chrome.tabs.remove(tabId).catch(() => {});
          return { closedWindowId: null, closedTabId: tabId };
        }
      }
      return { closedWindowId: null, closedTabId: null };
    }
  }
  if (typeof tabId === "number") {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) {
      await chrome.tabs.remove(tabId).catch(() => {});
      return { closedWindowId: null, closedTabId: tabId };
    }
  }
  return { closedWindowId: null, closedTabId: null };
}

function withTimeout(promise, ms, label, onTimeout) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(async () => {
        try { await onTimeout?.(); } catch {}
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    }),
  ]);
}

// =================== Chrome input (CDP) layer ===================
// Tracks which tabs we have attached chrome.debugger to.
const attachedTabs = new Map(); // tabId -> { detachAt: number, pointer: {x,y} }
const INPUT_IDLE_DETACH_MS = 15_000;
const CDP_VERSION = "1.3";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rng(min, max) { return min + Math.random() * (max - min); }

// =================== JS dialogs (alert/confirm/prompt/beforeunload) ===================
// Pending CDP-reported dialogs per tab (one modal dialog at a time per tab) plus the set of
// tabs with an active chrome_dialog waiter. The onEvent listener records dialogs here and
// auto-dismisses alert() (no accept/dismiss semantics) so a stray alert never wedges the
// action chain; confirm/prompt/beforeunload stay pending for chrome_dialog to decide.
const pendingDialogs = new Map(); // tabId -> { tabId, dialogType, message, url, defaultPrompt, hasBrowserHandler, openedAt }
const dialogWaiters = new Set(); // tabId with an in-flight chrome_dialog wait

// =================== device/UA/touch emulation ===================
// Emulation overrides live on the CDP target and die with the debugger attach, so after
// page.emulate set we extend the attach keepalive (and remember what we set) until cleared.
const emulatedTabs = new Map(); // tabId -> { width, height, deviceScaleFactor, mobile, touch, ua, platform, acceptLanguage }
const EMULATE_ATTACH_KEEPALIVE_MS = 10 * 60 * 1000;

// =================== downloads ===================
const DOWNLOAD_WAIT_DEFAULT_MS = 60_000;
const DOWNLOAD_WAIT_MAX_MS = 180_000;

// =================== CDP Network-domain observability (feat-cdp-network / feat-har) ===================
// The in-page fetch/XHR instrumentation cannot see browser-initiated document/static requests.
// When the agent opts into network capture mode (chrome_network_capture), we keep the debugger
// attach alive (skipping the idle-detach), enable the CDP Network domain, and record
// requestWillBeSent / responseReceived / loadingFinished / loadingFailed / dataReceived events
// into cdpNetworkEntries. Capture is per-tab; the session automation tab makes that effectively
// per-session. Entries survive a detach so HAR export keeps working after the mode is turned off.
const CDP_NETWORK_MAX_ENTRIES_PER_TAB = 2000;
const CDP_NETWORK_MAX_BODY_CHARS = 200_000;
const NETWORK_MODE_KEEPALIVE_MS = 30 * 60 * 1000;
const NETWORK_LIST_MAX_RETURNED = 200;
const NETWORK_HAR_MAX_ENTRIES = 500;
// Stop fetching response bodies past this total so a busy tab cannot push the /result payload
// past the bridge's 8MB result cap (endpoint-limits).
const NETWORK_HAR_BODY_BUDGET_CHARS = 4_000_000;
const NETWORK_TEXT_MIME_RE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql))/;
const networkModeTabs = new Set(); // tabId with opt-in persistent CDP Network capture
const blockedUrlsPerTab = new Map(); // tabId -> string[] patterns last applied via Network.setBlockedURLs
const cdpNetworkEntries = new Map(); // tabId -> Map<requestId, entry>
const cacheDisabledPerTab = new Map(); // tabId -> boolean (Network.setCacheDisabled; re-applied on re-attach)
const throttlePerTab = new Map(); // tabId -> { offline, latencyMs, downloadThroughput, uploadThroughput }
const THROTTLE_MODE_KEEPALIVE_MS = 10 * 60 * 1000;

// =================== M0 shared plumbing: keepalive mode registry ===================
// Long-lived modes (network capture, emulation, blocked URLs — later throttle/headers/media/
// pseudo/console-capture/input-lock/breakpoints/interception/tracing/heap/recording) each:
//   1. register here so the idle-detach sweep keeps the debugger attach alive while active,
//   2. tear down centrally in onDetach (never leave stale per-tab state behind),
//   3. declare a re-apply hook so a fresh attach (cdp() auto-recover or a later command) can
//      restore the CDP overrides that die with the session — the ensureNetworkCapture pattern.
// Mode intent is persisted to chrome.storage.session so a Chrome-initiated detach (DevTools
// opens, user cancels the attach) or an MV3 worker suspend does not silently drop an active
// mode; the next command on that tab restores + re-applies it (risk #1 / #2).
const INITIATOR_STACK_MAX_FRAMES = 20;
const INITIATOR_PARENT_DEPTH = 3;
const INITIATOR_CHAIN_MAX_DEPTH = 16;
const INITIATOR_CHAIN_MAX_DEPENDENTS = 50;
const NODE_RESOLVE_OBJECT_GROUP = "pi-chrome-node-resolve";
const KEEPALIVE_MODE_STORAGE_KEY = "piChromeKeepaliveModes";
const PAUSED_KEEPALIVE_MS = 24 * 60 * 60 * 1000; // paused pages are re-extended each sweep tick
const MODE_NETWORK = "network";
const MODE_EMULATE = "emulate";
const MODE_BLOCKED_URLS = "blockedUrls";
const MODE_THROTTLE = "throttle";
const MODE_HEADERS = "headers";
const MODE_MEDIA = "media";
const MODE_PSEUDO = "pseudo";
const MODE_CONSOLE_CAPTURE = "consoleCapture";
const MODE_INPUT_LOCK = "inputLock";
const MODE_PAUSED = "paused";
const MODE_TRACING = "tracing";
const MODE_HEAP_RECORDING = "heapRecording";
const MODE_BREAKPOINTS = "breakpoints";
const MODE_INTERCEPT = "intercept";
const MODE_RECORD_SESSION = "sessionRecord";

// Per-tab paused-page state (Debugger.paused / Debugger.resumed). While paused the main thread
// is frozen: evaluate/snapshot/input would hang forever, so ensurePageUsable auto-resumes first
// and the idle-detach sweep exempts paused tabs (a detach force-resumes and silently loses the
// pause). See TOOL_CONTRACTS.md §3.5.
const pausedTabs = new Map(); // tabId -> { reason, callFrames, timestamp }
const pauseResumeEvents = []; // bounded diagnostics ring, like attachDebugLog
function recordPauseResumeEvent(entry) {
  pauseResumeEvents.push({ ...entry, t: Date.now() });
  if (pauseResumeEvents.length > 20) pauseResumeEvents.shift();
}

const keepaliveModes = {
  [MODE_NETWORK]: {
    keepaliveMs: NETWORK_MODE_KEEPALIVE_MS,
    persist: true,
    snapshot: (tabId) => {
      if (!networkModeTabs.has(tabId)) return null;
      const snap = { enabled: true, blockedUrls: blockedUrlsPerTab.get(tabId) || [] };
      // Network.setCacheDisabled dies with the attach — carry the value so re-attach restores it.
      if (cacheDisabledPerTab.has(tabId)) snap.cacheDisabled = cacheDisabledPerTab.get(tabId);
      return snap;
    },
    restore: (tabId, snap) => {
      if (snap && snap.enabled) {
        networkModeTabs.add(tabId);
        if (Array.isArray(snap.blockedUrls)) blockedUrlsPerTab.set(tabId, snap.blockedUrls);
        if (typeof snap.cacheDisabled === "boolean") cacheDisabledPerTab.set(tabId, snap.cacheDisabled);
      }
    },
    reapply: async (tabId, snap) => {
      if (snap && snap.enabled) await ensureNetworkCapture(tabId);
    },
    onDetach: (tabId) => {
      networkModeTabs.delete(tabId);
      blockedUrlsPerTab.delete(tabId);
      cacheDisabledPerTab.delete(tabId);
    },
  },
  [MODE_EMULATE]: {
    keepaliveMs: EMULATE_ATTACH_KEEPALIVE_MS,
    persist: true,
    // The single per-tab emulation record carries device metrics/UA/touch PLUS the media-feature
    // block (chrome_emulate_media) and env overrides (locale/timezone/geolocation/idle), so a
    // fresh attach re-applies the whole emulation surface with one snapshot (TOOL_CONTRACTS §5.5/§5.6).
    snapshot: (tabId) => (emulatedTabs.has(tabId) ? { ...emulatedTabs.get(tabId) } : null),
    restore: (tabId, snap) => { if (snap) emulatedTabs.set(tabId, snap); },
    reapply: async (tabId, snap) => { if (snap) await applyEmulationOverrides(tabId, snap); },
    onDetach: (tabId) => emulatedTabs.delete(tabId),
  },
  [MODE_MEDIA]: {
    keepaliveMs: EMULATE_ATTACH_KEEPALIVE_MS,
    persist: true,
    // Media features live inside the shared emulatedTabs record (media + cpuThrottleRate keys) so
    // clear/reset never leaves a half-applied emulation surface. Snapshot/restore mirror that slice.
    snapshot: (tabId) => {
      const record = emulatedTabs.get(tabId);
      if (!record || (!record.media && record.cpuThrottleRate === undefined)) return null;
      return { media: record.media ? { ...record.media } : undefined, cpuThrottleRate: record.cpuThrottleRate };
    },
    restore: (tabId, snap) => {
      if (!snap) return;
      const record = emulatedTabs.get(tabId) || {};
      if (snap.media && typeof snap.media === "object") record.media = snap.media;
      if (snap.cpuThrottleRate !== undefined) record.cpuThrottleRate = snap.cpuThrottleRate;
      emulatedTabs.set(tabId, record);
    },
    reapply: async (tabId, snap) => {
      if (snap) await applyMediaOverrides(tabId, snap.media || {}, snap.cpuThrottleRate).catch(() => undefined);
    },
    onDetach: (tabId) => {
      // The shared record is dropped by MODE_EMULATE.onDetach; here only clear the media slice so
      // cleanupModesForTab runs both hooks without ordering surprises.
      const record = emulatedTabs.get(tabId);
      if (record) {
        delete record.media;
        delete record.cpuThrottleRate;
      }
    },
  },
  [MODE_THROTTLE]: {
    keepaliveMs: THROTTLE_MODE_KEEPALIVE_MS,
    persist: true,
    snapshot: (tabId) => (throttlePerTab.has(tabId) ? { ...throttlePerTab.get(tabId) } : null),
    restore: (tabId, snap) => { if (snap) throttlePerTab.set(tabId, snap); },
    reapply: async (tabId, snap) => {
      // Network.emulateNetworkConditions dies with the attach; restore the throttling profile and
      // (best-effort) re-enable the Network domain first — it may not be on if capture is off.
      if (!snap) return;
      try { await enableNetworkDomain(tabId); } catch {}
      await cdp(tabId, "Network.emulateNetworkConditions", networkConditionsFor(snap)).catch(() => undefined);
    },
    onDetach: (tabId) => throttlePerTab.delete(tabId),
  },
  [MODE_BLOCKED_URLS]: {
    keepaliveMs: NETWORK_MODE_KEEPALIVE_MS,
    persist: false,
    snapshot: (tabId) => (blockedUrlsPerTab.has(tabId) ? { urls: blockedUrlsPerTab.get(tabId) || [] } : null),
    restore: (tabId, snap) => { if (snap && Array.isArray(snap.urls)) blockedUrlsPerTab.set(tabId, snap.urls); },
    reapply: async (tabId, snap) => {
      if (snap && Array.isArray(snap.urls) && snap.urls.length) {
        await cdp(tabId, "Network.setBlockedURLs", { urls: snap.urls }).catch(() => undefined);
      }
    },
    onDetach: (tabId) => blockedUrlsPerTab.delete(tabId),
  },
  [MODE_PAUSED]: {
    // A paused page must never idle-detach (detaching force-resumes it, losing the pause).
    keepaliveMs: PAUSED_KEEPALIVE_MS,
    persist: false,
    snapshot: () => null,
    restore: () => {},
    reapply: null,
    onDetach: (tabId) => { pausedTabs.delete(tabId); },
  },
};

// Per-tab active mode membership. The idle-detach sweep consults this; onDetach drains it.
const modesPerTab = new Map(); // tabId -> Set<modeId>
let keepaliveIntentHydrated = false;

function modesForTab(tabId) {
  let set = modesPerTab.get(tabId);
  if (!set) { set = new Set(); modesPerTab.set(tabId, set); }
  return set;
}

function registerMode(tabId, modeId) {
  const desc = keepaliveModes[modeId];
  if (!desc) return;
  modesForTab(tabId).add(modeId);
  const entry = attachedTabs.get(tabId);
  if (entry) extendAttachKeepalive(tabId, entry);
  void persistKeepaliveIntent();
}

function unregisterMode(tabId, modeId) {
  const set = modesPerTab.get(tabId);
  if (set) {
    set.delete(modeId);
    if (set.size === 0) modesPerTab.delete(tabId);
  }
  const entry = attachedTabs.get(tabId);
  if (entry) extendAttachKeepalive(tabId, entry);
  void persistKeepaliveIntent();
}

// Recompute the attach's detachAt from the longest keepalive among active modes (default idle
// window when none). Paused tabs use PAUSED_KEEPALIVE_MS and are re-extended by the sweep.
function extendAttachKeepalive(tabId, entry) {
  let keepalive = 0;
  const set = modesPerTab.get(tabId);
  if (set) {
    for (const modeId of set) {
      const desc = keepaliveModes[modeId];
      if (desc && desc.keepaliveMs > keepalive) keepalive = desc.keepaliveMs;
    }
  }
  entry.detachAt = Date.now() + (keepalive > 0 ? keepalive : INPUT_IDLE_DETACH_MS);
}

// Centralized per-tab teardown for onDetach / detachDebugger: run each active mode's onDetach
// hook (frees CDP-dependent state), drop the per-tab membership. Persisted intent is retained
// so the next command on this tab restores + re-applies the modes.
function cleanupModesForTab(tabId) {
  const set = modesPerTab.get(tabId);
  if (set) {
    for (const modeId of set) {
      const desc = keepaliveModes[modeId];
      if (desc && typeof desc.onDetach === "function") desc.onDetach(tabId);
    }
    modesPerTab.delete(tabId);
  }
}

// Re-apply active modes after a FRESH attach (CDP domain state died with the old session).
async function reapplyModesForTab(tabId) {
  const set = modesPerTab.get(tabId);
  if (!set) return;
  for (const modeId of set) {
    const desc = keepaliveModes[modeId];
    if (!desc || typeof desc.reapply !== "function") continue;
    try {
      await desc.reapply(tabId, desc.snapshot ? desc.snapshot(tabId) : null);
    } catch (error) {
      console.warn(`[pi-chrome] re-apply of mode ${modeId} on tab ${tabId} failed: ${String(error?.message || error)}`);
    }
  }
}

// Restore persisted mode intent after a fresh attach (survived Chrome-initiated detach / worker
// suspend), then re-apply the CDP overrides. Idempotent within a worker lifetime.
async function restoreModesForTab(tabId) {
  await hydrateKeepaliveIntent();
  if (!modesPerTab.has(tabId)) {
    try {
      const stored = await chrome.storage?.session?.get?.(KEEPALIVE_MODE_STORAGE_KEY);
      const saved = stored && stored[KEEPALIVE_MODE_STORAGE_KEY];
      const modeSnaps = saved && saved[String(tabId)];
      if (modeSnaps && typeof modeSnaps === "object") {
        for (const [modeId, snap] of Object.entries(modeSnaps)) {
          const desc = keepaliveModes[modeId];
          if (!desc || typeof desc.restore !== "function") continue;
          try { desc.restore(tabId, snap); } catch {}
          modesForTab(tabId).add(modeId);
        }
      }
    } catch {}
  }
  await reapplyModesForTab(tabId);
}

async function persistKeepaliveIntent() {
  try {
    const obj = {};
    for (const [tabId, set] of modesPerTab) {
      const modeSnaps = {};
      for (const modeId of set) {
        const desc = keepaliveModes[modeId];
        if (!desc || !desc.persist || typeof desc.snapshot !== "function") continue;
        const snap = desc.snapshot(tabId);
        if (snap !== null && snap !== undefined) modeSnaps[modeId] = snap;
      }
      if (Object.keys(modeSnaps).length) obj[String(tabId)] = modeSnaps;
    }
    await chrome.storage?.session?.set?.({ [KEEPALIVE_MODE_STORAGE_KEY]: obj });
  } catch {
    // Persistence is best-effort: mode intent loss only degrades re-apply, never correctness.
  }
}

// One-time per-worker hydrate: restore persisted mode intent into the in-memory stores so a
// restarted SW keeps its long-lived modes (MV3 suspend risk #1).
async function hydrateKeepaliveIntent() {
  if (keepaliveIntentHydrated) return;
  keepaliveIntentHydrated = true;
  try {
    const stored = await chrome.storage?.session?.get?.(KEEPALIVE_MODE_STORAGE_KEY);
    const saved = stored && stored[KEEPALIVE_MODE_STORAGE_KEY];
    if (saved && typeof saved === "object") {
      for (const [tabIdStr, modeSnaps] of Object.entries(saved)) {
        const tabId = Number(tabIdStr);
        if (!Number.isInteger(tabId) || !modeSnaps || typeof modeSnaps !== "object") continue;
        for (const [modeId, snap] of Object.entries(modeSnaps)) {
          const desc = keepaliveModes[modeId];
          if (!desc || typeof desc.restore !== "function") continue;
          try { desc.restore(tabId, snap); } catch {}
          modesForTab(tabId).add(modeId);
        }
      }
    }
  } catch {
    // Ignore: treat as "no persisted mode intent".
  }
}

// Resume a paused page before a command that would deadlock on the frozen main thread
// (evaluate / snapshot / input / screenshot). Returns a note { wasPaused, reason, ... } or null
// so callers can surface "page is paused" prominently. Never throws: a failed resume falls
// through to the CDP command's own timeout instead of silently hanging (constraint #3).
async function ensurePageUsable(tabId, label) {
  const paused = pausedTabs.get(tabId);
  if (!paused) return null;
  try {
    await cdpRaw(tabId, "Debugger.resume", {});
  } catch (error) {
    console.warn(`[pi-chrome] auto-resume before ${label} failed on tab ${tabId}: ${String(error?.message || error)}`);
  }
  pausedTabs.delete(tabId);
  unregisterMode(tabId, MODE_PAUSED);
  const note = { wasPaused: true, reason: paused.reason, resumedBefore: label, at: Date.now() };
  recordPauseResumeEvent({ tabId, ...note });
  return note;
}

// Run `fn` under the paused-page rail and merge any resume note into an object result.
async function withPauseRail(tabId, label, fn) {
  const note = await ensurePageUsable(tabId, label);
  const result = await fn();
  if (note && result && typeof result === "object" && !Array.isArray(result)) {
    result.pausedAutoResumed = note;
  }
  return result;
}

function inputStatus() {
  return {
    attachedTabs: Array.from(attachedTabs.keys()),
    permissionGranted: typeof chrome !== "undefined" && !!chrome.debugger,
    networkCaptureTabs: Array.from(networkModeTabs.keys()),
    activeModes: Array.from(modesPerTab.entries()).map(([tabId, set]) => ({ tabId, modes: Array.from(set) })),
    pausedTabs: Array.from(pausedTabs.keys()),
    recentPauseResumes: pauseResumeEvents.slice(),
  };
}

// Last few attach failures, kept for diagnostics.
const attachDebugLog = [];
function recordAttachEvent(entry) {
  attachDebugLog.push({ ...entry, t: Date.now() });
  if (attachDebugLog.length > 20) attachDebugLog.shift();
}

function normalPageTarget(target, tabId) {
  const url = String(target?.url || "");
  return target?.tabId === tabId && target?.type === "page" && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://") && !url.startsWith("devtools://");
}

async function pageDebuggeeForTab(tabId) {
  const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))).catch(() => []);
  const target = targets.find((t) => normalPageTarget(t, tabId));
  return target?.id ? { targetId: target.id } : { tabId };
}

async function debuggerAttachRaw(tabId, preferredDebuggee) {
  const debuggee = preferredDebuggee || { tabId };
  await withTimeout(
    chrome.debugger.attach(debuggee, CDP_VERSION),
    ATTACH_TIMEOUT_MS,
    `Chrome debugger attach to tab ${tabId}`,
    async () => {
      attachedTabs.delete(tabId);
      try { await chrome.debugger.detach(debuggee); } catch {}
    },
  );
  return debuggee;
}

async function attachDebugger(tabId) {
  if (!chrome.debugger) throw new Error("chrome.debugger API unavailable; reload the extension to grant the new permission");
  if (attachedTabs.has(tabId)) {
    const entry = attachedTabs.get(tabId);
    // Active keepalive modes (network capture, emulation, paused page, ...) extend the attach
    // lifetime instead of the default idle-detach window.
    extendAttachKeepalive(tabId, entry);
    return entry;
  }
  // Before each attach, force-detach any stale CDP target this extension owns on the tab.
  // Chrome sometimes keeps a half-dead session around (extension reload mid-attach, etc.) and
  // surfaces it as "Cannot access a chrome-extension://" on the next attach attempt.
  try {
    const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
    for (const tgt of targets) {
      if (tgt.tabId === tabId && tgt.attached) {
        recordAttachEvent({ kind: "stale-target-found", tabId, target: { id: tgt.id, type: tgt.type, url: tgt.url, extensionId: tgt.extensionId } });
        try { await chrome.debugger.detach({ tabId }); } catch {}
        await sleep(80);
        break;
      }
    }
  } catch {}
  let attachedDebuggee = null;
  const attemptAttach = async (debuggee) => {
    try {
      attachedDebuggee = await debuggerAttachRaw(tabId, debuggee);
      return null;
    } catch (error) {
      return error;
    }
  };
  const retryPageTargetIfExtensionBlocked = async (err, kind) => {
    if (!/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(String(err?.message || err))) return err;
    const pageDebuggee = await pageDebuggeeForTab(tabId);
    recordAttachEvent({ kind, tabId, debuggee: pageDebuggee });
    return attemptAttach(pageDebuggee);
  };
  let err = await attemptAttach();
  if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry");
  if (err) {
    const msg = String(err?.message || err);
    const transient = /Cannot access a chrome-extension|Cannot access contents of|No tab with id|Debugger is not attached|Another debugger|Target closed/i.test(msg);
    const tabSnapshot = await chrome.tabs.get(tabId).catch(() => null);
    recordAttachEvent({ kind: "attach-failed", tabId, message: msg, tabUrl: tabSnapshot?.url, transient });
    if (!transient) throw err;
    if (!tabSnapshot || (tabSnapshot.url || "").startsWith("chrome://") || (tabSnapshot.url || "").startsWith("chrome-extension://")) {
      throw new Error(`Chrome can't attach the debugger to this tab (${tabSnapshot?.url ?? "unknown"}). Open a normal http(s) tab and try again.`);
    }
    await sleep(180);
    err = await attemptAttach();
    if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry2");
    if (err) {
      recordAttachEvent({ kind: "attach-retry-failed", tabId, message: String(err.message || err), tabUrl: tabSnapshot?.url });
      // One more try after a longer settle. Some Chrome builds need ~500ms after a navigation
      // for content-script registration on the tab to drain before chrome.debugger.attach
      // will accept the target.
      await sleep(500);
      err = await attemptAttach();
      if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry3");
      if (err) {
        recordAttachEvent({ kind: "attach-retry2-failed", tabId, message: String(err.message || err), tabUrl: tabSnapshot?.url });
        const meta = await describeInputTarget(tabId);
        throw new Error(`Chrome debugger attach failed for tab ${tabId}: ${String(err.message || err)}${targetMetaSuffix(meta)}`);
      }
    }
  }
  recordAttachEvent({ kind: "attached", tabId, debuggee: attachedDebuggee });
  // Seed pointer in a plausible "just left the address bar" location.
  const entry = { detachAt: Date.now() + INPUT_IDLE_DETACH_MS, pointer: { x: 120 + Math.random() * 200, y: 80 + Math.random() * 120 }, debuggee: attachedDebuggee || { tabId } };
  attachedTabs.set(tabId, entry);
  // Best-effort Page.enable so JS-dialog events (alert/confirm/prompt/beforeunload) are reported
  // while the debugger is attached (dialog-handling): a dialog that opens during a page.* command
  // is recorded / auto-dismissed by the onEvent listener instead of hard-blocking the chain.
  // Deliberately NOT routed through cdpRaw: its timeout path force-detaches, which would tear
  // down the attach we just made if Page.enable ever stalled.
  void withTimeout(new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(entry.debuggee || { tabId }, "Page.enable", {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  }), CDP_COMMAND_TIMEOUT_MS, "CDP Page.enable").catch(() => undefined);
  // M0: restore + re-apply persisted keepalive modes (network capture, emulation, ...) whose CDP
  // domain state died with the previous session (risk #2). Best-effort: a re-apply failure is
  // logged, never fatal — the mode intent is still restored for the next attempt.
  await restoreModesForTab(tabId).catch((error) => {
    console.warn(`[pi-chrome] restore modes on tab ${tabId} failed: ${String(error?.message || error)}`);
  });
  return entry;
}

async function describeInputTarget(tabId) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0] || null;
  let targets = [];
  try { targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))); } catch {}
  return {
    resolvedTab: tab ? { id: tab.id, windowId: tab.windowId, url: tab.url, status: tab.status, title: tab.title, active: tab.active } : null,
    activeTab: active ? { id: active.id, windowId: active.windowId, url: active.url, status: active.status, title: active.title, active: active.active } : null,
    attachedTabs: Array.from(attachedTabs.keys()),
    cdpTargets: targets.map((t) => ({ id: t.id, tabId: t.tabId, type: t.type, url: t.url, attached: t.attached, extensionId: t.extensionId })),
  };
}

function targetMetaSuffix(meta) {
  return `\nTarget metadata: ${JSON.stringify(meta).slice(0, 4000)}`;
}

async function inputDebug(params) {
  const requested = params?.targetId ? await describeInputTarget(Number(params.targetId)) : await describeInputTarget(-1);
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    ...requested,
    recentAttachEvents: attachDebugLog.slice(),
  };
}

async function detachDebugger(tabId) {
  const entry = attachedTabs.get(tabId);
  if (!entry) return;
  attachedTabs.delete(tabId);
  try { await chrome.debugger.detach(entry.debuggee || { tabId }); } catch {}
}

async function detachAll() {
  const ids = Array.from(attachedTabs.keys());
  await Promise.all(ids.map(detachDebugger));
}

if (chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
    if (tabId !== undefined) {
      attachedTabs.delete(tabId);
      // A detach kills every CDP domain on the target: pending JS dialogs are dismissed by Chrome
      // and Emulation overrides are reset, so forget what we knew about this tab. M0 keepalive
      // registry centralizes the per-tab teardown (network capture flags, blocked-URL patterns,
      // emulation state, paused state) via each mode's onDetach hook. Captured entries are
      // retained so chrome_network_export still has data after the mode was turned off or Chrome
      // detached us. Persisted mode intent is kept so the next command restores + re-applies it.
      pendingDialogs.delete(tabId);
      dialogWaiters.delete(tabId);
      cleanupModesForTab(tabId);
    }
    if (reason === "canceled_by_user") {
      console.warn(`[pi-chrome] debugger canceled by user on tab ${tabId}; Chrome input will reattach on next call`);
    }
  });
}

// Routes CDP Network-domain events into the per-tab capture store. Only active while the agent
// opted into network capture mode (networkModeTabs) — the default idle-detach model stays intact.
function handleCdpNetworkEvent(tabId, method, params) {
  if (!networkModeTabs.has(tabId) || !params || typeof params !== "object") return;
  const requestId = params.requestId;
  if (requestId === undefined || requestId === null) return;
  let tabEntries = cdpNetworkEntries.get(tabId);
  if (!tabEntries) {
    tabEntries = new Map();
    cdpNetworkEntries.set(tabId, tabEntries);
  }
  if (method === "Network.requestWillBeSent") {
    // Redirects re-fire requestWillBeSent with the same requestId; chain the previous hop.
    const prior = tabEntries.get(requestId);
    const req = params.request || {};
    const entry = prior || {
      requestId,
      method: String(req.method || "GET").toUpperCase(),
      url: String(req.url || ""),
      startedAt: Date.now(),
      source: "cdp",
      resourceType: String(params.type || ""),
      requestHeaders: objectToHeaderList(req.headers),
      postData: typeof req.postData === "string" ? req.postData.slice(0, CDP_NETWORK_MAX_BODY_CHARS) : undefined,
      timings: {},
      redirects: [],
    };
    if (prior) {
      entry.redirects.push({
        url: entry.url,
        status: entry.status,
        statusText: entry.statusText || "",
        responseHeaders: entry.responseHeaders || [],
      });
      entry.url = String(req.url || "");
      entry.method = String(req.method || "GET").toUpperCase();
      entry.requestHeaders = objectToHeaderList(req.headers);
      entry.postData = typeof req.postData === "string" ? req.postData.slice(0, CDP_NETWORK_MAX_BODY_CHARS) : undefined;
    }
    if (params.redirectResponse) {
      const rr = params.redirectResponse;
      entry.redirects.push({
        url: entry.url,
        status: rr.status,
        statusText: rr.statusText || "",
        mimeType: rr.mimeType || "",
        responseHeaders: objectToHeaderList(rr.headers),
      });
    }
    if (typeof params.timestamp === "number") entry.requestTimestamp = params.timestamp;
    if (params.documentURL) entry.documentURL = String(params.documentURL);
    if (params.frameId) entry.frameId = String(params.frameId);
    // M0: keep the FULL initiator object (type/url/line/column + CAPPED stack with parent chains)
    // instead of only the type string — chrome_network_initiator_chain rebuilds the DevTools-style
    // request-initiator tree from it (gap report §4.3 / TOOL_CONTRACTS §3.4).
    if (params.initiator) entry.initiator = captureInitiator(params.initiator);
    if (params.initiator && params.initiator.type) entry.initiatorType = String(params.initiator.type);
    tabEntries.set(requestId, entry);
    trimCdpNetworkEntries(tabEntries);
  } else if (method === "Network.responseReceived") {
    const entry = tabEntries.get(requestId);
    if (!entry) return;
    const resp = params.response || {};
    entry.status = resp.status;
    entry.statusText = resp.statusText || "";
    entry.mimeType = resp.mimeType || "";
    entry.responseHeaders = objectToHeaderList(resp.headers);
    entry.protocol = resp.protocol || "";
    entry.fromServiceWorker = resp.fromServiceWorker === true;
    entry.fromCache = resp.fromDiskCache === true || resp.fromMemoryCache === true;
    if (typeof params.timestamp === "number") entry.responseTimestamp = params.timestamp;
    if (resp.timing && typeof resp.timing === "object") entry.timings = { ...resp.timing };
    if (resp.remoteIPAddress) entry.serverIPAddress = String(resp.remoteIPAddress);
    if (typeof resp.encodedDataLength === "number") entry.encodedDataLength = resp.encodedDataLength;
  } else if (method === "Network.loadingFinished") {
    const entry = tabEntries.get(requestId);
    if (!entry) return;
    if (typeof params.timestamp === "number") entry.finishedTimestamp = params.timestamp;
    if (typeof params.encodedDataLength === "number") entry.encodedDataLength = params.encodedDataLength;
    entry.finishedAt = Date.now();
    entry.durationMs = entry.finishedAt - entry.startedAt;
  } else if (method === "Network.loadingFailed") {
    const entry = tabEntries.get(requestId);
    if (!entry) return;
    entry.errorText = String(params.errorText || "Failed");
    entry.canceled = params.canceled === true;
    if (typeof params.timestamp === "number") entry.failedTimestamp = params.timestamp;
    entry.failedAt = Date.now();
    entry.durationMs = entry.failedAt - entry.startedAt;
  } else if (method === "Network.dataReceived") {
    const entry = tabEntries.get(requestId);
    if (!entry) return;
    entry.dataLength = (entry.dataLength || 0) + (params.dataLength || 0);
    if (typeof params.encodedDataLength === "number") entry.encodedDataLength = (entry.encodedDataLength || 0) + params.encodedDataLength;
  }
}

// Normalize a Network.requestWillBeSent initiator into a capped, serializable record so
// chrome_network_initiator_chain can rebuild the DevTools-style request-initiator tree. The full
// CDP initiator carries { type, url, lineNumber, columnNumber, stack { callFrames, parent } } and
// is discarded today — only the type string survives. We keep the origin of the triggering
// script/document plus a CAPPED call stack (functionName/url/line/column), following parent
// chains to depth INITIATOR_PARENT_DEPTH with a hard frame budget (bounded ring, risk #11).
function captureInitiator(initiator) {
  if (!initiator || typeof initiator !== "object") return null;
  const record = { type: String(initiator.type || "") };
  if (typeof initiator.url === "string" && initiator.url) record.url = initiator.url;
  if (typeof initiator.lineNumber === "number") record.lineNumber = initiator.lineNumber;
  if (typeof initiator.columnNumber === "number") record.columnNumber = initiator.columnNumber;
  if (initiator.stack && typeof initiator.stack === "object") {
    const frames = [];
    let stack = initiator.stack;
    let depth = 0;
    while (stack && depth <= INITIATOR_PARENT_DEPTH && frames.length < INITIATOR_STACK_MAX_FRAMES) {
      const callFrames = Array.isArray(stack.callFrames) ? stack.callFrames : [];
      for (const cf of callFrames) {
        if (frames.length >= INITIATOR_STACK_MAX_FRAMES) break;
        frames.push({
          functionName: typeof cf.functionName === "string" ? cf.functionName : "",
          url: typeof cf.url === "string" ? cf.url : "",
          lineNumber: typeof cf.lineNumber === "number" ? cf.lineNumber : null,
          columnNumber: typeof cf.columnNumber === "number" ? cf.columnNumber : null,
        });
      }
      stack = stack.parent || null;
      depth++;
    }
    record.stack = frames;
  }
  return record;
}

function objectToHeaderList(headers) {
  if (!headers || typeof headers !== "object") return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

// Oldest-first eviction (Map preserves insertion order) so capture never grows unbounded.
function trimCdpNetworkEntries(tabEntries) {
  if (tabEntries.size <= CDP_NETWORK_MAX_ENTRIES_PER_TAB) return;
  const overflow = tabEntries.size - CDP_NETWORK_MAX_ENTRIES_PER_TAB;
  for (const key of Array.from(tabEntries.keys()).slice(0, overflow)) tabEntries.delete(key);
}

// Feeds the chrome_dialog tool. Records every Page.javascriptDialogOpening and auto-dismisses
// alert() dialogs (no accept/dismiss semantics) that no chrome_dialog call is waiting for, so a
// stray alert() never hard-blocks the action chain. confirm/prompt/beforeunload stay pending for
// the agent to handle explicitly via chrome_dialog (dialog-handling).
if (chrome.debugger && chrome.debugger.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, eventParams) => {
    if (source.tabId === undefined) return;
    const tabId = source.tabId;
    if (method === "Page.javascriptDialogOpening") {
      const info = {
        tabId,
        dialogType: String(eventParams?.type || "alert"),
        message: String(eventParams?.message || ""),
        url: String(eventParams?.url || ""),
        defaultPrompt: String(eventParams?.defaultPrompt || ""),
        hasBrowserHandler: eventParams?.hasBrowserHandler === true,
        openedAt: Date.now(),
      };
      pendingDialogs.set(tabId, info);
      if (info.dialogType === "alert" && !dialogWaiters.has(tabId)) {
        pendingDialogs.delete(tabId);
        void cdpRaw(tabId, "Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
      }
      return;
    }
    if (method === "Debugger.paused") {
      // Record the pause so ensurePageUsable can auto-resume before any evaluate/snapshot/input
      // command and the idle-detach sweep exempts the tab (a detach would force-resume, losing
      // the pause). Call frames are preview-capped (bounded buffers, risk #11); the full stack is
      // re-derivable via Debugger.getStackTrace when a debugger tool needs it.
      pausedTabs.set(tabId, {
        reason: String(eventParams?.reason || "other"),
        callFrames: Array.isArray(eventParams?.callFrames)
          ? eventParams.callFrames.map((cf) => ({
              functionName: String(cf?.functionName || ""),
              url: String(cf?.url || ""),
              lineNumber: typeof cf?.lineNumber === "number" ? cf.lineNumber : null,
              columnNumber: typeof cf?.columnNumber === "number" ? cf.columnNumber : null,
            })).slice(0, 50)
          : [],
        timestamp: Date.now(),
      });
      registerMode(tabId, MODE_PAUSED);
      return;
    }
    if (method === "Debugger.resumed") {
      if (pausedTabs.delete(tabId)) unregisterMode(tabId, MODE_PAUSED);
      return;
    }
    if (method.startsWith("Network.")) handleCdpNetworkEvent(tabId, method, eventParams);
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [tabId, entry] of attachedTabs) {
    if (entry.detachAt && entry.detachAt < now) {
      // A pending modal dialog is dismissed by Chrome on detach; keep the attach alive so the
      // agent can still reach it with chrome_dialog after the triggering command returns.
      if (pendingDialogs.has(tabId)) { entry.detachAt = now + 2000; continue; }
      // M0 keepalive registry: any active mode (network capture, emulation, paused page, ...)
      // exempts the tab from idle-detach — the CDP domain state dies with the attach, silently
      // ending capture / overrides / the pause mid-session.
      const modes = modesPerTab.get(tabId);
      if (modes && modes.size > 0) { extendAttachKeepalive(tabId, entry); continue; }
      void detachDebugger(tabId);
    }
  }
}, 5000);

function cdpRaw(tabId, method, params) {
  const debuggee = attachedTabs.get(tabId)?.debuggee || { tabId };
  // Runtime.evaluate (page.evaluate / long awaitPromise) gets a longer, NON-destructive timeout:
  // force-detaching the debugger here would abort a slow page script and lose its result. The
  // aggressive detach stays for input-dispatch methods and transport-sensitive commands, where a
  // hung session must be torn down so the next call re-attaches cleanly.
  const isEvaluate = method === "Runtime.evaluate";
  const timeoutMs = isEvaluate ? CDP_EVALUATE_TIMEOUT_MS : CDP_COMMAND_TIMEOUT_MS;
  return withTimeout(new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(`${method}: ${chrome.runtime.lastError.message}`));
      else resolve(result);
    });
  }), timeoutMs, `CDP ${method}`, async () => {
    if (!isEvaluate) {
      attachedTabs.delete(tabId);
      try { await chrome.debugger.detach(debuggee); } catch {}
    }
  });
}

function executeScriptTimed(options, label) {
  return withTimeout(chrome.scripting.executeScript(options), SCRIPTING_TIMEOUT_MS, label || "chrome.scripting.executeScript");
}

// Wraps cdpRaw with one auto-recover on detached/closed sessions:
// chrome.debugger.attach can stay cached in attachedTabs even after Chrome killed
// the session (tab nav, devtools opened/closed, etc). Recover by detaching the
// stale entry and re-attaching, then retry the command once.
// Find foreign chrome-extension targets currently anchored to the tab. Password managers,
// autofill helpers, and other input-attached extensions create type:"other" CDP targets
// whose URL is chrome-extension://<otherId>/...  When that target is in focus, CDP refuses
// our Input.dispatchMouseEvent calls with "Cannot access a chrome-extension:// URL of
// different extension" — surfacing a cryptic error to the user.
async function findForeignExtensionTargets() {
  try {
    const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
    return targets.filter((t) => {
      const url = String(t.url || "");
      if (!url.startsWith("chrome-extension://")) return false;
      if (t.extensionId === chrome.runtime.id) return false;
      return true;
    });
  } catch {
    return [];
  }
}

function extractForeignExtId(targets) {
  for (const t of targets) {
    if (t.extensionId && t.extensionId !== chrome.runtime.id) return t.extensionId;
    const m = String(t.url || "").match(/chrome-extension:\/\/([a-p]+)\//);
    if (m && m[1] !== chrome.runtime.id) return m[1];
  }
  return null;
}

async function dismissOverlayViaEscape(tabId) {
  // Esc routes through key dispatcher (target-by-focus), not by mouse coordinates, so it
  // works even when a foreign chrome-extension popup is intercepting pointer events.
  try {
    await cdpRaw(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdpRaw(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(120);
  } catch {}
}

async function cdp(tabId, method, params) {
  try {
    return await cdpRaw(tabId, method, params);
  } catch (error) {
    const msg = String(error?.message || error);
    const isStale = /Debugger is not attached|Detached while|Target closed|No tab with id/i.test(msg);
    const isForeignExtBlock = /Cannot access a chrome-extension:\/\/ URL of different extension/i.test(msg);
    if (isForeignExtBlock && /Input\./.test(method)) {
      // Foreign chrome-extension popup (autofill, password manager) is hijacking input.
      // Try once: dismiss via Esc, then retry.
      const before = await findForeignExtensionTargets();
      recordAttachEvent({ kind: "foreign-ext-detected", tabId, method, foreignExtId: extractForeignExtId(before), targetCount: before.length });
      await dismissOverlayViaEscape(tabId);
      try {
        return await cdpRaw(tabId, method, params);
      } catch (retryErr) {
        const retryMsg = String(retryErr?.message || retryErr);
        if (/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(retryMsg)) {
          const after = await findForeignExtensionTargets();
          const id = extractForeignExtId(after) || extractForeignExtId(before) || "unknown";
          throw new Error(
            `Another Chrome extension (${id}) has an input overlay on this page (e.g. a password manager / autofill popup). \n` +
            `pi-chrome tried to dismiss it with Escape but it reappeared. Disable that extension on this page, close its popup, or focus the field via Tab instead of clicking.`,
          );
        }
        throw retryErr;
      }
    }
    if (!isStale) throw error;
    attachedTabs.delete(tabId);
    await attachDebugger(tabId).catch(() => undefined);
    return cdpRaw(tabId, method, params);
  }
}

// cdpEval: evaluate a JavaScript expression string in the page's MAIN world via CDP
// Runtime.evaluate. Runtime.evaluate is a DevTools protocol command and is NOT subject to
// the page's Content-Security-Policy, so it works on pages that ship `script-src 'self'`
// without `'unsafe-eval'` (which blocks `eval`/`new Function`). Ensures the debugger is
// attached first. Returns the raw CDP result ({ result, exceptionDetails }).
async function cdpEval(tabId, expression, opts) {
  await attachDebugger(tabId);
  return cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    // Arbitrary bridge-driven eval must NOT synthesize user activation (audit: a local attacker
    // or injected script could otherwise click/confirm on the user's behalf). Only the explicit
    // CDP input paths (click/type/fill/upload) enable userGesture.
    userGesture: false,
    ...(opts || {}),
  });
}

function cdpExceptionText(details) {
  if (!details) return "";
  return String(
    details.exception?.description ||
      details.exception?.value ||
      details.text ||
      "",
  );
}

// ---------------------------------------------------------------------------
// Restricted-scheme fallback
// ---------------------------------------------------------------------------
// chrome.scripting.executeScript cannot inject into browser-internal / opaque origins (about:,
// chrome:, edge:, devtools:, view-source:, chrome-extension:, file:) even with <all_urls>. But
// chrome.debugger/CDP Runtime.evaluate is NOT subject to that host-permission check and works on
// those origins, so for such pages we drive injection and invocation over CDP instead. This fixes
// "Cannot access contents of url about:blank" on a freshly created automation tab.
function isScriptingRestrictedUrl(url) {
  return /^(about:|chrome:|edge:|devtools:|view-source:|chrome-extension:)/i.test(url || "") || /^file:/i.test(url || "");
}

// Resolve whether a tab can be reached by scripting.executeScript. The passed tab object may carry
// an empty/absent url (e.g. an automation target), while the REAL current URL is about:blank for a
// freshly created blank tab — an empty url must not fall through to scripting.executeScript, which
// errors on the actual blank destination. Fetch the authoritative url and treat empty as blank
// (blank is scripting-restricted, so it always routes to the CDP fallback).
async function tabScriptingRestricted(tab) {
  let url = tab && tab.url;
  if (!url && tab && tab.id != null) {
    const fresh = await chrome.tabs.get(tab.id).catch(() => null);
    url = (fresh && fresh.url) || "";
  }
  // Treat empty/absent as blank: a freshly created automation tab has no scriptable URL, and an
  // unknown URL must never fall through to scripting.executeScript (it errors on the real blank
  // destination).
  return isScriptingRestrictedUrl(url ? url : "about:blank");
}

// Fetch the packaged snapshot_injected.js source once so restricted pages can inject it over CDP
// (the scripting files: path is unavailable to them).
let snapshotSourceCache = null;
async function snapshotSourceText() {
  if (snapshotSourceCache === null) {
    snapshotSourceCache = await (await fetch(chrome.runtime.getURL("snapshot_injected.js"))).text();
  }
  return snapshotSourceCache;
}

// Evaluate `expression` in the MAIN (default) world of the given frame. Frame 0 (top) uses the
// default execution context; sub-frames resolve their context via Runtime.enable/executionContexts.
// Returns the raw CDP response (caller reads .exceptionDetails / .result.value).
async function cdpEvalInFrame(tab, frameId, expression, opts) {
  await attachDebugger(tab.id);
  if (!frameId || frameId === 0) {
    return cdp(tab.id, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: false, ...(opts || {}) });
  }
  await cdp(tab.id, "Runtime.enable", {}).catch(() => {});
  const { contexts = [] } = await cdp(tab.id, "Runtime.executionContexts", {}).catch(() => ({}));
  const ctx = (contexts || []).find(
    (c) => c.auxData && String(c.auxData.frameId) === String(frameId) && (c.auxData.type === "default" || c.auxData.type === undefined),
  );
  return cdp(tab.id, "Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true, userGesture: false,
    ...(ctx && typeof ctx.id === "number" ? { contextId: ctx.id } : {}),
    ...(opts || {}),
  });
}

// Wrap a snapshot invocation so its outcome serializes as { ok, value } | { ok, error }, matching
// the func-form wrapper used by scripting.executeScript and preserving the evicted-uid / nearUid
// surfacing that the executeScript path applies to the returned snapshot.
function cdpSnapshotInvoke() {
  return `(async()=>{try{const snapshotPage=globalThis.__piChromeSnapshotPage;if(typeof snapshotPage!=="function")throw new Error("snapshot_injected.js did not install __piChromeSnapshotPage");const invocationArgs=__piArgs;const value=await snapshotPage(...invocationArgs);if(value&&typeof value==="object"){const pageState=globalThis.__PI_CHROME_STATE__;if(pageState&&Array.isArray(pageState.evictedUids)&&pageState.evictedUids.length){if(!value.summary)value.summary={};value.summary.evictedUids=pageState.evictedUids.slice(-20);}if(Array.isArray(invocationArgs)&&typeof invocationArgs[3]==="string"){const resolved=pageState&&pageState.elements?pageState.elements[invocationArgs[3]]:null;if(!resolved||!resolved.isConnected){if(!value.filter)value.filter={};value.filter.nearUidResolved=false;}}}return {ok:true,value};}catch(error){return {ok:false,error:error&&error.stack?String(error.stack):String(error&&error.message||error)};}})()`;
}

function cdpInspectInvoke() {
  return `(async()=>{try{const inspectTarget=globalThis.__piChromeInspectTarget;if(typeof inspectTarget!=="function")throw new Error("snapshot_injected.js did not install __piChromeInspectTarget");return {ok:true,value:await inspectTarget(...__piArgs)};}catch(error){return {ok:false,error:error&&error.stack?String(error.stack):String(error&&error.message||error)};}})()`;
}

// Normalize a CDP invoke response into the same { value } | { error } | { missingGlobal } shape that
// unpackFrameInvoke produces, so the snapshot/inspect callers share one re-inject-on-missing path.
function unpackCdpInvoke(res, fallbackError) {
  if (res && res.exceptionDetails) {
    return { missingGlobal: /did not install/.test(cdpExceptionText(res.exceptionDetails)), error: `${fallbackError}: ${cdpExceptionText(res.exceptionDetails) || "unknown"}` };
  }
  const envelope = res && res.result && res.result.value;
  if (envelope && envelope.ok === false) return { missingGlobal: /did not install/.test(String(envelope.error)), error: envelope.error || fallbackError };
  if (envelope && envelope.ok === true) return { value: envelope.value };
  return { error: fallbackError };
}

function cdpIsSyntaxError(details) {
  if (!details) return false;
  const className = String(details.exception?.className || "");
  return className === "SyntaxError" || /SyntaxError/.test(cdpExceptionText(details));
}

// Resolve target -> {x, y, rect} in TOP-LEVEL viewport coords by running tiny script in tab.
// CDP Input.dispatchMouseEvent/TouchEvent/mouseWheel take coordinates relative to the TOP
// frame's viewport, while getBoundingClientRect inside a sub-frame is relative to that frame's
// own viewport — so frame-local coords must be translated before dispatching (subframe-coords).
async function resolveTargetInTab(tabId, params) {
  // Paused-page rail (M0): synthetic input dispatched to a Debugger.paused page hangs — the
  // frozen main thread never handles the injected target script or the CDP input. Auto-resume
  // first and surface the pause in the returned resolution object.
  const pauseNote = await ensurePageUsable(tabId, "input");
  // A uid from a merged sub-frame snapshot carries an "el-f<frameId>-<n>" prefix; resolve the
  // target inside the owning frame so selectors/uid lookups run against the right document.
  const frameUid = params.uid ? parseFrameUid(params.uid) : null;
  const frameId = frameUid ? frameUid.frameId : 0;
  const localUid = frameUid ? frameUid.localUid : (params.uid ?? null);
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    func: (selector, uid, x, y) => {
      const state = window.__PI_CHROME_STATE__;
      let el = null;
      if (uid) {
        el = state && state.elements ? state.elements[uid] : null;
        if (!el || !el.isConnected) return { found: false, staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot`, url: location.href };
      } else if (selector) {
        el = document.querySelector(selector);
      }
      if (el) {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, tag: el.tagName, found: true };
      }
      if (typeof x === "number" && typeof y === "number") return { x, y, rect: null, tag: null, found: true };
      return { found: false };
    },
    args: [params.selector ?? null, localUid, params.x ?? null, params.y ?? null],
  }, `resolve input target in tab ${tabId} frame ${frameId}`);
  const v = results?.[0]?.result;
  if (v?.staleUid) throw new Error(v.reason || "snapshot uid is stale; refresh chrome_snapshot");
  if (!v || !v.found) throw new Error("Could not resolve target element for Chrome input");
  if (frameId > 0) {
    // Translate the sub-frame's viewport-local coordinates into top-level viewport coordinates
    // so CDP input lands on the right element (a frame-local rect is meaningless to the top
    // frame's input dispatcher).
    const offset =
      (await frameOffsetViaPageWalk(tabId, frameId)) ||
      (await frameOffsetViaCDP(tabId, frameId).catch(() => null));
    if (offset && typeof offset.dx === "number" && typeof offset.dy === "number") {
      v.x += offset.dx;
      v.y += offset.dy;
      if (v.rect) {
        v.rect.left += offset.dx;
        v.rect.top += offset.dy;
      }
      v.frameOffset = { dx: offset.dx, dy: offset.dy, method: offset.method || "page-walk" };
    }
  }
  if (pauseNote && v && typeof v === "object") v.pausedAutoResumed = pauseNote;
  return v;
}

// Same-origin sub-frame -> top viewport offset by walking the window.frameElement chain. Each
// frame's content-box origin is its iframe element's border-box origin + border widths, summed
// up to the top window. Cross-origin frames hide frameElement (returns null), so the walk
// reports crossOrigin and the caller falls back to the CDP DOM.getBoxModel path.
async function frameOffsetViaPageWalk(tabId, frameId) {
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    func: () => {
      let dx = 0, dy = 0;
      let w = window;
      while (w && w !== window.top) {
        const fe = w.frameElement;
        if (!fe || typeof fe.getBoundingClientRect !== "function") return { crossOrigin: true };
        const r = fe.getBoundingClientRect();
        const cs = getComputedStyle(fe);
        // Border-box -> content-box: the frame's own viewport starts inside the iframe border.
        dx += r.left + (parseFloat(cs.borderLeftWidth) || 0);
        dy += r.top + (parseFloat(cs.borderTopWidth) || 0);
        w = w.parent;
      }
      return { dx, dy, crossOrigin: false, nested: w !== window.top };
    },
  }, `translate subframe offset for tab ${tabId} frame ${frameId}`);
  const v = results?.[0]?.result;
  if (v && !v.crossOrigin && typeof v.dx === "number" && typeof v.dy === "number") return v;
  return null;
}

// Cross-origin (OOPIF) and nested-chain fallback: resolve the frame's owner element from the
// TOP frame via CDP DOM.getFrameOwner and read its content-box origin (the frame's viewport
// origin in top-frame CSS pixels) from DOM.getBoxModel. Works uniformly for same-origin frames
// too; the page-walk is just cheaper when it applies.
async function frameOffsetViaCDP(tabId, frameId) {
  await cdp(tabId, "DOM.enable", {}).catch(() => undefined);
  const owner = await cdp(tabId, "DOM.getFrameOwner", { frameId });
  if (!owner || typeof owner.nodeId !== "number") throw new Error(`DOM.getFrameOwner returned no owner for frame ${frameId}`);
  const box = await cdp(tabId, "DOM.getBoxModel", { nodeId: owner.nodeId });
  if (!box || !box.model || !Array.isArray(box.model.content) || box.model.content.length < 2) {
    throw new Error(`DOM.getBoxModel returned no content box for frame ${frameId}`);
  }
  // model.content = [x1,y1, x2,y1, x2,y2, x1,y2] in top-frame CSS pixels.
  return { dx: box.model.content[0], dy: box.model.content[1], method: "cdp-box-model" };
}

function pickInsideRect(rect) {
  if (!rect) return null;
  const insetX = Math.min(rect.width * 0.35, Math.max(2, rect.width / 2 - 1));
  const insetY = Math.min(rect.height * 0.35, Math.max(2, rect.height / 2 - 1));
  return {
    x: rect.left + rect.width / 2 + rng(-insetX, insetX),
    y: rect.top + rect.height / 2 + rng(-insetY, insetY),
  };
}

async function cdpMoveTo(tabId, x, y) {
  const entry = attachedTabs.get(tabId);
  const startX = entry?.pointer?.x ?? Math.max(20, Math.min(400, x - 200));
  const startY = entry?.pointer?.y ?? Math.max(20, Math.min(400, y - 200));
  const n = Math.max(18, Math.min(42, Math.round(Math.hypot(x - startX, y - startY) / 18)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 8;
    const px = startX + (x - startX) * ease + rng(-wobble, wobble);
    const py = startY + (y - startY) * ease + rng(-wobble, wobble);
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: px, y: py, button: "none", buttons: 0, pointerType: "mouse",
    });
    await sleep(rng(5, 16));
  }
  if (entry) entry.pointer = { x, y };
}

function cdpModifiersFor(mods) {
  let m = 0;
  if (mods?.altKey) m |= 1;
  if (mods?.ctrlKey) m |= 2;
  if (mods?.metaKey) m |= 4;
  if (mods?.shiftKey) m |= 8;
  return m;
}

// Resolve a single printable character to { code, keyCode, needShift } on a US layout.
// Self-contained (maps defined inline) so it can be serialized into the page via
// HELPER_FUNCS for the DOM-event fallback as well as used by the CDP path.
// Using charCodeAt() for punctuation is wrong: e.g. "." is charCode 46 which collides
// with VK_DELETE, "-" is 45 (VK_INSERT), so app keydown handlers misfire and drop input.
function usKeyLayoutForChar(ch) {
  const PUNCT = {
    "`": { code: "Backquote", keyCode: 192 }, "~": { code: "Backquote", keyCode: 192, shift: true },
    "-": { code: "Minus", keyCode: 189 }, "_": { code: "Minus", keyCode: 189, shift: true },
    "=": { code: "Equal", keyCode: 187 }, "+": { code: "Equal", keyCode: 187, shift: true },
    "[": { code: "BracketLeft", keyCode: 219 }, "{": { code: "BracketLeft", keyCode: 219, shift: true },
    "]": { code: "BracketRight", keyCode: 221 }, "}": { code: "BracketRight", keyCode: 221, shift: true },
    "\\": { code: "Backslash", keyCode: 220 }, "|": { code: "Backslash", keyCode: 220, shift: true },
    ";": { code: "Semicolon", keyCode: 186 }, ":": { code: "Semicolon", keyCode: 186, shift: true },
    "'": { code: "Quote", keyCode: 222 }, "\"": { code: "Quote", keyCode: 222, shift: true },
    ",": { code: "Comma", keyCode: 188 }, "<": { code: "Comma", keyCode: 188, shift: true },
    ".": { code: "Period", keyCode: 190 }, ">": { code: "Period", keyCode: 190, shift: true },
    "/": { code: "Slash", keyCode: 191 }, "?": { code: "Slash", keyCode: 191, shift: true },
    " ": { code: "Space", keyCode: 32 },
  };
  // Shifted digit symbols share the digit's physical code + keyCode.
  const SHIFT_DIGIT = { ")": "0", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9" };
  if (/^[a-z]$/.test(ch)) return { code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), needShift: false };
  if (/^[A-Z]$/.test(ch)) return { code: `Key${ch}`, keyCode: ch.charCodeAt(0), needShift: true };
  if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, keyCode: ch.charCodeAt(0), needShift: false };
  if (SHIFT_DIGIT[ch]) { const d = SHIFT_DIGIT[ch]; return { code: `Digit${d}`, keyCode: d.charCodeAt(0), needShift: true }; }
  const p = PUNCT[ch];
  if (p) return { code: p.code, keyCode: p.keyCode, needShift: !!p.shift };
  // Unknown char (e.g. unicode): keep text-driven insertion, avoid bogus keyCode collisions.
  return { code: ch, keyCode: 0, needShift: false };
}

function cdpKeyInfo(key, shifted) {
  // Map common keys to CDP key event init fields. Returns { code, key, windowsVirtualKeyCode, text }.
  const SPECIAL = {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Tab: { code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
    Backspace: { code: "Backspace", windowsVirtualKeyCode: 8, text: "" },
    Delete: { code: "Delete", windowsVirtualKeyCode: 46, text: "" },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27, text: "" },
    ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37, text: "" },
    ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38, text: "" },
    ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39, text: "" },
    ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40, text: "" },
    Shift: { code: "ShiftLeft", windowsVirtualKeyCode: 16, text: "" },
    Control: { code: "ControlLeft", windowsVirtualKeyCode: 17, text: "" },
    Alt: { code: "AltLeft", windowsVirtualKeyCode: 18, text: "" },
    Meta: { code: "MetaLeft", windowsVirtualKeyCode: 91, text: "" },
    " ": { code: "Space", windowsVirtualKeyCode: 32, text: " " },
  };
  if (SPECIAL[key]) return { key, ...SPECIAL[key] };
  if (key.length === 1) {
    const ch = key;
    const layout = usKeyLayoutForChar(ch);
    return { key: ch, code: layout.code, windowsVirtualKeyCode: layout.keyCode, text: ch };
  }
  return { key, code: key, windowsVirtualKeyCode: 0, text: "" };
}

async function cdpTypeChar(tabId, ch, delayScale) {
  const pace = typeof delayScale === "number" && Number.isFinite(delayScale) ? Math.max(0, Math.min(4, delayScale)) : 1;
  const needShift = /^[A-Z]$/.test(ch) || "~!@#$%^&*()_+{}|:\"<>?".includes(ch);
  let modifiers = 0;
  if (needShift) {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
    modifiers = 8;
    await sleep(rng(8, 22) * pace);
  }
  const info = cdpKeyInfo(ch);
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    text: info.text, unmodifiedText: info.text, modifiers,
  });
  await sleep(rng(25, 90) * pace);
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, modifiers,
  });
  if (needShift) {
    await sleep(rng(5, 18) * pace);
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
  }
  await sleep(rng(35, 130) * pace);
}

// One-shot CDP text insertion (DevTools' own fast path). Fires a single beforeinput/input per
// composition — much faster than per-character key events; usable where the page accepts it.
async function cdpInsertText(tabId, text) {
  await cdp(tabId, "Input.insertText", { text });
}

// Normalize the chrome_type/chrome_fill pacing scale. 1 = current humanized pace; values below
// 1 speed typing up (0 = no sleeps); values above 1 slow it down. Clamped to [0, 4].
function typingDelayScale(params) {
  const value = params && (params.delayScale ?? params.typingSpeed);
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(4, value));
  return 1;
}

async function domClickFallback(tabId, params, cause) {
  // Route to the owning frame for sub-frame uids, same as resolveTargetInTab.
  const frameUid = params.uid ? parseFrameUid(params.uid) : null;
  const frameId = frameUid ? frameUid.frameId : 0;
  const localUid = frameUid ? frameUid.localUid : (params.uid ?? null);
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    func: (selector, uid, x, y) => {
      const state = window.__PI_CHROME_STATE__;
      let el = uid && state && state.elements ? state.elements[uid] : null;
      if (uid && (!el || !el.isConnected)) return { staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot`, url: location.href };
      if (!el && selector) el = document.querySelector(selector);
      if (!el && typeof x === "number" && typeof y === "number") el = document.elementFromPoint(x, y);
      if (!el) throw new Error(`DOM fallback target not found: ${uid || selector || `${x},${y}`}`);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = el.getBoundingClientRect();
      const eventInit = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, buttons: 1 };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mousedown", eventInit));
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
      el.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
      el.click();
      return { tag: el.tagName, url: location.href };
    },
    args: [params.selector ?? null, localUid, params.x ?? null, params.y ?? null],
  }, `DOM click fallback in tab ${tabId} frame ${frameId}`);
  const v = results?.[0]?.result;
  if (v?.staleUid) throw new Error(v.reason || "snapshot uid is stale; refresh chrome_snapshot");
  return { input: "dom-fallback", reason: String(cause?.message || cause).slice(0, 500), tag: v?.tag };
}

async function chromeInputClick(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  try {
    await attachDebugger(tab.id);
    const resolved = await resolveTargetInTab(tab.id, params);
    const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
    await cdpMoveTo(tab.id, point.x, point.y);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
    await sleep(rng(45, 140));
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    // Reset :focus-visible if the click landed on a focusable element. CDP-driven pointer
    // focus can leave :focus-visible=true in Chromium, which trips heuristics that expect
    // Reset focus styling after pointer click when possible. Runs in the owning frame so
    // sub-frame uids (el-f<frameId>-…) reset their own document's focus.
    if (params.selector || params.uid) {
      const frameUid = params.uid ? parseFrameUid(params.uid) : null;
      const focusFrameId = frameUid ? frameUid.frameId : 0;
      const focusLocalUid = frameUid ? frameUid.localUid : (params.uid ?? null);
      await executeScriptTimed({
        target: { tabId: tab.id, frameIds: [focusFrameId] },
        world: "MAIN",
        func: (sel, uid) => {
          const state = window.__PI_CHROME_STATE__;
          let el = null;
          if (uid && state && state.elements && state.elements[uid]) el = state.elements[uid];
          else if (sel) el = document.querySelector(sel);
          if (el && typeof el.focus === "function" && el === document.activeElement) {
            try { el.blur(); el.focus({ preventScroll: true, focusVisible: false }); } catch {}
          }
        },
        args: [params.selector ?? null, focusLocalUid],
      }, `reset focus style in tab ${tab.id} frame ${focusFrameId}`).catch(() => undefined);
    }
    return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
  } catch (error) {
    if (params.domFallback === false) throw error;
    return domClickFallback(tab.id, params, error);
  }
}

async function chromeInputHover(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const resolved = await resolveTargetInTab(tab.id, params);
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  await cdpMoveTo(tab.id, point.x, point.y);
  await sleep(rng(80, 220));
  return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
}

async function chromeInputKey(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const key = String(params.key || "");
  if (!key) throw new Error("chrome.key: missing key");
  const mods = params.modifiers || {};
  const modBits = cdpModifiersFor(mods);
  // Press modifiers in standard order, then key, then release in reverse.
  const modOrder = [];
  if (mods.metaKey) modOrder.push({ key: "Meta", code: "MetaLeft", vk: 91 });
  if (mods.ctrlKey) modOrder.push({ key: "Control", code: "ControlLeft", vk: 17 });
  if (mods.altKey) modOrder.push({ key: "Alt", code: "AltLeft", vk: 18 });
  if (mods.shiftKey) modOrder.push({ key: "Shift", code: "ShiftLeft", vk: 16 });
  for (const m of modOrder) {
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: modBits });
    await sleep(rng(6, 18));
  }
  const info = cdpKeyInfo(key);
  // When modifiers are active, browsers usually emit "rawKeyDown" (no text) so chords like Cmd+V don't insert the literal char.
  const downType = modBits ? "rawKeyDown" : "keyDown";
  await cdp(tab.id, "Input.dispatchKeyEvent", {
    type: downType, key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    text: modBits ? "" : info.text, unmodifiedText: modBits ? "" : info.text, modifiers: modBits,
  });
  await sleep(rng(25, 90));
  await cdp(tab.id, "Input.dispatchKeyEvent", {
    type: "keyUp", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, modifiers: modBits,
  });
  for (const m of modOrder.reverse()) {
    await sleep(rng(5, 18));
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: 0 });
  }
  return { input: "chrome", key: info.key, modifiers: mods };
}

async function chromeInputType(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  if (params.selector || params.uid) {
    // Focus target by clicking it first.
    const resolved = await resolveTargetInTab(tab.id, params);
    const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
    await cdpMoveTo(tab.id, point.x, point.y);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
    await sleep(rng(45, 110));
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    await sleep(rng(50, 120));
  }
  const text = String(params.text || "");
  const delayScale = typingDelayScale(params);
  if (text) {
    if (params.insertText === true) {
      // Whole-string fast path (one CDP Input.insertText) for pages that accept it.
      await cdpInsertText(tab.id, text);
    } else {
      for (const ch of Array.from(text)) await cdpTypeChar(tab.id, ch, delayScale);
    }
  }
  if (params.pressEnter) {
    // One proper Enter only — a preceding '\r' text insertion caused a double Enter/newline and
    // double form submission (double-enter).
    await chromeInputKey({ ...params, key: "Enter" });
  }
  return { input: "chrome", length: text.length, pacing: delayScale };
}

async function domFillFallback(tabId, params, cause) {
  if (!(params.selector || params.uid)) throw cause;
  // Route to the owning frame for sub-frame uids, same as domClickFallback / resolveTargetInTab.
  const frameUid = params.uid ? parseFrameUid(params.uid) : null;
  const frameId = frameUid ? frameUid.frameId : 0;
  const localUid = frameUid ? frameUid.localUid : (params.uid ?? null);
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    func: async (selector, uid, text, submit) => {
      const state = window.__PI_CHROME_STATE__;
      let el = uid && state && state.elements ? state.elements[uid] : null;
      if (uid && (!el || !el.isConnected)) return { staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot`, url: location.href };
      if (!el && selector) el = document.querySelector(selector);
      if (!el) throw new Error(`DOM fallback target not found: ${uid || selector}`);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
      const value = String(text ?? "");
      if ("value" in el) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
      } else if (el.isContentEditable) {
        el.textContent = value;
      } else {
        throw new Error(`DOM fallback target is not fillable: <${el.tagName.toLowerCase()}>`);
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (submit) {
        const form = el.closest("form");
        if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
        else document.querySelector("button,[type=submit]")?.click();
      }
      return { valueMatches: "value" in el ? el.value === value : el.textContent === value, tag: el.tagName, url: location.href };
    },
    args: [params.selector ?? null, localUid, params.text ?? "", params.submit === true],
  }, `DOM fill fallback in tab ${tabId} frame ${frameId}`);
  const v = results?.[0]?.result;
  if (v?.staleUid) throw new Error(v.reason || "snapshot uid is stale; refresh chrome_snapshot");
  return { input: "dom-fallback", length: String(params.text || "").length, valueMatches: v?.valueMatches, reason: String(cause?.message || cause).slice(0, 500), tag: v?.tag };
}

// Core fill sequence for one already-resolved field: focus via triple-click, clear, type text.
// Shared by chromeInputFill (single field) and chromeFillForm (batched fields) so batch fills
// behave exactly like single fills. Returns the outcome shape of chrome_fill.
async function fillAtPoint(tabId, fieldParams, resolved) {
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  await cdpMoveTo(tabId, point.x, point.y);
  // Triple-click selects all in input fields.
  for (let i = 1; i <= 3; i++) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: i, pointerType: "mouse", force: 0.5 });
    await sleep(rng(20, 60));
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: i, pointerType: "mouse" });
    await sleep(rng(20, 60));
  }
  // Delete selection.
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await sleep(rng(20, 60));
  const text = String(fieldParams.text || "");
  const delayScale = typingDelayScale(fieldParams);
  if (text) {
    if (fieldParams.insertText === true) {
      await cdpInsertText(tabId, text);
    } else {
      for (const ch of Array.from(text)) await cdpTypeChar(tabId, ch, delayScale);
    }
  }
  return { input: "chrome", length: text.length, pacing: delayScale };
}

async function chromeInputFill(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  try {
    await attachDebugger(tab.id);
    if (!(params.selector || params.uid)) throw new Error("chrome.fill: selector or uid required");
    const resolved = await resolveTargetInTab(tab.id, params);
    const outcome = await fillAtPoint(tab.id, params, resolved);
    if (params.submit) await chromeInputKey({ ...params, key: "Enter" });
    return outcome;
  } catch (error) {
    if (params.domFallback === false) throw error;
    return domFillFallback(tab.id, params, error);
  }
}

// Read back the filled value of one field (MAIN world, CSP-safe via scripting.executeScript).
// Best-effort verification for the batched chrome_fill_form path: returns null when the element
// is stale (it may have been re-rendered by a framework between fill and verify).
async function verifyFieldValue(tabId, field) {
  const frameUid = field.uid ? parseFrameUid(field.uid) : null;
  const frameId = frameUid ? frameUid.frameId : 0;
  const localUid = frameUid ? frameUid.localUid : (field.uid ?? null);
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    func: (selector, uid, expected) => {
      const state = window.__PI_CHROME_STATE__;
      let el = uid && state && state.elements ? state.elements[uid] : null;
      if (uid && (!el || !el.isConnected)) return { stale: true };
      if (!el && selector) el = document.querySelector(selector);
      if (!el) return { stale: true };
      const actual = "value" in el ? el.value : (el.isContentEditable ? el.textContent : "");
      return { actual: String(actual ?? ""), expected: String(expected ?? "") };
    },
    args: [field.selector ?? null, localUid, field.text],
  }, `verify filled value in tab ${tabId} frame ${frameId}`);
  const v = results?.[0]?.result;
  if (!v || v.stale) return null;
  return { verified: v.actual === v.expected, actual: v.actual };
}

// Batch form fill: fills many fields in ONE bridge call. Target resolution runs in parallel
// (read-only), then each field is filled SEQUENTIALLY through the same CDP input path as
// chrome_fill (concurrent CDP input on one tab would race focus and interleave keystrokes).
// Per-field outcomes include the chrome_fill result plus a best-effort value verification.
async function chromeFillForm(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  if (!Array.isArray(params.fields) || !params.fields.length) throw new Error("chrome_fill_form: fields[] is required");
  const fields = params.fields.map((field, index) => ({
    index,
    uid: field?.uid ?? null,
    selector: field?.selector ?? null,
    text: String(field?.text ?? ""),
    insertText: field?.insertText === true,
    delayScale: field?.delayScale,
    domFallback: field?.domFallback !== false,
  }));
  for (const field of fields) {
    if (!field.uid && !field.selector) throw new Error(`chrome_fill_form: field #${field.index} needs uid or selector`);
  }
  await attachDebugger(tab.id);
  // Resolve every target in parallel (read-only script executions never race input).
  const resolved = await Promise.all(fields.map((field) =>
    resolveTargetInTab(tab.id, { uid: field.uid, selector: field.selector })
      .catch((error) => ({ resolveError: String(error?.message || error) })),
  ));
  const results = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const target = resolved[i];
    if (target.resolveError) {
      results.push({ index: field.index, ok: false, error: target.resolveError });
      continue;
    }
    try {
      results.push({ index: field.index, ok: true, ...(await fillAtPoint(tab.id, field, target)) });
    } catch (error) {
      if (!field.domFallback) {
        results.push({ index: field.index, ok: false, error: String(error?.message || error) });
        continue;
      }
      try {
        results.push({ index: field.index, ok: true, ...(await domFillFallback(tab.id, field, error)) });
      } catch (fallbackError) {
        results.push({ index: field.index, ok: false, error: String(fallbackError?.message || fallbackError) });
      }
    }
  }
  // Per-field verification in parallel after all fills (chrome_fill semantics kept per field).
  const verified = await Promise.all(fields.map((field, i) =>
    results[i]?.ok ? verifyFieldValue(tab.id, field).catch(() => null) : null,
  ));
  for (let i = 0; i < results.length; i++) {
    if (results[i]?.ok && verified[i]) {
      results[i].verified = verified[i].verified;
      results[i].actualValue = verified[i].actual;
    }
  }
  if (params.submit) {
    const last = fields[fields.length - 1];
    try {
      await chromeInputKey({ ...params, uid: last.uid ?? undefined, selector: last.selector ?? undefined, key: "Enter" });
    } catch {
      // Enter-in-field is best-effort; a form that needs a real submit button is the agent's call.
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(`chrome_fill_form: ${failed.length}/${fields.length} field(s) failed: ${JSON.stringify(results)}`);
  }
  return { fields: results, count: results.length, submitted: params.submit === true };
}

async function chromeInputScroll(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const resolved = (params.selector || params.uid) ? await resolveTargetInTab(tab.id, params) : { x: 100, y: 100, rect: null };
  const x = resolved.rect ? resolved.rect.left + Math.min(resolved.rect.width, 800) / 2 : resolved.x;
  const y = resolved.rect ? resolved.rect.top + Math.min(resolved.rect.height, 600) / 2 : resolved.y;
  const totalY = params.deltaY || 0, totalX = params.deltaX || 0;
  // Profile mimics a trackpad flick: short ramp-up (~15% of events), then geometric decay
  // with a ~12% drop per event. Gives momentum tail tests something to find, and the small
  // tail deltas (a handful of <20px events) put IntersectionObserver thresholds in range.
  const peak = Math.max(Math.abs(totalY), Math.abs(totalX));
  // Aim peak event ~22px so cumulative wheel approach to target seeds low-ratio IO samples.
  const PEAK_TARGET = 22;
  const w = [];
  // Build weights for an arbitrary n, then iterate to find an n where peak * (w_peak/sum) <= PEAK_TARGET.
  function build(n) {
    const arr = [];
    const peakIdx = Math.max(1, Math.floor(n * 0.15));
    for (let i = 0; i < n; i++) {
      if (i <= peakIdx) arr.push(0.5 + 0.5 * (i / peakIdx)); // 0.5 → 1.0
      else arr.push(Math.pow(0.88, i - peakIdx));            // ~12% drop per step
    }
    return arr;
  }
  let n = Math.max(12, params.steps || 24);
  for (let attempt = 0; attempt < 8; attempt++) {
    const arr = build(n);
    const s = arr.reduce((a, b) => a + b, 0);
    const peakStep = peak * (Math.max(...arr) / s);
    if (peakStep <= PEAK_TARGET || n >= 240) {
      w.length = 0;
      w.push(...arr);
      break;
    }
    n = Math.ceil(n * 1.4);
  }
  if (w.length === 0) w.push(...build(n));
  const sumW = w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    const dy = totalY * (w[i] / sumW), dx = totalX * (w[i] / sumW);
    await cdp(tab.id, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, pointerType: "mouse",
    });
    // Sleep one+ frame so IntersectionObserver / rAF samples can run between events.
    await sleep(rng(22, 48));
  }
  return { input: "chrome", deltaX: totalX, deltaY: totalY, steps: n };
}

async function chromeInputTap(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const resolved = (params.selector || params.uid || (typeof params.x === "number" && typeof params.y === "number"))
    ? await resolveTargetInTab(tab.id, params)
    : null;
  if (!resolved || !resolved.found) throw new Error("chrome.tap: target not found");
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  const tp = { x: point.x, y: point.y, radiusX: 8, radiusY: 8, rotationAngle: 0, force: 0.5, id: 1 };
  await cdp(tab.id, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tp] });
  await sleep(rng(40, 110));
  await cdp(tab.id, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
}

async function chromeInputDrag(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const from = await resolveTargetInTab(tab.id, { selector: params.fromSelector ?? null, uid: params.fromUid ?? null, x: params.fromX ?? null, y: params.fromY ?? null });
  const to = await resolveTargetInTab(tab.id, { selector: params.toSelector ?? null, uid: params.toUid ?? null, x: params.toX ?? null, y: params.toY ?? null });
  const fp = from.rect ? pickInsideRect(from.rect) : { x: from.x, y: from.y };
  const tp = to.rect ? pickInsideRect(to.rect) : { x: to.x, y: to.y };
  await cdpMoveTo(tab.id, fp.x, fp.y);
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: fp.x, y: fp.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
  await sleep(rng(60, 140));
  const steps = params.steps || 20;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 6;
    const x = fp.x + (tp.x - fp.x) * ease + rng(-wobble, wobble);
    const y = fp.y + (tp.y - fp.y) * ease + rng(-wobble, wobble);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, pointerType: "mouse" });
    await sleep(rng(10, 26));
  }
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: tp.x, y: tp.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  return { input: "chrome", from: fp, to: tp, steps };
}

async function chromeInputUpload(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  if (!(params.selector || params.uid)) throw new Error("chrome.upload: selector or uid required");
  const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
  if (!paths.length) throw new Error("chrome.upload: no file paths provided");
  // Sub-frame uids (el-f<frameId>-<n>) must resolve the <input type=file> inside the owning
  // frame; the top-frame Runtime.evaluate path can only see the top document (fill-frame audit).
  const frameUid = params.uid ? parseFrameUid(params.uid) : null;
  const frameId = frameUid ? frameUid.frameId : 0;
  const localUid = frameUid ? frameUid.localUid : (params.uid ?? null);
  const { objectId, nodeId } = frameId > 0
    ? await resolveFileInputInFrame(tab.id, frameId, params.selector ?? null, localUid)
    : await resolveFileInputTopFrame(tab.id, params.selector ?? null, params.uid ?? null);
  await cdp(tab.id, "DOM.setFileInputFiles", { nodeId, files: paths });
  await cdp(tab.id, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() { this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return this.files ? this.files.length : 0; }`,
    returnByValue: true,
  }).catch(() => undefined);
  await cdp(tab.id, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  return { input: "chrome", uploaded: paths.map((path) => ({ path })) };
}

// Resolve a file input in the TOP frame (existing CDP path). Returns {objectId, nodeId}.
async function resolveFileInputTopFrame(tabId, selector, uid) {
  const expression = `(() => {
    const selector = ${JSON.stringify(selector ?? null)};
    const uid = ${JSON.stringify(uid ?? null)};
    const state = window.__PI_CHROME_STATE__;
    const el = uid && state && state.elements ? state.elements[uid] : (selector ? document.querySelector(selector) : null);
    if (!el || el.tagName !== "INPUT" || el.type !== "file") throw new Error("Target must be <input type=file>");
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return el;
  })()`;
  const evaluated = await cdp(tabId, "Runtime.evaluate", { expression, objectGroup: "pi-chrome-upload", includeCommandLineAPI: false, returnByValue: false, userGesture: true });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || "Could not resolve file input");
  const objectId = evaluated.result?.objectId;
  if (!objectId) throw new Error("Could not resolve file input object");
  await cdp(tabId, "DOM.enable", {}).catch(() => undefined);
  const requested = await cdp(tabId, "DOM.requestNode", { objectId });
  if (!requested.nodeId) throw new Error("Could not resolve file input node");
  return { objectId, nodeId: requested.nodeId };
}

// Resolve a file input inside a same-origin SUB-frame: DOM.getFrameOwner gives the iframe's
// owner node, resolveNode hands us the element, and callFunctionOn on its contentDocument finds
// the input in the frame's own main world (where the frame's __PI_CHROME_STATE__ lives).
// Cross-origin (OOPIF) frames cannot expose contentDocument to the top frame — surface a clear
// error instead of silently resolving against the wrong document.
async function resolveFileInputInFrame(tabId, frameId, selector, localUid) {
  await cdp(tabId, "DOM.enable", {}).catch(() => undefined);
  const owner = await cdp(tabId, "DOM.getFrameOwner", { frameId });
  if (!owner || typeof owner.nodeId !== "number") throw new Error("Could not resolve the sub-frame's owner element");
  const ownerObj = await cdp(tabId, "DOM.resolveNode", { nodeId: owner.nodeId });
  if (!ownerObj?.object?.objectId) throw new Error("Could not resolve the sub-frame's document");
  const found = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId: ownerObj.object.objectId,
    functionDeclaration: `function(selector, uid) {
      const doc = this.contentDocument;
      if (!doc) return null;
      const state = doc.defaultView && doc.defaultView.__PI_CHROME_STATE__;
      let el = uid && state && state.elements ? state.elements[uid] : null;
      if (!el && selector) el = doc.querySelector(selector);
      if (el && el.tagName === "INPUT" && el.type === "file") {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        return el;
      }
      return null;
    }`,
    arguments: [{ value: selector }, { value: localUid }],
    returnByValue: false,
  });
  await cdp(tabId, "Runtime.releaseObject", { objectId: ownerObj.object.objectId }).catch(() => undefined);
  if (found.exceptionDetails) throw new Error(`Could not resolve file input in sub-frame: ${found.exceptionDetails.text || "evaluation failed"}`);
  const objectId = found.result?.objectId;
  if (!objectId) throw new Error("File input not found in sub-frame (cross-origin frames cannot be reached for file upload)");
  const requested = await cdp(tabId, "DOM.requestNode", { objectId });
  if (!requested.nodeId) throw new Error("Could not resolve file input node in sub-frame");
  return { objectId, nodeId: requested.nodeId };
}

// =================== M0: generic uid/selector -> CDP nodeId resolver ===================
// nodeIds are document-scoped and invalidated by navigation, so they are NEVER cached across
// messages: every command re-resolves through Runtime.evaluate (top frame) or DOM.getFrameOwner
// (sub-frame uid) + DOM.requestNode. A stale uid (element removed from the DOM since the
// snapshot) surfaces a clear "take a fresh snapshot" error instead of a confusing CDP failure.
//
// Returns { objectId, nodeId, frameId }. Callers MUST Runtime.releaseObject the objectId when
// they no longer need the remote reference (risk #6 remote-object leaks).
async function resolveCdpNode(tabId, params, opts = {}) {
  const selector = params && params.selector !== undefined ? params.selector : null;
  const uid = params && params.uid !== undefined ? params.uid : null;
  const frameUid = uid ? parseFrameUid(uid) : null;
  const frameId = frameUid ? frameUid.frameId : (opts.frameId || 0);
  const localUid = frameUid ? frameUid.localUid : uid;
  const { objectId } = frameId > 0
    ? await resolveNodeInFrame(tabId, frameId, selector, localUid)
    : await resolveNodeTopFrame(tabId, selector, localUid);
  if (!objectId) throw new Error("Element not found in the live document");
  await cdp(tabId, "DOM.enable", {}).catch(() => undefined);
  const requested = await cdp(tabId, "DOM.requestNode", { objectId });
  if (!requested.nodeId) throw new Error("Could not resolve element node (DOM.requestNode returned no nodeId)");
  return { objectId, nodeId: requested.nodeId, frameId };
}

// Top-frame resolution. Returns { objectId } or throws a fresh-snapshot error for stale uids.
async function resolveNodeTopFrame(tabId, selector, uid) {
  const expression = `(() => {
    const selector = ${JSON.stringify(selector ?? null)};
    const uid = ${JSON.stringify(uid ?? null)};
    const state = window.__PI_CHROME_STATE__;
    const el = uid && state && state.elements ? state.elements[uid] : (selector ? document.querySelector(selector) : null);
    if (!el) return "__piNotFound";
    if (!el.isConnected) return "__piStale";
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return el;
  })()`;
  const evaluated = await cdp(tabId, "Runtime.evaluate", {
    expression,
    objectGroup: NODE_RESOLVE_OBJECT_GROUP,
    includeCommandLineAPI: false,
    returnByValue: false,
    userGesture: false,
  });
  if (evaluated.exceptionDetails) throw new Error(`Could not resolve element: ${evaluated.exceptionDetails.text || "evaluation failed"}`);
  const result = evaluated.result;
  if (result && result.value === "__piStale") {
    throw new Error(`Snapshot uid ${uid} refers to an element that is no longer connected to the document — take a fresh chrome_snapshot and retry.`);
  }
  if (result && result.value === "__piNotFound" || !result || !result.objectId) {
    const reason = uid ? `snapshot uid ${uid}` : `selector ${selector}`;
    throw new Error(`No element found in the live document for ${reason} — take a fresh chrome_snapshot or check the selector.`);
  }
  return { objectId: result.objectId };
}

// Sub-frame (same-origin) resolution via DOM.getFrameOwner -> contentDocument. Cross-origin
// (OOPIF) frames cannot expose contentDocument to the top frame — surface a clear error instead
// of silently resolving against the wrong document (risk #7 OOPIF routing).
async function resolveNodeInFrame(tabId, frameId, selector, localUid) {
  await cdp(tabId, "DOM.enable", {}).catch(() => undefined);
  const owner = await cdp(tabId, "DOM.getFrameOwner", { frameId });
  if (!owner || typeof owner.nodeId !== "number") {
    throw new Error("Could not resolve the sub-frame's owner element (the frame may have navigated away)");
  }
  const ownerObj = await cdp(tabId, "DOM.resolveNode", { nodeId: owner.nodeId });
  if (!ownerObj?.object?.objectId) throw new Error("Could not resolve the sub-frame's document");
  const found = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId: ownerObj.object.objectId,
    functionDeclaration: `function(selector, uid) {
      const doc = this.contentDocument;
      if (!doc) return "__piNotFound";
      const state = doc.defaultView && doc.defaultView.__PI_CHROME_STATE__;
      let el = uid && state && state.elements ? state.elements[uid] : null;
      if (!el && selector) el = doc.querySelector(selector);
      if (!el) return "__piNotFound";
      if (!el.isConnected) return "__piStale";
      try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch {}
      return el;
    }`,
    arguments: [{ value: selector }, { value: localUid }],
    returnByValue: false,
  });
  await cdp(tabId, "Runtime.releaseObject", { objectId: ownerObj.object.objectId }).catch(() => undefined);
  if (found.exceptionDetails) throw new Error(`Could not resolve element in sub-frame: ${found.exceptionDetails.text || "evaluation failed"}`);
  const result = found.result;
  if (result && result.value === "__piStale") {
    throw new Error(`Snapshot uid ${localUid} refers to an element that is no longer connected in frame ${frameId} — take a fresh chrome_snapshot and retry.`);
  }
  if ((result && result.value === "__piNotFound") || !result || !result.objectId) {
    const reason = localUid ? `snapshot uid ${localUid}` : `selector ${selector}`;
    throw new Error(`No element found in frame ${frameId} for ${reason} — cross-origin (OOPIF) frames cannot be reached for DOM resolution.`);
  }
  return { objectId: result.objectId };
}
// ===============================================================

// --- bridge polling state ---
// reloadIntent: version-skew detected; the reload is DEFERRED until the /next payload already
//   served in this response has been fully consumed (version-reload-drop).
let reloadIntent = false;
// lastBridgeActivity: last time a real session contact happened (command handled, orphan
//   served, heartbeat posted). NOT bumped by empty /next polls, so an idle extension stops
//   polling and heartbeating and the MV3 worker can suspend.
let lastBridgeActivity = Date.now();
// consecutivePollFailures: bridge-down probe counter for exponential backoff + stop (poll-backoff).
let consecutivePollFailures = 0;

function armKeepaliveAlarm() {
  chrome.alarms.create("pi-bridge-keepalive", { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "pi" });
  chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
  armKeepaliveAlarm();
  void pollLoop();
  void sendHeartbeat();
});

chrome.runtime.onStartup.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
  void sendHeartbeat();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pi-bridge-keepalive") {
    // The alarm is the cold-wake mechanism for the pull model: it re-arms pollLoop after an
    // idle suspend or a bridge-down backoff exit. pollLoop/sendHeartbeat self-gate on session
    // activity so an idle worker does no redundant work between alarm fires.
    void pollLoop();
    void sendHeartbeat();
  }
});

chrome.action.onClicked.addListener(() => {
  armKeepaliveAlarm();
  consecutivePollFailures = 0;
  lastBridgeActivity = Date.now();
  void pollLoop();
});

armKeepaliveAlarm();
// NOTE: no 1s setInterval here — the /next while-loop + alarm already re-arm polling (sw-keepalive).

// Post liveness heartbeats for the session keys we actually know (the automationTargets this
// extension owns); fall back to the default key when nothing is owned. Skipped entirely while the
// extension is idle so a suspended worker doesn't keep dead grants alive.
async function sendHeartbeat() {
  if (automationTargets.size === 0 && Date.now() - lastBridgeActivity > HEARTBEAT_IDLE_SKIP_MS) return;
  const keys = automationTargets.size ? Array.from(automationTargets.keys()) : [DEFAULT_SESSION_KEY];
  for (const sessionKey of keys) {
    try {
      await fetch(`${BRIDGE_URL}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey }),
      });
      lastBridgeActivity = Date.now();
    } catch {
      // Best-effort liveness signaling; a down bridge is handled by pollLoop's backoff.
    }
  }
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (true) {
      // Idle = no owned automation targets AND no session traffic for a long while. While idle we
      // still probe /next ONCE per alarm cycle with a short timeout (so a fresh command/session
      // is noticed within ~30s), then exit and let the MV3 worker suspend. An active session
      // keeps the continuous long-poll (sw-keepalive / poll-backoff).
      const idle = automationTargets.size === 0 && Date.now() - lastBridgeActivity > POLL_IDLE_EXIT_MS;
      let response;
      let idleTimer;
      try {
        if (idle) {
          const controller = new AbortController();
          idleTimer = setTimeout(() => controller.abort(), POLL_IDLE_PROBE_MS);
          response = await fetch(`${BRIDGE_URL}/next?name=${encodeURIComponent(CLIENT_NAME)}`, { cache: "no-store", signal: controller.signal });
        } else {
          response = await fetch(`${BRIDGE_URL}/next?name=${encodeURIComponent(CLIENT_NAME)}`, { cache: "no-store" });
        }
      } catch {
        if (idleTimer) clearTimeout(idleTimer);
        consecutivePollFailures++;
        if (idle) break; // idle probe aborted (nothing queued) -> suspend until the alarm re-arms.
        if (consecutivePollFailures >= POLL_MAX_CONSECUTIVE_FAILURES) break;
        await sleep(pollBackoffDelay());
        continue;
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
      if (!response.ok) {
        // HTTP errors (5xx etc.) count as bridge-down; retrying on a short backoff keeps the
        // loop from hot-spinning either way.
        consecutivePollFailures++;
        if (consecutivePollFailures >= POLL_MAX_CONSECUTIVE_FAILURES) break;
        await sleep(pollBackoffDelay());
        continue;
      }
      consecutivePollFailures = 0;
      const expected = response.headers.get("x-pi-chrome-version");
      const ours = chrome.runtime.getManifest().version;
      const payload = await response.json();
      const versionSkewed = !!expected && expected !== ours && isVersionOlder(ours, expected);
      if (versionSkewed) reloadIntent = true;
      if (payload.type === "command") {
        lastBridgeActivity = Date.now();
        await handleCommand(payload.command);
      } else if (payload.type === "orphan") {
        // The bridge served a delivered-but-unacked-result command that it gave up on. Never
        // re-execute; surface the warning and keep polling (the client decides whether to verify
        // page state and retry with a NEW id).
        lastBridgeActivity = Date.now();
        console.warn(`[pi-chrome] orphan: ${payload.orphan.id} may have executed`);
      } else if (idle) {
        // No command and still idle: exit so the worker can suspend; the alarm re-arms polling.
        break;
      }
      // Reload only AFTER the payload was consumed (a command served in this /next response is
      // handled to completion first), so version-skew reloads never drop a command (version-reload-drop).
      if (reloadIntent) {
        reloadIntent = false;
        console.warn(`[pi-chrome] extension v${ours} behind pi-chrome v${expected}; reloading extension`);
        try { chrome.runtime.reload(); } catch {}
        return;
      }
    }
  } catch (error) {
    await sleep(POLL_ERROR_BACKOFF_MS);
  } finally {
    polling = false;
  }
}

// Exponential backoff capped at POLL_BACKOFF_CAP_MS (2s -> 4s -> 8s -> 16s -> 30s -> 30s ...).
function pollBackoffDelay() {
  const exponent = Math.min(Math.max(consecutivePollFailures - 1, 0), 6);
  return Math.min(POLL_BACKOFF_CAP_MS, POLL_ERROR_BACKOFF_MS * Math.pow(2, exponent));
}

// =================== exactly-once executed-command journal ===================
// A delivered command that the SW acknowledged but whose result never reached the bridge (owner
// death between /next and /result) looks identical to a never-executed command. The journal
// remembers executed ids so a client retry with the SAME id is answered from the journal instead
// of re-running the side effect. Persisted in chrome.storage.session: survives SW restarts (MV3
// suspends workers at any time) and is cleared on browser restart.
//
// journal-quota: only a compact digest is persisted per entry ({id, action, ok, resultHash,
// completedAt, aborted?}) under a total byte budget with oldest-first eviction — storing FULL
// results made storage.session quota failures silently drop dedupe protection. Full results for
// replay live in a small in-memory LRU (recentResults); a retried id whose result is no longer
// retained is answered with "already executed; retry with a new id" instead of replaying stale data.
async function loadJournal() {
  try {
    const stored = await chrome.storage?.session?.get?.(JOURNAL_STORAGE_KEY);
    const saved = stored && stored[JOURNAL_STORAGE_KEY];
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

async function persistJournal(journal) {
  try {
    await chrome.storage?.session?.set?.({ [JOURNAL_STORAGE_KEY]: journal });
  } catch {
    // Ignore: losing the journal only risks a rare duplicate re-run, never a missed action.
  }
}

// Compact, bounded fingerprint of a command result (never the result itself).
function resultDigest(result) {
  let raw;
  if (typeof result === "string") raw = result;
  else { try { raw = JSON.stringify(result ?? null); } catch { raw = String(result); } }
  if (raw.length > 2000) raw = raw.slice(0, 2000);
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function journalEntryBytes(entry) {
  try { return JSON.stringify(entry).length; } catch { return 128; }
}

// Drop entries older than the TTL, cap the map by entry count AND by total serialized bytes
// (oldest first). Called on every handleCommand so the journal never grows unbounded.
function sweepJournal(journal, now) {
  const ttlBoundary = now - JOURNAL_TTL_MS;
  for (const id of Object.keys(journal)) {
    const entry = journal[id];
    if (!entry || typeof entry.completedAt !== "number" || entry.completedAt < ttlBoundary) delete journal[id];
  }
  let ids = Object.keys(journal);
  if (ids.length > JOURNAL_MAX_ENTRIES) {
    ids = ids.sort((a, b) => (journal[a].completedAt || 0) - (journal[b].completedAt || 0));
    const excess = ids.length - JOURNAL_MAX_ENTRIES;
    for (let i = 0; i < excess; i++) delete journal[ids[i]];
  }
  ids = Object.keys(journal).sort((a, b) => (journal[a].completedAt || 0) - (journal[b].completedAt || 0));
  // Budget the FULL serialized map — entry values AND their id keys — so the persisted journal
  // cannot exceed JOURNAL_MAX_BYTES regardless of how long ids are. Each id serializes as
  // `"id":` (id.length + 3 chars) plus a comma separator (1 char); braces add 2 (conservative
  // by exactly 1 byte vs the true serialization).
  let bytes = 2;
  for (const id of ids) bytes += journalEntryBytes(journal[id]) + id.length + 4;
  while (bytes > JOURNAL_MAX_BYTES && ids.length) {
    const oldest = ids.shift();
    bytes -= journalEntryBytes(journal[oldest]) + oldest.length + 4;
    delete journal[oldest];
  }
}

// In-memory LRU of recent FULL results for dedupe replay (id -> { result, bytes, at }). Bounded by
// both entry count and total bytes; oversized results are never cached.
const recentResults = new Map();
function rememberRecentResult(id, result) {
  let bytes = 0;
  try { bytes = JSON.stringify(result ?? null).length; } catch { bytes = 4096; }
  if (bytes > RECENT_RESULT_MAX_ENTRY_BYTES) return;
  recentResults.delete(id);
  recentResults.set(id, { result, bytes, at: Date.now() });
  let total = 0;
  for (const [k, v] of recentResults) {
    total += v.bytes;
    if (total > RECENT_RESULTS_MAX_BYTES || recentResults.size > RECENT_RESULTS_MAX) recentResults.delete(k);
  }
}

// Per-command timeout: the host already sends timeoutMs on the /command wire; thread it through
// with a safety ceiling and scale it by operation cost so long commands (typing, waitFor,
// full-page screenshots) are not killed by the fixed 25s budget (command-timeout).
function computeCommandTimeout(command) {
  const wire = command?.timeoutMs;
  const base = typeof wire === "number" && Number.isFinite(wire) ? wire : COMMAND_TIMEOUT_MS;
  const clamped = Math.max(1000, Math.min(COMMAND_TIMEOUT_CEILING_MS, base));
  const params = command?.params || {};
  if ((command?.action === "page.type" || command?.action === "page.fill") && typeof params.text === "string") {
    // ~55ms/char over the humanized per-character pace plus headroom.
    return Math.min(COMMAND_TIMEOUT_CEILING_MS, clamped + params.text.length * 55 + 5000);
  }
  if (command?.action === "page.fillForm" && Array.isArray(params.fields)) {
    // Batch fills are sequential CDP input; scale by total text length and field count.
    const totalChars = params.fields.reduce((sum, field) => sum + String(field?.text || "").length, 0);
    return Math.min(COMMAND_TIMEOUT_CEILING_MS, clamped + totalChars * 55 + params.fields.length * 5000 + 8000);
  }
  if (command?.action === "page.dialog") {
    const requested = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
    return Math.min(COMMAND_TIMEOUT_CEILING_MS, Math.max(clamped, requested + 8000));
  }
  if (command?.action === "downloads.wait") {
    const requested = typeof params.timeoutMs === "number" ? params.timeoutMs : DOWNLOAD_WAIT_DEFAULT_MS;
    return Math.min(COMMAND_TIMEOUT_CEILING_MS, Math.max(clamped, requested + 5000));
  }
  if (command?.action === "page.waitFor") {
    const requested = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
    return Math.min(COMMAND_TIMEOUT_CEILING_MS, Math.max(clamped, requested + 10000));
  }
  return clamped;
}

// Mark a command that was interrupted (timeout or pre-reload teardown) so a same-id retry is
// warned instead of silently re-executing the side effect.
function markInterrupted(id, journal, action) {
  if (!journal[id]) journal[id] = { id, action: action || "", ok: false, aborted: true, completedAt: Date.now() };
  else journal[id].aborted = true;
  void persistJournal(journal);
}

async function handleCommand(command) {
  const id = command?.id;
  if (typeof id !== "string" || !id) {
    await postResult({ id: id ?? "", ok: false, error: "command missing id" });
    return;
  }
  const journal = await loadJournal();
  sweepJournal(journal, Date.now());
  const prior = journal[id];
  if (prior) {
    // Already executed (client retried with the same stable id after an owner-death timeout). Do
    // NOT re-run. Full results replay from the in-memory LRU; otherwise answer with a "new id"
    // hint — the persisted digest is a dedupe marker, not a replay oracle.
    await persistJournal(journal);
    if (prior.aborted) {
      await postResult({ id, ok: false, error: `Command ${id} was interrupted before it completed; it may have executed. Retry with a NEW id to re-run.`, deduplicated: true });
      return;
    }
    const recent = recentResults.get(id);
    if (recent) {
      await postResult({ id, ok: true, result: recent.result, deduplicated: true });
    } else {
      await postResult({ id, ok: false, error: `Command ${id} was already executed; its result is no longer retained. Retry with a NEW id to re-run.`, deduplicated: true });
    }
    return;
  }
  // Mark the command received BEFORE executing so the bridge's orphan sweep can tell "executed
  // but result lost" from "never picked up". Best-effort: execution proceeds even if the ack
  // fails (the /ack endpoint is idempotent).
  await postAck(id);
  lastBridgeActivity = Date.now();
  const timeoutMs = computeCommandTimeout(command);
  try {
    const result = await withTimeout(
      dispatch(command.action, command.params ?? {}),
      timeoutMs,
      command.action || "Chrome command",
      // The timeout must ACTUALLY cancel: tear down the debugger sessions (stopping in-flight
      // CDP input) and journal the id as executed-but-aborted so a same-id retry is warned
      // instead of starting a second concurrent input stream (command-timeout).
      () => { markInterrupted(id, journal, command.action || ""); detachAll(); },
    );
    journal[id] = { id, action: command.action || "", ok: true, resultHash: resultDigest(result), completedAt: Date.now() };
    // Enforce the TTL/count/byte budget against the NEW entry too — the top-of-function sweep
    // ran before it existed, and persisting past the budget would violate the journal-quota bound.
    sweepJournal(journal, Date.now());
    await persistJournal(journal);
    rememberRecentResult(id, result);
    await postResult({ id, ok: true, result });
  } catch (error) {
    // Never journal plain failures (a retried failed command must execute again), but KEEP an
    // interrupted marker written by the timeout handler so a same-id retry is warned instead of
    // re-executing the side effect.
    if (!journal[id] || !journal[id].aborted) delete journal[id];
    await persistJournal(journal);
    await postResult({ id, ok: false, error: error?.message ?? String(error) });
  }
}

// Best-effort delivery-ack with one retry. The server treats duplicate/unknown acks as no-ops, so
// retrying cannot corrupt state — at worst the command is never marked "received" and a timeout
// reports it as "may have executed" (the safe, conservative outcome).
async function postAck(id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${BRIDGE_URL}/ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (response.ok) return;
    } catch {
      // Fall through to the retry (network error).
    }
    if (attempt === 0) await sleep(250);
  }
  console.warn(`[pi-chrome] ack for command ${id} failed after retry; server may treat it as never-received`);
}

// Result delivery with backoff retry. A lost /result is what turns a landed action into a phantom
// timeout (and a double side effect on client retry), so this must be more reliable than a single
// fire-and-forget POST. Retries are limited to transient failures: network errors, HTTP >= 500,
// or any non-ok fetch. A 4xx means the bridge rejected the payload — retrying cannot fix it.
async function postResult(result) {
  const RETRY_DELAYS_MS = [500, 1500, 3000];
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetch(`${BRIDGE_URL}/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
      if (response.status >= 400 && response.status < 500) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
  }
  console.warn(`[pi-chrome] postResult failed for command ${result.id} after ${RETRY_DELAYS_MS.length} retries: ${lastError?.message ?? "unknown error"}`);
}

function isVersionOlder(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

function cleanGroupTitle(value) {
  const text = String(value || "Pi").replace(/\s+/g, " ").trim().slice(0, 80);
  return text || "Pi";
}

function cleanGroupColor(value) {
  const color = String(value || DEFAULT_GROUP_COLOR).toLowerCase();
  return VALID_GROUP_COLORS.has(color) ? color : DEFAULT_GROUP_COLOR;
}

async function groupRecord(groupId) {
  if (typeof groupId !== "number" || groupId < 0 || !chrome.tabGroups) return null;
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!group) return null;
  return {
    id: group.id,
    title: group.title || "",
    color: group.color || "",
    collapsed: Boolean(group.collapsed),
    windowId: group.windowId,
    piGroup: Boolean(group.title && PI_GROUP_RE.test(group.title)),
  };
}

// Find existing tab groups whose title matches `title` (case-insensitive).
// Same-window lookup is used when grouping an already-created tab. Any-window lookup is used before
// creating a new Pi tab so one Pi session keeps one tab group and new tabs are created in that
// group's window (Chrome tab groups cannot span windows).
async function findGroupByTitle(windowId, title) {
  if (!chrome.tabGroups) return null;
  const wanted = cleanGroupTitle(title).toLowerCase();
  const groups = await chrome.tabGroups.query({ windowId }).catch(() => []);
  const match = groups.find((g) => (g.title || "").trim().toLowerCase() === wanted);
  return match ? match.id : null;
}

async function findGroupRecordByTitle(title) {
  if (!chrome.tabGroups) return null;
  const wanted = cleanGroupTitle(title).toLowerCase();
  const groups = await chrome.tabGroups.query({}).catch(() => []);
  return groups.find((g) => (g.title || "").trim().toLowerCase() === wanted) || null;
}

// Add `tab` to a tab group, then set title/color. If the tab is ungrouped, reuse an
// existing same-title group in its window when present, otherwise create a new group.
async function groupTab(tab, title, color) {
  if (!chrome.tabGroups) throw new Error("chrome.tabGroups API unavailable; reload the extension after granting the tabGroups permission");
  if (!tab || typeof tab.id !== "number") throw new Error("No tab to group");
  const groupTitle = cleanGroupTitle(title);
  let groupId = tab.groupId;
  if (typeof groupId !== "number" || groupId < 0) {
    const existing = await findGroupByTitle(tab.windowId, groupTitle);
    groupId = existing !== null
      ? await chrome.tabs.group({ groupId: existing, tabIds: [tab.id] })
      : await chrome.tabs.group({ tabIds: [tab.id] });
  }
  await chrome.tabGroups.update(groupId, { title: groupTitle, color: cleanGroupColor(color), collapsed: false });
  const grouped = await chrome.tabs.get(tab.id);
  return { tab: await formatTab(grouped), group: await groupRecord(groupId) };
}

// =================== CDP Network-domain commands (feat-cdp-network / feat-har) ===================
// Non-destructive CDP domain enable (M0): mirrors the enableNetworkDomain policy so a slow or
// failing <domain>.enable NEVER force-detaches the attach (the cdpRaw timeout path tears down the
// session). Domain enables are idempotent, so this is safe to call after every (re)attach — every
// new CDP domain (CSS, Runtime, Debugger, Log, Fetch, ...) MUST be enabled through this helper.
async function enableCdpDomain(tabId, domain) {
  await withTimeout(new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(attachedTabs.get(tabId)?.debuggee || { tabId }, `${domain}.enable`, {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  }), CDP_COMMAND_TIMEOUT_MS, `CDP ${domain}.enable`);
}

async function enableNetworkDomain(tabId) {
  return enableCdpDomain(tabId, "Network");
}

// Opt a tab into persistent CDP Network capture: attach (if needed), mark the attach as
// network-mode (the idle-detach sweep skips it), enable the Network domain, and re-apply any
// blocked-URL patterns previously set (Network.setBlockedURLs dies with the attach). M0: the
// mode registers in the keepalive registry (keepalive + persist + re-apply-on-re-attach).
async function ensureNetworkCapture(tabId) {
  const entry = await attachDebugger(tabId);
  entry.networkMode = true;
  networkModeTabs.add(tabId);
  registerMode(tabId, MODE_NETWORK);
  if (!cdpNetworkEntries.has(tabId)) cdpNetworkEntries.set(tabId, new Map());
  await enableNetworkDomain(tabId);
  const blocked = blockedUrlsPerTab.get(tabId);
  if (blocked && blocked.length) {
    await cdp(tabId, "Network.setBlockedURLs", { urls: blocked }).catch(() => undefined);
  }
  // Network.setCacheDisabled also dies with the attach — re-apply chrome_network_cache's setting.
  if (cacheDisabledPerTab.has(tabId)) {
    await cdp(tabId, "Network.setCacheDisabled", { cacheDisabled: cacheDisabledPerTab.get(tabId) === true }).catch(() => undefined);
  }
}

async function disableNetworkCapture(tabId) {
  networkModeTabs.delete(tabId);
  unregisterMode(tabId, MODE_NETWORK);
  const entry = attachedTabs.get(tabId);
  if (entry) {
    entry.networkMode = false;
    // Back to the default idle-detach model; the sweep detaches after the idle window.
    entry.detachAt = Date.now() + INPUT_IDLE_DETACH_MS;
  }
}

// Fetch one response body via the Network domain on demand (HAR export / CDP entry lookup). Uses
// the non-destructive sendCommand wrapper so a slow body must NOT force-detach the persistent
// attach; a failure just means that body is skipped. Returns { text, base64Encoded }.
async function fetchCdpResponseBody(tabId, requestId) {
  try {
    const result = await withTimeout(new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(attachedTabs.get(tabId)?.debuggee || { tabId }, "Network.getResponseBody", { requestId }, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    }), CDP_COMMAND_TIMEOUT_MS, `CDP Network.getResponseBody`);
    return { text: String(result && result.body !== undefined ? result.body : ""), base64Encoded: !!(result && result.base64Encoded) };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

function isHarBodyEligible(mimeType) {
  // Skip known-binary types (images/media/fonts/streams); empty mime is attempted and capped.
  const mime = String(mimeType || "").toLowerCase();
  if (!mime || NETWORK_TEXT_MIME_RE.test(mime)) return true;
  return !/^(image\/|audio\/|video\/|font\/|application\/(octet-stream|zip|gzip|pdf))/.test(mime);
}

function capHarBody(text) {
  if (typeof text !== "string" || text.length <= CDP_NETWORK_MAX_BODY_CHARS) return text;
  return text.slice(0, CDP_NETWORK_MAX_BODY_CHARS) + `\n[truncated ${text.length - CDP_NETWORK_MAX_BODY_CHARS} chars]`;
}

function isoTime(ms) {
  return new Date(ms).toISOString();
}

// CDP Network.timing -> HAR timings (seconds in CDP, ms in HAR; -1 = unknown, as HAR allows).
function cdpTimingsToHar(cdpTiming) {
  if (!cdpTiming || typeof cdpTiming !== "object") return { blocked: -1, dns: -1, connect: -1, send: 0, wait: -1, receive: 0, ssl: -1 };
  // CDP Network.timing uses -1 (seconds) for phases that were not measured; treat those as
  // unknown instead of converting them into a bogus negative-millisecond value.
  const toMs = (v) => (typeof v === "number" && v >= 0 ? Math.round(v * 1000) : -1);
  const diffMs = (a, b) => (toMs(a) !== -1 && toMs(b) !== -1 ? Math.max(0, toMs(a) - toMs(b)) : -1);
  return {
    blocked: diffMs(cdpTiming.sendStart, cdpTiming.requestTime),
    dns: diffMs(cdpTiming.dnsEnd, cdpTiming.dnsStart),
    connect: diffMs(cdpTiming.connectEnd, cdpTiming.connectStart),
    send: diffMs(cdpTiming.sendEnd, cdpTiming.sendStart),
    wait: diffMs(cdpTiming.receiveHeadersEnd, cdpTiming.sendEnd),
    receive: diffMs(cdpTiming.receiveEnd, cdpTiming.receiveHeadersEnd),
    ssl: -1,
  };
}

function harTimingsTotal(timings) {
  const keys = ["blocked", "dns", "connect", "send", "wait", "receive", "ssl"];
  let total = 0, unknown = 0;
  for (const key of keys) {
    const v = timings[key];
    if (typeof v === "number" && v >= 0) total += v;
    else unknown++;
  }
  return unknown === keys.length ? -1 : total;
}

function headersFromPairs(pairs) {
  if (!Array.isArray(pairs)) return [];
  return pairs.map(([name, value]) => ({ name: String(name), value: String(value) }));
}

// In-page fetch/XHR capture entry -> HAR entry (has response bodies; no request headers captured).
function pageEntryToHar(pe, now, includeBodies) {
  const body =
    includeBodies && pe._bodySkipped !== "budget" && typeof pe.responseBody === "string" ? pe.responseBody : undefined;
  return {
    pageref: "page_1",
    startedDateTime: isoTime(pe.startedAt || now),
    time: typeof pe.durationMs === "number" ? Math.max(0, pe.durationMs) : 0,
    request: {
      method: pe.method || "GET",
      url: pe.url || "",
      httpVersion: "",
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status: typeof pe.status === "number" ? pe.status : 0,
      statusText: pe.statusText || "",
      httpVersion: "",
      cookies: [],
      headers: headersFromPairs(pe.responseHeaders),
      content: { size: body !== undefined ? body.length : -1, mimeType: pe.mimeType || "", ...(body !== undefined ? { text: body } : {}) },
      redirectURL: pe.responseUrl && pe.responseUrl !== pe.url ? pe.responseUrl : "",
      headersSize: -1,
      bodySize: body !== undefined ? body.length : -1,
      ...(pe.error !== undefined ? { _error: pe.error } : {}),
      ...(pe._bodySkipped ? { _bodySkipped: pe._bodySkipped } : {}),
    },
    cache: {},
    timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: typeof pe.durationMs === "number" ? Math.max(0, pe.durationMs) : -1, receive: 0, ssl: -1 },
    _source: "page",
    _requestId: pe.id,
    _pageUrl: pe.pageUrl,
  };
}

// CDP Network-domain entry -> HAR entry. Response bodies are attached by the caller (page-captured
// body on merge, or budgeted CDP Network.getResponseBody fetch); this builder never fetches itself
// so the export budget applies exactly once (feat-har).
async function cdpEntryToHar(tabId, ce, now, includeBodies) {
  const pageBody = includeBodies && typeof ce._pageBody === "string" ? ce._pageBody : undefined;
  const fetchedBody = includeBodies && typeof ce._fetchedBody === "string" ? ce._fetchedBody : undefined;
  const bodyText = pageBody !== undefined ? pageBody : fetchedBody;
  const content = {
    size: bodyText !== undefined ? bodyText.length : (typeof ce.encodedDataLength === "number" ? ce.encodedDataLength : -1),
    mimeType: ce.mimeType || "",
    ...(bodyText !== undefined ? { text: bodyText } : {}),
    ...(ce.bodyError ? { _bodyError: ce.bodyError } : {}),
    ...(ce._bodySkipped ? { _bodySkipped: ce._bodySkipped } : {}),
  };
  const timings = cdpTimingsToHar(ce.timings || {});
  return {
    pageref: "page_1",
    startedDateTime: isoTime(ce.startedAt || now),
    time: typeof ce.durationMs === "number" ? Math.max(0, ce.durationMs) : harTimingsTotal(timings),
    request: {
      method: ce.method || "GET",
      url: ce.url || "",
      httpVersion: ce.protocol || "",
      cookies: [],
      headers: ce.requestHeaders || [],
      queryString: [],
      ...(includeBodies && ce.postData !== undefined ? { postData: { mimeType: "", text: capHarBody(ce.postData) } } : {}),
      headersSize: -1,
      bodySize: typeof ce.postData === "string" ? ce.postData.length : -1,
    },
    response: {
      status: typeof ce.status === "number" ? ce.status : 0,
      statusText: ce.statusText || "",
      httpVersion: ce.protocol || "",
      cookies: [],
      headers: ce.responseHeaders || [],
      content,
      redirectURL: "",
      headersSize: -1,
      bodySize: bodyText !== undefined ? bodyText.length : -1,
      ...(typeof ce.encodedDataLength === "number" ? { _transferSize: ce.encodedDataLength } : {}),
      ...(ce.errorText !== undefined ? { _error: ce.errorText, _canceled: ce.canceled === true } : {}),
    },
    cache: {},
    timings,
    ...(ce.serverIPAddress !== undefined ? { serverIPAddress: ce.serverIPAddress } : {}),
    ...(ce.redirects && ce.redirects.length ? { _redirects: ce.redirects } : {}),
    _source: "cdp",
    _requestId: ce.requestId,
    _resourceType: ce.resourceType || "",
    _fromCache: ce.fromCache === true,
    _fromServiceWorker: ce.fromServiceWorker === true,
    _pageUrl: ce.documentURL || "",
  };
}

// Compose the HAR payload for the session automation tab: CDP Network-domain entries (document/
// static/fetch/XHR) merged with the in-page fetch/XHR capture (which carries response bodies).
// Returns the full HAR object; the host writes it to disk under .pi/chrome-network/.
async function exportNetworkHar(tab, params) {
  const includeBodies = params.includeBodies !== false;
  const now = Date.now();
  const cdpEntries = Array.from((cdpNetworkEntries.get(tab.id) || new Map()).values());
  // Page-level capture is best-effort: it runs in the page world and yields nothing when the
  // page cannot be reached (about:blank, crashed tab, etc.).
  let pageEntries = [];
  try {
    const res = await executeInTab({ targetId: tab.id, foreground: false }, listNetworkRequests, [true, false]);
    pageEntries = Array.isArray(res && res.requests) ? res.requests : [];
  } catch {}
  // Index CDP entries by method+URL so page entries can merge into the richer CDP metadata.
  const cdpByKey = new Map();
  for (const ce of cdpEntries) {
    const key = `${ce.method} ${ce.url}`;
    if (!cdpByKey.has(key)) cdpByKey.set(key, []);
    cdpByKey.get(key).push(ce);
  }
  const usedCdp = new Set();
  const pageHarEntries = [];
  // ONE shared body text budget across page-captured and CDP-fetched bodies keeps the /result
  // payload under the bridge's 8MB result cap no matter how chatty the page was.
  let bodyBudget = NETWORK_HAR_BODY_BUDGET_CHARS;
  for (const pe of pageEntries) {
    const candidates = cdpByKey.get(`${pe.method} ${pe.url}`) || [];
    const match = candidates.find((ce) => !usedCdp.has(ce.requestId) && Math.abs(ce.startedAt - pe.startedAt) < 8000);
    if (match) {
      // Keep the page-captured body (already fetched) and drop the page-only duplicate.
      if (includeBodies && typeof pe.responseBody === "string") {
        if (bodyBudget <= 0) match._bodySkipped = "budget";
        else {
          const entryBudget = bodyBudget;
          bodyBudget -= CDP_NETWORK_MAX_BODY_CHARS;
          match._pageBody = capHarBody(pe.responseBody).slice(0, entryBudget);
        }
      }
      match._pageBodyTruncated = pe.responseBodyTruncated === true;
      match._pageId = pe.id;
      usedCdp.add(match.requestId);
    } else {
      if (includeBodies && typeof pe.responseBody === "string") {
        if (bodyBudget <= 0) pe._bodySkipped = "budget";
        else {
          const entryBudget = bodyBudget;
          bodyBudget -= CDP_NETWORK_MAX_BODY_CHARS;
          pe.responseBody = capHarBody(pe.responseBody).slice(0, entryBudget);
        }
      }
      pageHarEntries.push(pageEntryToHar(pe, now, includeBodies));
    }
  }
  // Only CDP entries that survive the HAR entry cap get a body fetch (text-like types, size-
  // capped, and sharing the same budget as page-captured bodies). Merged entries (page body
  // attached) always make the cut; standalone entries fill the rest.
  const mergedCdp = cdpEntries.filter((ce) => usedCdp.has(ce.requestId));
  const standaloneCdp = cdpEntries.filter((ce) => !usedCdp.has(ce.requestId));
  const cdpBudget = Math.max(0, NETWORK_HAR_MAX_ENTRIES - pageHarEntries.length);
  const includedCdp = standaloneCdp.slice(0, Math.max(0, cdpBudget - mergedCdp.length));
  const harCdp = [...mergedCdp, ...includedCdp];
  if (includeBodies) {
    const bodyPromises = [];
    for (const ce of harCdp) {
      if (bodyBudget <= 0) { ce._bodySkipped = "budget"; continue; }
      if (ce._fetchedBody !== undefined || ce._pageBody !== undefined) continue;
      if (!ce.status || !isHarBodyEligible(ce.mimeType) || ce.bodyError !== undefined) continue;
      const entryBudget = bodyBudget;
      bodyBudget -= CDP_NETWORK_MAX_BODY_CHARS;
      bodyPromises.push(
        fetchCdpResponseBody(tab.id, ce.requestId).then((res) => {
          if (res && typeof res.text === "string") ce._fetchedBody = capHarBody(res.text).slice(0, entryBudget);
          else if (res && res.error) ce.bodyError = res.error;
        }, () => { ce.bodyError = "body fetch rejected"; }),
      );
    }
    await Promise.all(bodyPromises);
  }
  const cdpHarEntries = [];
  for (const ce of harCdp) cdpHarEntries.push(await cdpEntryToHar(tab.id, ce, now, includeBodies));
  const entries = [...pageHarEntries, ...cdpHarEntries].slice(0, NETWORK_HAR_MAX_ENTRIES);
  const har = {
    log: {
      version: "1.2",
      creator: { name: "pi-chrome", version: chrome.runtime.getManifest().version, comment: "pi-chrome CDP Network-domain + in-page fetch/XHR capture" },
      pages: [{ startedDateTime: isoTime(now), id: "page_1", title: tab.title || tab.url || "Chrome tab", pageTimings: {}, _url: tab.url || "" }],
      entries,
    },
  };
  return {
    har,
    count: entries.length,
    pageEntries: pageEntries.length,
    cdpEntries: cdpEntries.length,
    truncated: pageHarEntries.length + cdpHarEntries.length > NETWORK_HAR_MAX_ENTRIES,
    mode: networkModeTabs.has(tab.id),
    note: "HAR payload — the host writes it under .pi/chrome-network/ and returns the path.",
  };
}

// =================== network.initiatorChain (chrome_network_initiator_chain, P0) ===================
// Rebuild the DevTools-style Request-initiator chain for one captured request: the request that
// fetched the script/document that triggered it, walking up to the frame's document request
// (ancestors), with an optional reverse scan for dependents (requests this one triggered). Works
// on the CDP capture store (cdpNetworkEntries), which keeps the full initiator record (M0).
// Pure top-level function so the unit harness can vm-drive it directly (foundation-smoke).

// The URL that links this request to its parent in the initiator chain: initiator.url for
// parser/script/preload, falling back to the first stack frame's script URL (a "script"
// initiator without a url still carries the call stack), then to the most recent redirect hop.
function initiatorLinkUrl(entry, byUrl) {
  const init = entry && entry.initiator ? entry.initiator : null;
  if (init && typeof init.url === "string" && init.url && byUrl.has(init.url)) return init.url;
  if (init && Array.isArray(init.stack)) {
    for (const frame of init.stack) {
      if (frame && typeof frame.url === "string" && frame.url && byUrl.has(frame.url)) return frame.url;
    }
  }
  if (entry && Array.isArray(entry.redirects) && entry.redirects.length) {
    const last = entry.redirects[entry.redirects.length - 1];
    if (last && typeof last.url === "string" && byUrl.has(last.url)) return last.url;
  }
  return null;
}

function chainNodeFor(entry) {
  return {
    requestId: entry.requestId,
    url: entry.url || "",
    method: entry.method || "GET",
    resourceType: entry.resourceType || "",
    status: typeof entry.status === "number" ? entry.status : null,
    initiator: entry.initiator || null,
  };
}

// Walk `entry`'s ancestor chain and report whether it reaches `targetRequestId` (reverse scan).
function reachesInitiatorTarget(stored, byUrl, entry, targetRequestId) {
  let current = entry;
  const visited = new Set([current.requestId]);
  let hops = 0;
  while (current && hops < INITIATOR_CHAIN_MAX_DEPTH) {
    const linkUrl = initiatorLinkUrl(current, byUrl);
    const parent = linkUrl ? byUrl.get(linkUrl) : null;
    if (!parent || visited.has(parent.requestId)) break;
    if (parent.requestId === targetRequestId) return true;
    visited.add(parent.requestId);
    current = parent;
    hops++;
  }
  return false;
}

function collectInitiatorDependents(stored, byUrl, targetRequestId) {
  const dependents = [];
  for (const [rid, entry] of stored) {
    if (rid === targetRequestId) continue;
    if (reachesInitiatorTarget(stored, byUrl, entry, targetRequestId)) dependents.push(rid);
    if (dependents.length >= INITIATOR_CHAIN_MAX_DEPENDENTS) break;
  }
  return { list: dependents, count: dependents.length, truncated: dependents.length >= INITIATOR_CHAIN_MAX_DEPENDENTS };
}

// Pick the target entry by requestId (exact) or requestUrlIncludes (substring; latest match wins
// and ambiguity is reported). Throws with a helpful message when nothing matches.
function pickInitiatorTarget(stored, params) {
  if (typeof params.requestId === "string" && params.requestId) {
    const entry = stored.get(params.requestId);
    if (!entry) {
      throw new Error(`No CDP network entry with requestId ${params.requestId} (entries older than the ${CDP_NETWORK_MAX_ENTRIES_PER_TAB}-entry cap may have been evicted)`);
    }
    return { requestId: params.requestId, entry };
  }
  const needle = typeof params.requestUrlIncludes === "string" && params.requestUrlIncludes ? params.requestUrlIncludes : "";
  if (!needle) {
    throw new Error("chrome_network_initiator_chain requires requestId or requestUrlIncludes");
  }
  const matches = Array.from(stored.values()).filter((e) => String(e.url || "").includes(needle));
  if (!matches.length) throw new Error(`No captured CDP network request whose URL includes "${needle}"`);
  const sorted = matches.slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const latest = sorted[0];
  return {
    requestId: latest.requestId,
    entry: latest,
    ambiguous: sorted.length > 1 ? { matched: sorted.length, candidates: sorted.slice(0, 5).map((e) => e.requestId) } : undefined,
  };
}

// Build the initiator chain response for a capture store (Map<requestId, entry>) + params.
function buildInitiatorChain(stored, params) {
  const byUrl = new Map();
  for (const entry of stored.values()) {
    if (entry && !byUrl.has(entry.url)) byUrl.set(entry.url, entry);
  }
  const target = pickInitiatorTarget(stored, params);
  const ancestors = [];
  const visited = new Set([target.requestId]);
  let current = target.entry;
  let hops = 0;
  while (current && hops < INITIATOR_CHAIN_MAX_DEPTH) {
    const linkUrl = initiatorLinkUrl(current, byUrl);
    const parent = linkUrl ? byUrl.get(linkUrl) : null;
    if (!parent || visited.has(parent.requestId)) break;
    visited.add(parent.requestId);
    ancestors.push(parent);
    current = parent;
    hops++;
  }
  ancestors.reverse(); // root-first: document/loader before the request that triggered ours
  const dependents = params.includeDependents
    ? collectInitiatorDependents(stored, byUrl, target.requestId)
    : null;
  return {
    requestId: target.requestId,
    url: target.entry.url || "",
    method: target.entry.method || "GET",
    resourceType: target.entry.resourceType || "",
    status: typeof target.entry.status === "number" ? target.entry.status : null,
    initiator: target.entry.initiator || null,
    chain: ancestors.map(chainNodeFor),
    ...(target.ambiguous ? { ambiguous: target.ambiguous } : {}),
    ...(dependents ? { dependents: dependents.list.map((rid) => chainNodeFor(stored.get(rid))), dependentCount: dependents.count, dependentsTruncated: dependents.truncated } : {}),
    chainDepthCapped: hops >= INITIATOR_CHAIN_MAX_DEPTH,
  };
}

// ==========================================================================
// P0 tool handlers (TOOL_CONTRACTS §5). One top-level handler per P0 wire kind;
// the dispatch switch routes to them. Handlers that touch the DOM/renderer wrap
// themselves in the paused-page rail (ensurePageUsable) and release remote
// objectId references in finally (risk #6 remote-object leaks).
// ==========================================================================

// css.computedStyle — chrome_computed_style: computed-style map for a uid/selector.
async function chromeComputedStyle(params) {
  const tab = await getTabByParams(params);
  await attachDebugger(tab.id);
  // resolveCdpNode scrolls the element into view via Runtime.evaluate, which a paused page
  // freezes — rail first (constraint #3).
  const pauseNote = await ensurePageUsable(tab.id, "computed style");
  const resolved = await resolveCdpNode(tab.id, params);
  try {
    await enableCdpDomain(tab.id, "CSS");
    const res = await cdp(tab.id, "CSS.getComputedStyleForNode", { nodeId: resolved.nodeId });
    const styles = Array.isArray(res?.computedStyle) ? res.computedStyle : [];
    const requested = Array.isArray(params.properties) ? new Set(params.properties.map((p) => String(p))) : null;
    const MAX_COMPUTED_PROPS = 4000;
    const computedStyle = {};
    let truncated = false;
    for (const s of styles) {
      if (!s || typeof s.name !== "string") continue;
      if (requested && !requested.has(s.name)) continue;
      computedStyle[s.name] = typeof s.value === "string" ? s.value : "";
      if (Object.keys(computedStyle).length >= MAX_COMPUTED_PROPS) { truncated = true; break; }
    }
    let tag = null;
    try {
      const described = await cdp(tab.id, "DOM.describeNode", { nodeId: resolved.nodeId, depth: 0 });
      tag = described?.node?.nodeName ?? null;
    } catch {}
    const result = { node: { uid: params.uid ?? null, selector: params.selector ?? null, tag }, computedStyle, truncated };
    if (pauseNote) result.pausedAutoResumed = pauseNote;
    return result;
  } finally {
    await cdp(tab.id, "Runtime.releaseObject", { objectId: resolved.objectId }).catch(() => undefined);
  }
}

// css.boxModel — chrome_box_model: content/padding/border/margin quads via DOM.getBoxModel.
async function chromeBoxModel(params) {
  const tab = await getTabByParams(params);
  await attachDebugger(tab.id);
  const pauseNote = await ensurePageUsable(tab.id, "box model");
  const resolved = await resolveCdpNode(tab.id, params);
  try {
    const res = await cdp(tab.id, "DOM.getBoxModel", { nodeId: resolved.nodeId });
    if (!res?.model) throw new Error("DOM.getBoxModel returned no model — the element may not be rendered (display:none / detached)");
    const m = res.model;
    const result = {
      node: { uid: params.uid ?? null, selector: params.selector ?? null },
      boxModel: {
        content: m.content, padding: m.padding, border: m.border, margin: m.margin,
        width: m.width, height: m.height,
      },
    };
    if (pauseNote) result.pausedAutoResumed = pauseNote;
    return result;
  } finally {
    await cdp(tab.id, "Runtime.releaseObject", { objectId: resolved.objectId }).catch(() => undefined);
  }
}

// dom.point — chrome_dom_at_point: renderer hit-test at pure coordinates (no snapshot uid).
async function chromeDomAtPoint(params) {
  const x = Number(params.x);
  const y = Number(params.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("chrome_dom_at_point requires numeric x and y");
  const tab = await getTabByParams(params);
  await attachDebugger(tab.id);
  const pauseNote = await ensurePageUsable(tab.id, "dom at point");
  await enableCdpDomain(tab.id, "DOM");
  const located = await cdp(tab.id, "DOM.getNodeForLocation", { x, y, includeUserAgentShadowDOM: true });
  if (!located || typeof located.nodeId !== "number") {
    throw new Error(`No node found at (${x}, ${y}) — the point may be outside the viewport or over a browser-chrome region`);
  }
  const described = await cdp(tab.id, "DOM.describeNode", { nodeId: located.nodeId, depth: params.includeDepth === true ? 1 : 0 });
  const node = described?.node || {};
  const result = {
    x, y,
    node: {
      nodeId: node.nodeId, backendNodeId: node.backendNodeId, nodeName: node.nodeName,
      localName: node.localName, attributes: Array.isArray(node.attributes) ? node.attributes : undefined,
      frameId: node.frameId,
    },
  };
  if (params.outerHTML === true) {
    try {
      const obj = await cdp(tab.id, "DOM.resolveNode", { nodeId: located.nodeId, objectGroup: NODE_RESOLVE_OBJECT_GROUP });
      if (obj?.object?.objectId) {
        const html = await cdp(tab.id, "Runtime.callFunctionOn", {
          objectId: obj.object.objectId,
          functionDeclaration: "function() { return this.outerHTML || ''; }",
          returnByValue: true,
        });
        if (typeof html?.result?.value === "string") result.outerHTML = html.result.value.slice(0, 200_000);
        await cdp(tab.id, "Runtime.releaseObject", { objectId: obj.object.objectId }).catch(() => undefined);
      }
    } catch {
      // outerHTML enrichment is best-effort; the hit-test result stands alone.
    }
  }
  if (pauseNote) result.pausedAutoResumed = pauseNote;
  return result;
}

// page.outerHTML — chrome_node_html: outerHTML + attribute list via in-page cdpEval (zero new
// CDP domain; CSP-safe). Sub-frame uids route through cdpEvalInFrame (OOPIF-aware).
async function chromeNodeHtml(params) {
  const tab = await getTabByParams(params);
  const pauseNote = await ensurePageUsable(tab.id, "node outerHTML");
  const frameUid = params.uid ? parseFrameUid(params.uid) : null;
  const frameId = frameUid ? frameUid.frameId : 0;
  const localUid = frameUid ? frameUid.localUid : (params.uid ?? null);
  const expression = `(() => {
    const selector = ${JSON.stringify(params.selector ?? null)};
    const uid = ${JSON.stringify(localUid ?? null)};
    const state = window.__PI_CHROME_STATE__;
    const el = uid && state && state.elements ? state.elements[uid] : (selector ? document.querySelector(selector) : null);
    if (!el) return { missing: true };
    if (!el.isConnected) return { stale: true };
    const attrs = [];
    const attrsList = el.attributes ? Array.from(el.attributes) : [];
    for (const a of attrsList) attrs.push([a.name, a.value]);
    let outer = typeof el.outerHTML === "string" ? el.outerHTML : String(el);
    const truncated = outer.length > 200000;
    if (truncated) outer = outer.slice(0, 200000);
    return { outerHTML: outer, attrs, tag: el.tagName || "", truncated };
  })()`;
  const res = frameId > 0 ? await cdpEvalInFrame(tab, frameId, expression, {}) : await cdpEval(tab.id, expression);
  if (res.exceptionDetails) {
    throw new Error(`chrome_node_html failed: ${cdpExceptionText(res.exceptionDetails) || "evaluation failed"}`);
  }
  const v = res?.result?.value;
  if (v?.stale) {
    throw new Error(`Snapshot uid ${params.uid} refers to an element that is no longer connected to the document — take a fresh chrome_snapshot and retry.`);
  }
  if (v?.missing || !v) {
    const reason = params.uid ? `snapshot uid ${params.uid}` : `selector ${params.selector}`;
    throw new Error(`No element found in the live document for ${reason} — take a fresh chrome_snapshot or check the selector.`);
  }
  const result = { node: { tag: v.tag, attrs: v.attrs || [] }, outerHTML: v.outerHTML, truncated: v.truncated === true };
  if (pauseNote) result.pausedAutoResumed = pauseNote;
  return result;
}

// page.properties — chrome_get_properties: DevTools-style Runtime.getProperties expansion.
// getters are NOT invoked (descriptors only); objectId is released in finally.
async function chromeGetProperties(params) {
  const tab = await getTabByParams(params);
  await attachDebugger(tab.id);
  const pauseNote = await ensurePageUsable(tab.id, "get properties");
  const depth = Math.max(1, Math.min(3, Number(params.depth) || 1));
  let objectId = null;
  let target = null;
  if (params.expression) {
    const evaluated = await cdp(tab.id, "Runtime.evaluate", {
      expression: String(params.expression),
      objectGroup: NODE_RESOLVE_OBJECT_GROUP,
      returnByValue: false,
      awaitPromise: true,
      userGesture: false,
    });
    if (evaluated.exceptionDetails) {
      throw new Error(`chrome_get_properties: ${cdpExceptionText(evaluated.exceptionDetails) || "evaluation failed"}`);
    }
    if (!evaluated.result?.objectId) throw new Error("chrome_get_properties: the expression did not evaluate to an object");
    objectId = evaluated.result.objectId;
    target = String(params.expression);
  } else {
    if (!params.uid && !params.selector) {
      throw new Error("chrome_get_properties requires uid/selector or an expression");
    }
    const resolved = await resolveCdpNode(tab.id, params);
    objectId = resolved.objectId;
    target = params.uid ?? params.selector ?? null;
  }
  try {
    const res = await cdp(tab.id, "Runtime.getProperties", {
      objectId,
      ownProperties: params.ownProperties === true,
      accessorPropertiesOnly: params.accessorPropertiesOnly === true,
      generatePreview: true,
    });
    const rawProps = Array.isArray(res?.result) ? res.result : [];
    const CAP_PROPERTIES = 200;
    const properties = rawProps.slice(0, CAP_PROPERTIES).map((p) => {
      const out = {
        name: p.name,
        value: cdpRemoteValue(p.value),
        enumerable: p.enumerable === true,
        configurable: p.configurable === true,
        writable: p.writable === true,
        isOwn: p.isOwn === true,
      };
      if (p.get) out.get = cdpRemoteValue(p.get);
      if (p.set) out.set = cdpRemoteValue(p.set);
      return out;
    });
    const internalProperties = Array.isArray(res?.internalProperties) ? res.internalProperties.slice(0, 40).map((p) => ({
      name: p.name, value: cdpRemoteValue(p.value),
    })) : [];
    const result = {
      target,
      properties,
      internalProperties,
      truncated: rawProps.length > CAP_PROPERTIES,
    };
    if (pauseNote) result.pausedAutoResumed = pauseNote;
    return result;
  } finally {
    await cdp(tab.id, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}

// page.watch — chrome_watch_expression: poll an expression at an interval, bounded by duration
// and maxSamples. The loop is fully awaited (no dangling interval survives a cancel).
async function chromeWatchExpression(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  const expression = String(params.expression ?? "");
  if (!expression) throw new Error("chrome_watch_expression requires an expression");
  const durationMs = Math.max(200, Math.min(120_000, Number(params.durationMs) || 5000));
  const intervalMs = Math.max(50, Math.min(durationMs, Number(params.intervalMs) || 500));
  const maxSamples = Math.max(1, Math.min(1000, Number(params.maxSamples) || 100));
  const started = Date.now();
  const samples = [];
  let stopped = "duration";
  while (samples.length < maxSamples && Date.now() - started < durationMs) {
    try {
      // evaluateInResolvedTab carries the paused-page rail internally.
      const value = await evaluateInResolvedTab(tab, { ...params, expression, foreground: false });
      samples.push({ t: Date.now() - started, value: value === undefined ? { kind: "undefined" } : value });
    } catch (error) {
      const message = String(error?.message || error);
      if (samples.length === 0) {
        throw new Error(`chrome_watch_expression: ${message}`);
      }
      samples.push({ t: Date.now() - started, error: message });
    }
    if (samples.length >= maxSamples) { stopped = "maxSamples"; break; }
    await sleep(intervalMs);
  }
  return { expression, samples, elapsedMs: Date.now() - started, stopped };
}

// network.summary — chrome_network_summary: aggregate the CDP capture store (pure; vm-testable).
function buildNetworkSummary(stored) {
  const entries = stored ? Array.from(stored.values()) : [];
  const failed = entries.filter((e) => e.errorText || e.failedAt);
  const cacheHit = entries.filter((e) => e.fromCache);
  const byDuration = entries.filter((e) => typeof e.durationMs === "number").sort((a, b) => b.durationMs - a.durationMs);
  const slowest = byDuration.slice(0, 5).map((e) => ({
    requestId: e.requestId, method: e.method, url: e.url,
    status: typeof e.status === "number" ? e.status : null,
    durationMs: e.durationMs, resourceType: e.resourceType || "",
  }));
  const statusDistribution = {};
  const bytesByType = {};
  const byResourceType = {};
  for (const e of entries) {
    const status = typeof e.status === "number" ? e.status : (e.errorText ? "failed" : "unknown");
    statusDistribution[status] = (statusDistribution[status] || 0) + 1;
    const mime = e.mimeType || "unknown";
    bytesByType[mime] = (bytesByType[mime] || 0) + (e.encodedDataLength || 0);
    const rt = e.resourceType || "other";
    byResourceType[rt] = (byResourceType[rt] || 0) + 1;
  }
  return {
    counts: { total: entries.length, failed: failed.length, cacheHit: cacheHit.length },
    slowest,
    statusDistribution,
    bytesByType,
    byResourceType,
  };
}

// network.cache — chrome_network_cache: toggle Network.setCacheDisabled on the capture attach.
async function chromeNetworkCache(params) {
  const tab = await getTabByParams(params);
  await ensureNetworkCapture(tab.id);
  const enabled = params.enabled !== false;
  const cacheDisabled = !enabled;
  cacheDisabledPerTab.set(tab.id, cacheDisabled);
  await cdp(tab.id, "Network.setCacheDisabled", { cacheDisabled });
  return { enabled, cacheDisabled };
}

// Map a throttle profile to the Network.emulateNetworkConditions payload. -1 throughput = unlimited.
function networkConditionsFor(record) {
  return {
    offline: record.offline === true,
    latency: Number(record.latencyMs) || 0,
    downloadThroughput: (Number(record.downloadThroughput) || 0) > 0 ? Number(record.downloadThroughput) : -1,
    uploadThroughput: (Number(record.uploadThroughput) || 0) > 0 ? Number(record.uploadThroughput) : -1,
    connectionType: record.offline === true ? "none" : "wifi",
  };
}

// network.throttle — chrome_network_throttle: offline/latency/throughput emulation. While a
// non-default profile is active the MODE_THROTTLE keepalive holds the attach (and re-applies on
// re-attach); an all-default profile resets the tab to unlimited and clears the mode.
async function chromeNetworkThrottle(params) {
  const tab = await getTabByParams(params);
  await attachDebugger(tab.id);
  await enableNetworkDomain(tab.id);
  const record = {
    offline: params.offline === true,
    latencyMs: Math.max(0, Number(params.latencyMs) || 0),
    downloadThroughput: Math.max(0, Number(params.downloadThroughput) || 0),
    uploadThroughput: Math.max(0, Number(params.uploadThroughput) || 0),
  };
  const active = record.offline || record.latencyMs > 0 || record.downloadThroughput > 0 || record.uploadThroughput > 0;
  if (active) {
    throttlePerTab.set(tab.id, record);
    registerMode(tab.id, MODE_THROTTLE);
  } else {
    throttlePerTab.delete(tab.id);
    unregisterMode(tab.id, MODE_THROTTLE);
  }
  await cdp(tab.id, "Network.emulateNetworkConditions", networkConditionsFor(record));
  return { ...record, enabled: active };
}

// page.collectGarbage — chrome_collect_garbage: HeapProfiler.collectGarbage baseline.
async function chromeCollectGarbage(params) {
  const tab = await getTabByParams(params);
  const pauseNote = await ensurePageUsable(tab.id, "collect garbage");
  await attachDebugger(tab.id);
  await enableCdpDomain(tab.id, "HeapProfiler");
  await cdp(tab.id, "HeapProfiler.collectGarbage", {});
  const result = { collected: true };
  if (pauseNote) result.pausedAutoResumed = pauseNote;
  return result;
}

// page.memoryCounters — chrome_memory_counters: DOM counters + heap usage + leak-prep hook.
// Memory.getDOMCounters is absent on very old Chromes — degrade to Performance-only heap data.
async function chromeMemoryCounters(params) {
  const tab = await getTabByParams(params);
  const pauseNote = await ensurePageUsable(tab.id, "memory counters");
  await attachDebugger(tab.id);
  let domCounters = null;
  try {
    const res = await cdp(tab.id, "Memory.getDOMCounters", {});
    domCounters = { nodes: res?.nodes ?? null, jsEventListeners: res?.jsEventListeners ?? null, documents: res?.documents ?? null };
  } catch {
    domCounters = null; // very old Chrome: Memory domain may not expose counters
  }
  let heap = null;
  try {
    const res = await cdp(tab.id, "Runtime.getHeapUsage", {});
    heap = { usedSize: res?.usedSize ?? null, totalSize: res?.totalSize ?? null };
  } catch {}
  let prepared = false;
  if (params.prepareForLeakDetection === true) {
    try { await cdp(tab.id, "Memory.prepareForLeakDetection", {}); prepared = true; } catch {}
  }
  const result = { domCounters, heap, prepared };
  if (pauseNote) result.pausedAutoResumed = pauseNote;
  return result;
}

// page.eventListeners — chrome_event_listeners: DOMDebugger.getEventListeners inventory.
async function chromeEventListeners(params) {
  const tab = await getTabByParams(params);
  await attachDebugger(tab.id);
  const pauseNote = await ensurePageUsable(tab.id, "event listeners");
  const resolved = await resolveCdpNode(tab.id, params);
  try {
    // getEventListeners requires the Debugger domain; DOMDebugger.enable is a no-op + idempotent.
    await enableCdpDomain(tab.id, "Debugger");
    await enableCdpDomain(tab.id, "DOMDebugger");
    const depth = Math.max(0, Math.min(3, Number(params.depth) || 1));
    const res = await cdp(tab.id, "DOMDebugger.getEventListeners", { objectId: resolved.objectId, depth, pierce: true });
    const rawListeners = Array.isArray(res?.listeners) ? res.listeners : [];
    const CAP_LISTENERS = 200;
    const listeners = rawListeners.slice(0, CAP_LISTENERS).map((l) => ({
      type: String(l?.type ?? ""),
      useCapture: l?.useCapture === true,
      passive: l?.passive === true,
      once: l?.once === true,
      handler: {
        functionName: String(l?.handler?.functionName ?? ""),
        location: l?.handler?.location ?? null,
        scriptId: l?.handler?.scriptId ?? null,
      },
    }));
    const result = {
      node: { uid: params.uid ?? null, selector: params.selector ?? null },
      listeners,
      truncated: rawListeners.length > CAP_LISTENERS,
    };
    if (pauseNote) result.pausedAutoResumed = pauseNote;
    return result;
  } finally {
    await cdp(tab.id, "Runtime.releaseObject", { objectId: resolved.objectId }).catch(() => undefined);
  }
}

// page.drop — chrome_drop: real HTML5 drag-and-drop via Input.dispatchDragEvent with a
// DataTransfer payload (files resolve to absolute paths). The press/move prelude makes the drop
// believable to sites that gate on mousedown/mousemove before accepting the dragover/drop.
async function chromeDrop(params) {
  const tab = await getTabByParams(params);
  // resolveTargetInTab carries the paused-page rail internally for both endpoints.
  const from = await resolveTargetInTab(tab.id, {
    selector: params.fromSelector ?? null, uid: params.fromUid ?? null,
    x: params.fromX ?? null, y: params.fromY ?? null,
  });
  const to = await resolveTargetInTab(tab.id, {
    selector: params.toSelector ?? null, uid: params.toUid ?? null,
    x: params.toX ?? null, y: params.toY ?? null,
  });
  await attachDebugger(tab.id);
  const rawItems = Array.isArray(params.dataTransfer?.items) ? params.dataTransfer.items : [];
  const items = rawItems.map((it) => ({
    mimeType: it?.type || "text/plain",
    data: String(it?.data ?? ""),
  }));
  const data = { items, dragOperationsMask: 1 };
  const files = rawItems
    .filter((it) => it?.kind === "file" && (it?.files?.[0] || it?.data))
    .map((it) => String(it?.files?.[0] ?? it?.data));
  if (files.length) data.files = files;
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  const steps = Math.max(0, Math.min(20, Number(params.steps) || 0));
  if (steps > 0) {
    await cdp(tab.id, "Input.dispatchDragEvent", { type: "dragEnter", x: to.x, y: to.y, data, dragOperationsMask: 1 });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await cdp(tab.id, "Input.dispatchDragEvent", {
        type: "dragOver",
        x: Math.round(from.x + (to.x - from.x) * t),
        y: Math.round(from.y + (to.y - from.y) * t),
        data, dragOperationsMask: 1,
      });
    }
  } else {
    await cdp(tab.id, "Input.dispatchDragEvent", { type: "dragEnter", x: to.x, y: to.y, data, dragOperationsMask: 1 });
    await cdp(tab.id, "Input.dispatchDragEvent", { type: "dragOver", x: to.x, y: to.y, data, dragOperationsMask: 1 });
  }
  await cdp(tab.id, "Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data, dragOperationsMask: 1 });
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  return {
    input: "chrome",
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    drop: true,
    dataTransferItems: rawItems.length,
    ...(from.pausedAutoResumed ? { pausedAutoResumed: from.pausedAutoResumed } : {}),
  };
}

// page.scrollTo — chrome_scroll_to: deterministic scrollIntoView + post-scroll rect/visibility.
async function chromeScrollTo(params) {
  const tab = await getTabByParams(params);
  const pauseNote = await ensurePageUsable(tab.id, "scroll to");
  const frameUid = params.uid ? parseFrameUid(params.uid) : null;
  const frameId = frameUid ? frameUid.frameId : 0;
  const localUid = frameUid ? frameUid.localUid : (params.uid ?? null);
  const block = ["start", "center", "end", "nearest"].includes(params.block) ? params.block : "center";
  const inline = ["start", "center", "end", "nearest"].includes(params.inline) ? params.inline : "nearest";
  const expression = `(() => {
    const selector = ${JSON.stringify(params.selector ?? null)};
    const uid = ${JSON.stringify(localUid ?? null)};
    const state = window.__PI_CHROME_STATE__;
    const el = uid && state && state.elements ? state.elements[uid] : (selector ? document.querySelector(selector) : null);
    if (!el) return { missing: true };
    if (!el.isConnected) return { stale: true };
    try { el.scrollIntoView({ block: ${JSON.stringify(block)}, inline: ${JSON.stringify(inline)}, behavior: "instant" }); } catch (e) { return { error: String(e && e.message || e) }; }
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = !(style.visibility === "hidden" || style.display === "none") && r.width > 0 && r.height > 0 &&
      !(r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth);
    return { rect: { left: r.left, top: r.top, width: r.width, height: r.height }, visible, viewport: { scrollX: window.scrollX, scrollY: window.scrollY } };
  })()`;
  const res = frameId > 0 ? await cdpEvalInFrame(tab, frameId, expression, {}) : await cdpEval(tab.id, expression);
  if (res.exceptionDetails) {
    throw new Error(`chrome_scroll_to failed: ${cdpExceptionText(res.exceptionDetails) || "evaluation failed"}`);
  }
  const v = res?.result?.value;
  if (v?.error) throw new Error(`chrome_scroll_to: ${v.error}`);
  if (v?.stale) {
    throw new Error(`Snapshot uid ${params.uid} refers to an element that is no longer connected to the document — take a fresh chrome_snapshot and retry.`);
  }
  if (v?.missing || !v) {
    const reason = params.uid ? `snapshot uid ${params.uid}` : `selector ${params.selector}`;
    throw new Error(`No element found in the live document for ${reason} — take a fresh chrome_snapshot or check the selector.`);
  }
  const result = { scrolled: true, rect: v.rect, visible: v.visible === true, viewport: v.viewport };
  if (pauseNote) result.pausedAutoResumed = pauseNote;
  return result;
}

// browser.info — chrome_browser_info: Browser.getVersion (+ best-effort getBrowserCommandLine
// which only works from a browser-level target — page-target attaches degrade to UA-only).
async function chromeBrowserInfo(params) {
  let version = null;
  let commandLine = null;
  let degraded = false;
  let tabId = null;
  try {
    const tab = await getTabByParams(params);
    tabId = tab.id;
    await attachDebugger(tab.id);
    version = await cdp(tab.id, "Browser.getVersion", {});
  } catch {
    degraded = true;
  }
  if (version && tabId !== null) {
    try {
      const cl = await cdp(tabId, "Browser.getBrowserCommandLine", {});
      commandLine = Array.isArray(cl?.arguments) ? cl.arguments : [];
    } catch {
      degraded = true;
      commandLine = null;
    }
  }
  return {
    browser: version
      ? {
          protocolVersion: version.protocolVersion ?? null,
          product: version.product ?? null,
          revision: version.revision ?? null,
          userAgent: version.userAgent ?? null,
          jsVersion: version.jsVersion ?? null,
        }
      : null,
    commandLine,
    degraded,
  };
}

// target.list — chrome_targets: full CDP target inventory. Never attaches (wrapper over the
// existing getTargets promise); worker targets surface here for chrome_target_evaluate (P1).
async function chromeTargets(params) {
  const filter = String(params.filter || "all");
  const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))).catch(() => []);
  const filtered = targets
    .filter((t) => filter === "all" || t.type === filter)
    .slice(0, 500)
    .map((t) => ({
      id: t.id, type: t.type, title: t.title ?? "", url: t.url ?? "",
      attached: t.attached === true, tabId: t.tabId ?? null, extensionId: t.extensionId ?? null,
    }));
  return { targets: filtered, count: filtered.length };
}

async function dispatch(action, params) {
  switch (action) {
    case "tab.version":
      return {
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
        bridgeUrl: BRIDGE_URL,
        userAgent: navigator.userAgent,
      };
    case "tab.save": {
      // Bind a name to a tab for this session (named handle). Re-binding the same name in the
      // same session overwrites the handle; a different session may not take the name over.
      if (!params.name) throw new Error("chrome_tab save requires a name");
      await hydrateTabRegistry();
      const sessionKey = sessionKeyOf(params);
      const existing = tabRegistry.get(params.name);
      if (existing && existing.ownerSessionKey !== sessionKey) {
        throw new Error(`handle ${params.name} already owned by another session`);
      }
      const tab = await getTabByParams(params);
      const entry = {
        name: params.name,
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url || "",
        title: tab.title || "",
        ownerSessionKey: sessionKey,
        savedAt: Date.now(),
      };
      tabRegistry.set(params.name, entry);
      await persistTabRegistry();
      return { ok: true, handle: { ...entry } };
    }
    case "tab.list": {
      // QoL discoverability: return BOTH the user's open tabs and the named-handle registry.
      // tabs[] enumerates every open tab (including pi-chrome automation tabs) with group info
      // so an agent asked to "see my tab" can target a real page; handles[] keeps the existing
      // per-session named registry (owner filtering unchanged). When a sessionKey is given, only
      // that session's handles are returned; with none, all handles across sessions are listed.
      await hydrateTabRegistry();
      const owner = params && typeof params.sessionKey === "string" && params.sessionKey ? params.sessionKey : null;
      const handles = [];
      for (const entry of tabRegistry.values()) {
        if (owner === null || entry.ownerSessionKey === owner) handles.push({ ...entry });
      }
      // Dedupe group lookups per groupId: many tabs share a handful of groups, and each
      // groupRecord call is a chrome.tabGroups.get round-trip.
      const groupCache = new Map();
      const openTabs = await chrome.tabs.query({}).catch(() => []);
      const tabs = [];
      for (const candidate of openTabs || []) {
        if (!candidate || typeof candidate.id !== "number") continue;
        const groupId = typeof candidate.groupId === "number" ? candidate.groupId : -1;
        let group = null;
        if (groupId >= 0) {
          if (!groupCache.has(groupId)) groupCache.set(groupId, await groupRecord(groupId).catch(() => null));
          group = groupCache.get(groupId) ?? null;
        }
        tabs.push({
          id: candidate.id,
          windowId: candidate.windowId,
          active: Boolean(candidate.active),
          title: candidate.title || "",
          url: candidate.url || "",
          groupId,
          group,
        });
      }
      return { tabs, handles };
    }
    case "tab.active": {
      // Resolve the user's currently FOCUSED active tab (the tab the human is actually looking
      // at), never pi-chrome's automation tab. Read-only: never creates an automation target.
      if (!chrome.windows || typeof chrome.windows.getLastFocused !== "function") {
        throw new Error("chrome.windows.getLastFocused is unavailable; cannot resolve the active tab");
      }
      const focused = await chrome.windows.getLastFocused();
      if (!focused || typeof focused.id !== "number") {
        throw new Error("No focused Chrome window found");
      }
      const activeTabs = await chrome.tabs.query({ windowId: focused.id, active: true });
      const tab = Array.isArray(activeTabs) ? activeTabs[0] : undefined;
      if (!tab || typeof tab.id !== "number") {
        throw new Error(`No active tab found in the focused window (windowId=${focused.id})`);
      }
      return { ...(await formatTab(tab)), windowId: focused.id };
    }
    case "tab.new": {
      // Every Pi-opened tab must join a tab group. There is intentionally no opt-out: an ungrouped
      // Pi-created tab is easy to lose among user tabs. If grouping fails after creation, close the
      // tab best-effort before surfacing the error so tab.new never leaves an ungrouped Pi tab.
      const groupTitle = params.groupTitle || "Pi";
      const existingGroup = await findGroupRecordByTitle(groupTitle);
      const createParams = { url: params.url || "about:blank", active: true };
      if (existingGroup && typeof existingGroup.windowId === "number") createParams.windowId = existingGroup.windowId;
      const tab = await chrome.tabs.create(createParams);
      try {
        return await groupTab(tab, groupTitle, params.groupColor);
      } catch (error) {
        if (typeof tab.id === "number") await chrome.tabs.remove(tab.id).catch(() => {});
        throw error;
      }
    }
    case "tab.activate": {
      // Management actions never auto-create an automation target (createOwnedTarget:false): with
      // no explicit target they act on an owned target if one exists, else error — they must never
      // fall back to (or spawn a tab just to touch) the user's active tab.
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      await chrome.windows.update(tab.windowId, { focused: true });
      return formatTab(await chrome.tabs.update(tab.id, { active: true }));
    }
    case "tab.group": {
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      return groupTab(tab, params.groupTitle || "Pi", params.groupColor);
    }
    case "tab.ungroup": {
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      if (typeof tab.groupId === "number" && tab.groupId >= 0) await chrome.tabs.ungroup(tab.id);
      return formatTab(await chrome.tabs.get(tab.id));
    }
    case "tab.close": {
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      await chrome.tabs.remove(tab.id);
      return { closed: tab.id };
    }
    case "page.snapshot":
      return snapshotInTab(params);
    case "page.inspect":
      return inspectInTab(params);
    case "page.evaluate":
      return evaluateInTab(params);
    case "page.click":
      return withOptionalSnapshot(params, chromeInputClick);
    case "page.hover":
      return chromeInputHover(params);
    case "page.drag":
      return chromeInputDrag(params);
    case "page.upload":
      return chromeInputUpload(params);
    case "page.type":
      return withOptionalSnapshot(params, chromeInputType);
    case "page.fill":
      return withOptionalSnapshot(params, chromeInputFill);
    case "page.fillForm":
      return chromeFillForm(params);
    case "page.dialog":
      return handleDialogCommand(params);
    case "page.emulate":
      return chromeEmulate(params);
    case "css.computedStyle":
      return chromeComputedStyle(params);
    case "css.boxModel":
      return chromeBoxModel(params);
    case "dom.point":
      return chromeDomAtPoint(params);
    case "page.outerHTML":
      return chromeNodeHtml(params);
    case "page.properties":
      return chromeGetProperties(params);
    case "page.watch":
      return chromeWatchExpression(params);
    case "page.eventListeners":
      return chromeEventListeners(params);
    case "page.drop":
      return chromeDrop(params);
    case "page.scrollTo":
      return chromeScrollTo(params);
    case "page.collectGarbage":
      return chromeCollectGarbage(params);
    case "page.memoryCounters":
      return chromeMemoryCounters(params);
    case "browser.info":
      return chromeBrowserInfo(params);
    case "target.list":
      return chromeTargets(params);
    case "page.perfMetrics":
      return chromePerfMetrics(params);
    case "storage.op":
      return chromeStorage(params);
    case "downloads.list":
      return listDownloads(params);
    case "downloads.wait":
      return waitForDownload(params);
    case "downloads.clear":
      return clearDownloads(params);
    case "page.key":
      return withOptionalSnapshot(params, chromeInputKey);
    case "page.scroll":
      return chromeInputScroll(params);
    case "page.tap":
      return chromeInputTap(params);
    case "input.status":
      return inputStatus();
    case "input.debug":
      return inputDebug(params);
    case "page.console.list":
      return executeInTab(params, listConsoleMessages, [params.clear === true]);
    case "network.mode": {
      // Opt-in persistent CDP Network capture on the session automation tab (feat-cdp-network).
      // Off by default so the idle-detach model stays intact; on, the attach is held open and the
      // Network domain captures document/static/fetch/XHR traffic that in-page hooks cannot see.
      const enabled = params.enabled !== false;
      // Disabling must not spawn an automation window just to turn the mode off.
      const tab = enabled
        ? await getTabByParams(params)
        : await getTabByParams(params, { createOwnedTarget: false }).catch(() => null);
      if (tab) {
        if (enabled) {
          await ensureNetworkCapture(tab.id);
        } else {
          await disableNetworkCapture(tab.id);
        }
        if (params.clear === true) cdpNetworkEntries.set(tab.id, new Map());
      }
      const stored = tab ? cdpNetworkEntries.get(tab.id) : undefined;
      return {
        enabled: tab ? networkModeTabs.has(tab.id) : false,
        tabId: tab ? tab.id : null,
        capturedCdpEntries: stored ? stored.size : 0,
        blockedUrls: tab ? (blockedUrlsPerTab.get(tab.id) || []) : [],
      };
    }
    case "network.block": {
      // Block matching requests via Network.setBlockedURLs (wildcards supported). Requires the
      // network capture attach, which is created on demand if the mode is not already on.
      const tab = await getTabByParams(params);
      await ensureNetworkCapture(tab.id);
      const patterns = Array.isArray(params.urlPatterns) ? params.urlPatterns.map((p) => String(p)) : [];
      blockedUrlsPerTab.set(tab.id, patterns);
      try {
        await cdp(tab.id, "Network.setBlockedURLs", { urls: patterns });
      } catch (error) {
        // A stale session can auto-re-attach without the Network domain re-enabled; re-enable once.
        await enableNetworkDomain(tab.id);
        await cdp(tab.id, "Network.setBlockedURLs", { urls: patterns });
      }
      return { tabId: tab.id, urlPatterns: patterns, blocked: patterns.length > 0 };
    }
    case "network.list": {
      const tab = await getTabByParams(params);
      const stored = cdpNetworkEntries.get(tab.id);
      const cdpList = stored ? Array.from(stored.values()) : [];
      const cleared = params.clear === true ? cdpList.length : 0;
      if (params.clear === true) cdpNetworkEntries.set(tab.id, new Map());
      // Return metadata-only entries (bodies are fetched on demand by export); cap the payload.
      const recent = cdpList.length > NETWORK_LIST_MAX_RETURNED ? cdpList.slice(cdpList.length - NETWORK_LIST_MAX_RETURNED) : cdpList;
      return { entries: recent, count: recent.length, totalCdpEntries: cdpList.length, cleared, mode: networkModeTabs.has(tab.id) };
    }
    case "network.get": {
      const tab = await getTabByParams(params);
      const stored = cdpNetworkEntries.get(tab.id);
      const entry = stored && stored.get(String(params.requestId));
      if (!entry) throw new Error(`No CDP network entry with requestId ${params.requestId}`);
      if (entry.status && isHarBodyEligible(entry.mimeType) && entry.bodyError === undefined && params.includeBodies !== false) {
        const body = await fetchCdpResponseBody(tab.id, entry.requestId);
        if (body && typeof body.text === "string") entry._fetchedBody = capHarBody(body.text);
        else if (body && body.error) entry.bodyError = body.error;
      }
      return { ...entry };
    }
    case "network.initiatorChain": {
      // chrome_network_initiator_chain: rebuild the DevTools-style Request-initiator tree for one
      // captured request (ancestor chain + optional reverse dependents) from the CDP capture
      // store, which keeps the full initiator record captured at requestWillBeSent (M0).
      const tab = await getTabByParams(params);
      const stored = cdpNetworkEntries.get(tab.id);
      if (!stored || stored.size === 0) {
        throw new Error(
          "No CDP network entries captured for this tab — enable chrome_network_capture and reload the page before asking for an initiator chain",
        );
      }
      return buildInitiatorChain(stored, params);
    }
    case "network.summary": {
      // chrome_network_summary: aggregate the captured CDP store (pure builder, vm-testable).
      const tab = await getTabByParams(params);
      const stored = cdpNetworkEntries.get(tab.id);
      if (!stored || stored.size === 0) {
        throw new Error(
          "No CDP network entries captured for this tab — enable chrome_network_capture and reload the page before asking for a summary",
        );
      }
      return buildNetworkSummary(stored);
    }
    case "network.cache":
      return chromeNetworkCache(params);
    case "network.throttle":
      return chromeNetworkThrottle(params);
    case "network.export": {
      const tab = await getTabByParams(params);
      return exportNetworkHar(tab, params);
    }
    case "page.network.list": {
      const result = await executeInTab(params, listNetworkRequests, [params.includePreservedRequests === true, params.clear === true]);
      // Enrich with CDP Network-domain entries captured while network capture mode is on — the
      // in-page fetch/XHR capture cannot see document/static requests (feat-cdp-network).
      const tab = await getTabByParams(params);
      const stored = cdpNetworkEntries.get(tab.id);
      const cdpList = stored ? Array.from(stored.values()) : [];
      const recent = cdpList.length > NETWORK_LIST_MAX_RETURNED ? cdpList.slice(cdpList.length - NETWORK_LIST_MAX_RETURNED) : cdpList;
      return { ...result, cdpEntries: recent, cdpCount: cdpList.length, networkCaptureMode: networkModeTabs.has(tab.id) };
    }
    case "page.network.get": {
      try {
        return await executeInTab(params, getNetworkRequest, [params.requestId]);
      } catch (error) {
        // Fall back to CDP-captured entries when the id is not an in-page fetch/XHR request
        // (e.g. a document/static request captured by the Network domain).
        const tab = await getTabByParams(params);
        const stored = cdpNetworkEntries.get(tab.id);
        const entry = stored && stored.get(String(params.requestId));
        if (!entry) throw error;
        if (entry.status && isHarBodyEligible(entry.mimeType) && entry.bodyError === undefined && params.includeBodies !== false) {
          const body = await fetchCdpResponseBody(tab.id, entry.requestId);
          if (body && typeof body.text === "string") entry._fetchedBody = capHarBody(body.text);
          else if (body && body.error) entry.bodyError = body.error;
        }
        return { ...entry, source: "cdp" };
      }
    }
    case "page.waitFor": {
      // Poll from the service worker via CDP (bypasses CSP). The old approach ran the polling
      // loop in-page with new Function() for expression checks, which fails under strict CSP.
      const tab = await getTabByParams(params);
      if (params.foreground) await bringToFront(tab);
      if ((params.kind === "selector" || params.kind === "expression") && !params.value) {
        throw new Error(`chrome_wait_for: value is required for kind=${params.kind}`);
      }
      const timeoutMs = params.timeoutMs || 10000;
      const intervalMs = params.intervalMs || 250;
      const started = Date.now();
      // networkIdle needs the fetch/XHR instrumentation installed so entries are tagged pending.
      if (params.kind === "networkIdle") {
        try { await ensureNetworkInstrumentation(tab.id); } catch {}
      }
      const baselineUrl = tab.url || "";
      const idleMs = Math.max(Number(params.value) || 500, 100);
      let idleSince = null;
      while (Date.now() - started < timeoutMs) {
        let ok = false;
        try {
          let expr;
          if (params.kind === "selector") expr = `!!document.querySelector(${JSON.stringify(params.value)})`;
          else if (params.kind === "navigation") {
            // Wait until location.href differs from the command-start URL, or includes a given
            // substring when value is provided (click -> wait -> assert in one round trip).
            expr = params.value
              ? `location.href.includes(${JSON.stringify(params.value)})`
              : `location.href !== ${JSON.stringify(baselineUrl)}`;
          } else if (params.kind === "networkIdle") {
            expr = `(() => { const s = window.__PI_CHROME_STATE__; return !s || !Array.isArray(s.network) ? true : !s.network.some(e => e.status === "pending"); })()`;
          } else {
            expr = params.value;
          }
          // Reuse the resolved tab instead of re-resolving (chrome.tabs.get) every 250ms.
          ok = Boolean(await evaluateInResolvedTab(tab, { ...params, expression: expr, foreground: false }));
        } catch {
          ok = false;
        }
        if (ok) {
          if (params.kind === "networkIdle") {
            // Must stay request-free for the requested duration, not just one poll.
            if (idleSince === null) idleSince = Date.now();
            if (Date.now() - idleSince >= idleMs) {
              return { elapsedMs: Date.now() - started, kind: "networkIdle", idleMs };
            }
          } else {
            return { elapsedMs: Date.now() - started };
          }
        } else {
          idleSince = null;
        }
        await sleep(intervalMs);
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${params.kind}: ${params.value}`);
    }
    case "page.probe":
      // Lightweight capability probe for /chrome-doctor. Runs in MAIN world.
      return executeInTab(params, probePage, []);
    case "page.navigate": {
      const tab = await getTabByParams(params);
      if (params.foreground) await bringToFront(tab);
      if (params.initScript) {
        // Register a one-shot document_start content script. We register, navigate, wait, then unregister.
        await registerInitScript(tab.id, params.initScript);
      }
      const wait = params.waitUntilLoad !== false ? waitForTabComplete(tab.id, params.timeoutMs || 15000) : Promise.resolve(undefined);
      const updated = await chrome.tabs.update(tab.id, { url: params.url });
      try {
        await wait;
      } finally {
        if (params.initScript) await unregisterInitScript(tab.id).catch(() => undefined);
      }
      return await formatTab(await chrome.tabs.get(updated.id));
    }
    case "page.screenshot":
      return takeScreenshot(params);
    case "automation.status": {
      // Report this session's owned automation target (ids only). Used for diagnostics/tests.
      await hydrateAutomationTargets();
      const t = automationTargets.get(sessionKeyOf(params));
      return { windowId: t?.windowId ?? null, tabId: t?.tabId ?? null };
    }
    case "automation.cleanup":
      // Close only THIS session's pi-chrome-owned window/tab AND drop that session's named
      // handles. Never touches user tabs/windows or another Pi session's target/handles.
      {
        const sessionKey = sessionKeyOf(params);
        const removedHandles = [];
        await hydrateTabRegistry();
        for (const [name, entry] of tabRegistry) {
          if (entry.ownerSessionKey === sessionKey) {
            tabRegistry.delete(name);
            removedHandles.push(name);
          }
        }
        if (removedHandles.length) await persistTabRegistry();
        return { ...(await cleanupAutomationTarget(sessionKey)), removedHandles };
      }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function formatTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    highlighted: tab.highlighted,
    title: tab.title || "",
    url: tab.url || "",
    status: tab.status,
    pinned: tab.pinned,
    incognito: tab.incognito,
    groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
    group: await groupRecord(tab.groupId),
  };
}

// Resolve which Chrome tab an action targets.
//
// Explicit targeting (targetId / urlIncludes / titleIncludes) is unchanged: callers can still act
// on any existing tab, including a user tab, when they ask for it by name. Only the implicit
// "no target given" case changed — it used to grab the user's *active* tab (and page.navigate
// would then overwrite it); it now resolves to this Pi session's dedicated automation target.
//
// `createOwnedTarget` controls the implicit case:
//   - true  (default): create the automation target on first use. Used by every page/content
//     action — page.navigate, click/type/fill/key/hover/drag/scroll/tap/upload, snapshot,
//     inspect, evaluate, screenshot, waitFor, console/network list, probe. These need a live
//     surface to drive, so auto-creating is correct and they no longer touch the user's tab.
//   - false: do NOT create. Used by tab.activate/close/group/ungroup (tab *management*): with no
//     explicit target they operate on an already-owned automation target if one exists, else
//     throw asking for an explicit target — so e.g. `chrome_tab close` can never silently close
//     the user's active tab the way it used to, and never spawns a throwaway tab just to close it.
async function getTabByParams(params, { createOwnedTarget = true, resolution = null } = {}) {
  // tab-enumeration: avoid the full chrome.tabs.query({}) when an explicit targetId is given —
  // chrome.tabs.get(id) is a single lookup, and waitFor polls evaluateInTab every 250ms. The
  // full enumeration is only needed for urlIncludes/titleIncludes matching and stale-id listings.
  let tab;
  if (params.targetId !== undefined) {
    const id = Number(params.targetId);
    tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab?.id) {
      // Chrome tab ids are not stable across reloads/navigations; a long session can hold a
      // stale id. Surface the current tabs so the caller can re-target instead of guessing.
      throw new Error(
        `No Chrome tab with id ${id} (it was likely closed or replaced). ` +
        `Re-target with chrome_tab list, or pass urlIncludes/titleIncludes instead of targetId.\n` +
        `Current tabs:\n${(await listTabCandidates().catch(() => "")) || "  (none)"}`,
      );
    }
  } else if (params.urlIncludes) {
    // Multiple matches must NOT resolve silently to the first tab (audit: Array.find could drive
    // the wrong tab). Error with the candidate list so the caller re-targets explicitly.
    const tabs = await chrome.tabs.query({});
    const matching = tabs.filter((candidate) => (candidate.url || "").includes(params.urlIncludes));
    if (matching.length > 1) {
      throw ambiguityError(matching.length, `urlIncludes "${params.urlIncludes}"`, matching);
    }
    tab = matching[0];
  } else if (params.titleIncludes) {
    const tabs = await chrome.tabs.query({});
    const matching = tabs.filter((candidate) => (candidate.title || "").includes(params.titleIncludes));
    if (matching.length > 1) {
      throw ambiguityError(matching.length, `titleIncludes "${params.titleIncludes}"`, matching);
    }
    tab = matching[0];
  } else {
    // No explicit target: use this session's dedicated automation target instead of hijacking the
    // user's active tab. This keeps human browsing and Pi automation separated — navigating here
    // never replaces whatever the user currently has open. Callers that *want* a specific
    // existing tab pass targetId/urlIncludes/titleIncludes above.
    const sessionKey = sessionKeyOf(params);
    tab = createOwnedTarget
      ? await getOrCreateAutomationTarget(sessionKey, params.sessionGroupTitle)
      : await resolveOwnedAutomationTarget(sessionKey);
    if (!tab) {
      throw new Error(
        "No target tab specified and this Pi session has no automation tab yet. " +
        "Pass targetId/urlIncludes/titleIncludes, or run chrome_navigate first.",
      );
    }
    // QoL blank-tab hint: record that this target came from the implicit automation-target path
    // (not an explicit targetId), so snapshot/inspect can flag a blank owned tab for the caller.
    if (resolution) resolution.viaAutomationTarget = true;
  }
  if (!tab?.id) throw new Error("No matching Chrome tab found");
  const url = tab.url || "";
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("devtools://")) {
    throw new Error(`Chrome blocks extension automation on protected URL: tab=${tab.id} url=${url}`);
  }
  // Tabs Pi interacts with (page.* actions) join this session's group so the user can see exactly
  // which tabs Pi is driving. We only adopt *ungrouped* tabs — never hijack a tab the user (or
  // another Pi session) already grouped, since groupTab would otherwise rename that group.
  if (params.joinSessionGroup && params.sessionGroupTitle) {
    await joinSessionGroup(tab, params.sessionGroupTitle);
  }
  return tab;
}

// Enumerate current tabs once for error listings (stale-id diagnostics).
async function listTabCandidates() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((candidate) => candidate.id !== undefined)
    .slice(0, 20)
    .map((candidate) => `  ${candidate.id}${candidate.active ? " *" : ""}\t${(candidate.title || "(untitled)").slice(0, 60)}\t${candidate.url || ""}`)
    .join("\n");
}

// A target predicate that matched several tabs is ambiguous — acting on the first match would
// silently drive the wrong tab. Surface the candidate list so the caller can disambiguate.
function ambiguityError(count, predicate, candidates) {
  const listed = candidates
    .slice(0, 20)
    .map((candidate) => `  ${candidate.id}${candidate.active ? " *" : ""}\t${(candidate.title || "(untitled)").slice(0, 60)}\t${candidate.url || ""}`)
    .join("\n");
  return new Error(`${count} tabs match ${predicate}; pass targetId or a more specific urlIncludes:\n${listed || "  (none)"}`);
}

// Add an ungrouped tab to the session's tab group (reusing it by title, else creating it).
// No-op when the tab is already grouped or tabGroups is unavailable.
async function joinSessionGroup(tab, title) {
  if (!chrome.tabGroups || typeof tab.id !== "number") return;
  if (typeof tab.groupId === "number" && tab.groupId >= 0) return;
  try {
    await groupTab(tab, title);
  } catch {
    // Grouping is best-effort; never block the actual page action on a grouping failure.
  }
}

// Helper sources that get concatenated into the injected MAIN-world script. Kept as separate
// functions so callers below can reference them by `.toString()`. The helpers do not perform any
// eval themselves — they're plain function declarations.
const HELPER_FUNCS = [
  getPiChromeState,
  rememberElement,
  elementBySelectorOrUid,
  installPiChromeInstrumentation,
  resolvePoint,
  dispatchInputEvents,
  setNativeValue,
  normalizeKey,
  isElementVisible,
  occluderAt,
  pageHash,
  pointerEventSequence,
  sleepPage,
  rand,
  dispatchPointerLikeEvent,
  humanMoveTo,
  humanClickPoint,
  usKeyLayoutForChar,
  printableKeyCode,
  dispatchKeyEvent,
  typeCharacter,
  pressKeyInPage,
  scrollPage,
];

// helper-globals: only helpers the CURRENT SW commands actually reference are injected, and they
// all live under one window.__piChromeHelpers namespace. The DOM-input emulation helpers
// (clickPage/typeIntoPage/humanMoveTo/rand/typeCharacter/...) are legacy code no command reaches
// today; injecting ~24 of them as bare page globals clobbered generic site globals.
const INJECTED_HELPERS = new Set(["getPiChromeState", "installPiChromeInstrumentation"]);

async function executeInTab(params, func, args) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  // Paused-page rail (M0): a Debugger.paused page freezes the main thread; the injected page
  // script would hang until its timeout. Auto-resume first and surface the pause prominently.
  const pauseNote = await ensurePageUsable(tab.id, "in-page command");
  const mergePauseNote = (v) => {
    if (pauseNote && v && typeof v === "object" && !Array.isArray(v)) v.pausedAutoResumed = pauseNote;
    return v;
  };

  // Phase 1: define the helpers and the action function under the page's
  // window.__piChromeHelpers namespace via CDP Runtime.evaluate. This bypasses page CSP
  // (no `eval`/`new Function`), which is the root cause of snapshot/click/etc silently failing
  // on `script-src 'self'` sites.
  const assignments = HELPER_FUNCS
    .filter((helper) => INJECTED_HELPERS.has(helper.name))
    .map((helper) => `window.__piChromeHelpers[${JSON.stringify(helper.name)}]=${helper.toString()}`)
    .join(";\n");
  const actionAssign = `window.__piChromeHelpers.__piAction=(${func.toString()})`;
  const defineRes = await cdpEval(tab.id, `(()=>{window.__piChromeHelpers=window.__piChromeHelpers||{};\n${assignments};\n${actionAssign};})()`);
  if (defineRes.exceptionDetails) {
    throw new Error(`Failed to inject Chrome page helpers: ${cdpExceptionText(defineRes.exceptionDetails) || "unknown error"}`);
  }

  // Phase 2: run the action. chrome.scripting.executeScript (the `func:` form) is injected by
  // Chrome itself (not `new Function`), so it is CSP-safe and lets Chrome serialize the args —
  // but it can't reach restricted-scheme origins (about:blank etc.), where we fall back to CDP.
  if (await tabScriptingRestricted(tab)) {
    // Predefine the args under __piArgs, then call the action over CDP in the MAIN world. The
    // wrapper references window.__piChromeHelpers.__piAction defined in Phase 1 above.
    await cdpEvalInFrame(tab, 0, `window.__piArgs=${JSON.stringify(args || [])};`, {});
    const res = await cdpEvalInFrame(tab, 0,
      `(async()=>{try{return {ok:true,value:await window.__piChromeHelpers.__piAction(...window.__piArgs)};}catch(error){return {ok:false,error:error?.stack||error?.message||String(error)};}})()`,
      { awaitPromise: true });
    if (res && res.exceptionDetails) {
      throw new Error(`Failed to execute page action: ${cdpExceptionText(res.exceptionDetails) || "unknown error"}`);
    }
    const envelope = res && res.result && res.result.value;
    if (envelope && envelope.ok === false) throw new Error(envelope.error || "Chrome page script failed");
    return mergePauseNote(envelope && envelope.ok === true ? envelope.value : undefined);
  }
  const results = await executeScriptTimed({
    target: { tabId: tab.id },
    world: "MAIN",
    func: async (invocationArgs) => {
      try {
        return { ok: true, value: await window.__piChromeHelpers.__piAction(...invocationArgs) };
      } catch (error) {
        return { ok: false, error: error?.stack || error?.message || String(error) };
      }
    },
    args: [args || []],
  }, `execute page action in tab ${tab.id}`);
  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    throw new Error(message);
  }
  const envelope = first?.result;
  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    throw new Error(envelope.error || "Chrome page script failed");
  }
  return mergePauseNote(envelope?.value);
}

// Serializer for page.evaluate results. Embedded (via .toString()) into the CDP-evaluated
// expression so we can return rich markers for values that don't survive returnByValue
// (undefined/function/symbol/bigint/Error), plus expand DOMRect-like objects whose fields
// are non-enumerable. Kept as a standalone function so it stays editable/lintable.
function piEvalStringify(v) {
  if (v === undefined) return { kind: "undefined" };
  if (typeof v === "function") return { kind: "function", source: v.toString().slice(0, 500) };
  if (typeof v === "symbol") return { kind: "symbol", description: v.description };
  if (typeof v === "bigint") return { kind: "bigint", value: v.toString() };
  if (v instanceof Error) return { kind: "error", name: v.name, message: v.message, stack: v.stack };
  // DOMRect/DOMRectReadOnly (and getBoundingClientRect results) have non-enumerable
  // properties, so JSON.stringify yields `{}`. Expand the fields explicitly.
  if ((typeof DOMRectReadOnly !== "undefined" && v instanceof DOMRectReadOnly) ||
      (typeof DOMRect !== "undefined" && v instanceof DOMRect) ||
      (v && typeof v === "object" && typeof v.toJSON === "function" &&
       typeof v.width === "number" && typeof v.height === "number" && typeof v.top === "number")) {
    return { x: v.x, y: v.y, width: v.width, height: v.height, top: v.top, right: v.right, bottom: v.bottom, left: v.left };
  }
  return v;
}

// Dedicated executor for page.evaluate. Uses CDP Runtime.evaluate (via cdpEval) which is not
// subject to the page's CSP, fixing `chrome_evaluate` silently returning null / failing on
// pages that ship `script-src 'self'` without `'unsafe-eval'` (which blocks `eval`/`new Function`).
async function evaluateInTab(params) {
  const tab = await getTabByParams(params);
  return evaluateInResolvedTab(tab, params);
}

// Evaluate against an already-resolved tab (used by page.waitFor so the tab is not re-resolved
// on every 250ms iteration — tab-enumeration).
async function evaluateInResolvedTab(tab, params) {
  if (params.foreground) await bringToFront(tab);
  // Paused-page rail (M0): Runtime.evaluate on a Debugger.paused page hangs until the CDP
  // timeout. Auto-resume first; the pause is surfaced via console.warn + the diagnostics ring.
  const pauseNote = await ensurePageUsable(tab.id, "evaluate");
  const expression = String(params.expression ?? "");
  const stringifySrc = `(${piEvalStringify.toString()})`;
  // Wrap the user expression so the result is run through piEvalStringify in-page before it
  // crosses the returnByValue boundary. Try expression form first (so `1+1` / `document.title`
  // work without `return`); on a SyntaxError fall back to statement form for multi-statement
  // bodies (loops, var decls, etc), matching the previous new Function() two-form behavior.
  const buildWrapper = (form) => `(async () => { const __s=${stringifySrc}; const __v = await ${form}; return __s(__v); })()`;
  const exprForm = `(async () => (${expression}))()`;
  const stmtForm = `(async () => { ${expression} })()`;

  let res = await cdpEval(tab.id, buildWrapper(exprForm));
  if (res.exceptionDetails && cdpIsSyntaxError(res.exceptionDetails)) {
    res = await cdpEval(tab.id, buildWrapper(stmtForm));
  }
  if (res.exceptionDetails) {
    throw new Error(`chrome_evaluate failed: ${cdpExceptionText(res.exceptionDetails) || "evaluation failed"}`);
  }
  const result = res.result;
  if (!result || result.type === "undefined") return undefined;
  const v = result.value;
  // Unwrap special markers produced by piEvalStringify.
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (v.kind === "undefined") return undefined;
    if (v.kind === "function") return `[Function: ${v.source}]`;
    if (v.kind === "symbol") return `[Symbol: ${v.description}]`;
    if (v.kind === "bigint") return v.value;
    if (v.kind === "error") throw new Error(`${v.name}: ${v.message}\n${v.stack || ""}`);
  }
  if (pauseNote) {
    console.warn(`[pi-chrome] page was paused (${pauseNote.reason}); auto-resumed before evaluate`);
  }
  return v;
}

// Install the fetch/XHR instrumentation (same helper + action-injection path as executeInTab's
// Phase 1) so a networkIdle wait can see in-flight requests tagged status 'pending'.
async function ensureNetworkInstrumentation(tabId) {
  const assignments = HELPER_FUNCS
    .filter((helper) => INJECTED_HELPERS.has(helper.name))
    .map((helper) => `window.__piChromeHelpers[${JSON.stringify(helper.name)}]=${helper.toString()}`)
    .join(";\n");
  const res = await cdpEval(tabId, `(()=>{window.__piChromeHelpers=window.__piChromeHelpers||{};\n${assignments};\nwindow.__piChromeHelpers.installPiChromeInstrumentation();})()`);
  if (res.exceptionDetails) {
    throw new Error(`Failed to install network instrumentation: ${cdpExceptionText(res.exceptionDetails) || "unknown error"}`);
  }
}

async function withOptionalSnapshot(params, actionFn) {
  const result = await actionFn(params);
  if (params.includeSnapshot) {
    const snapshot = await snapshotInTab({ ...params, foreground: false });
    return { result, snapshot };
  }
  return result;
}

// Snapshot/inspect run from a packaged MAIN-world script (snapshot_injected.js) injected via
// chrome.scripting.executeScript({ files }). That file is free of eval/new Function, so it works
// on strict-CSP pages, and it installs globalThis.__piChromeSnapshotPage / __piChromeInspectTarget.
// It shares window.__PI_CHROME_STATE__ (same el- uid scheme) with the CDP-injected input helpers.
//
// Inject+invoke race: injection and invocation are separate executeScript calls, so a navigation
// between them leaves the invoke step with no global installed. On a "did not install" error we
// re-inject ONCE before failing (the navigation may have moved on again).
//
// Cross-origin iframes: the top frame is snapshotted as today; every sub-frame enumerated via
// chrome.webNavigation.getAllFrames is then snapshotted best-effort in its own context and its
// elements are merged in with a "frame:<frameId>" context marker. Sub-frame uids are renamed on
// the wire ("el-<n>" -> "el-f<frameId>-<n>") so act tools can route back to the owning frame.

// Sub-frame uid scheme: "el-f<frameId>-<seq>"; top-frame uids stay "el-<seq>". Returns the owning
// frame id (0 = top frame) plus the uid rewritten for lookup inside that frame's own state.
function parseFrameUid(uid) {
  if (typeof uid !== "string") return null;
  const match = /^el-f(\d+)-(.+)$/.exec(uid);
  if (!match) return null;
  return { frameId: Number(match[1]), localUid: `el-${match[2]}` };
}

// snapshotScriptFrames: per-tab (and per-frame) "snapshot script installed" tracking so the
// snapshot file is NOT re-injected on every snapshot (re-injection). Cleared on navigation via
// webNavigation.onCommitted and when a tab closes.
const snapshotScriptFrames = new Map(); // tabId -> Set<frameId>
async function injectSnapshotFile(tabId, frameId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const restricted = await tabScriptingRestricted(tab || { id: tabId });
  if (restricted) {
    // scripting.executeScript cannot reach restricted origins (about:blank etc.); inject the
    // snapshot source over CDP instead (the scripting files: path is unavailable there).
    await cdpEvalInFrame({ id: tabId }, frameId, await snapshotSourceText(), {});
  } else {
    await executeScriptTimed({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      files: ["snapshot_injected.js"],
    }, `inject snapshot script in tab ${tabId} frame ${frameId}`);
  }
  let set = snapshotScriptFrames.get(tabId);
  if (!set) { set = new Set(); snapshotScriptFrames.set(tabId, set); }
  set.add(frameId);
}

function isSnapshotScriptInstalled(tabId, frameId) {
  const set = snapshotScriptFrames.get(tabId);
  return !!set && set.has(frameId);
}

function clearSnapshotScriptInstalled(tabId, frameId) {
  if (frameId === 0) snapshotScriptFrames.delete(tabId);
  else {
    const set = snapshotScriptFrames.get(tabId);
    if (set) set.delete(frameId);
  }
}

// Invoke the installed snapshot page function inside one frame, re-injecting the file once when
// the tab navigated between injection and invocation (missing global).
async function runSnapshotPageInFrame(tab, frameId, args) {
  const invoke = async () => {
    if (await tabScriptingRestricted(tab)) {
      const res = await cdpEvalInFrame(tab, frameId, `window.__piArgs=${JSON.stringify(args || [])}; ${cdpSnapshotInvoke()}`, { awaitPromise: true });
      const outcome = unpackCdpInvoke(res, "Chrome snapshot script failed");
      return outcome;
    }
    const results = await executeScriptTimed({
      target: { tabId: tab.id, frameIds: [frameId] },
      world: "MAIN",
      func: async (invocationArgs) => {
        try {
          const snapshotPage = globalThis.__piChromeSnapshotPage;
          if (typeof snapshotPage !== "function") throw new Error("snapshot_injected.js did not install __piChromeSnapshotPage");
          const value = await snapshotPage(...invocationArgs);
          // elements-map surfacing: report evicted uids and an unresolved nearUid on the returned
          // snapshot so the agent refreshes instead of clicking a stale uid / assuming near-sort.
          if (value && typeof value === "object") {
            const pageState = globalThis.__PI_CHROME_STATE__;
            if (pageState && Array.isArray(pageState.evictedUids) && pageState.evictedUids.length) {
              if (!value.summary) value.summary = {};
              value.summary.evictedUids = pageState.evictedUids.slice(-20);
            }
            if (Array.isArray(invocationArgs) && typeof invocationArgs[3] === "string") {
              const resolved = pageState && pageState.elements ? pageState.elements[invocationArgs[3]] : null;
              if (!resolved || !resolved.isConnected) {
                if (!value.filter) value.filter = {};
                value.filter.nearUidResolved = false;
              }
            }
          }
          return { ok: true, value };
        } catch (error) {
          return { ok: false, error: error?.stack || error?.message || String(error) };
        }
      },
      args: [args],
    }, `run snapshot script in tab ${tab.id} frame ${frameId}`);
    return unpackFrameInvoke(results, "Chrome snapshot script failed");
  };
  let outcome = await invoke();
  if (outcome.missingGlobal) {
    await injectSnapshotFile(tab.id, frameId).catch(() => undefined);
    outcome = await invoke();
  }
  if (outcome.error) throw new Error(outcome.error);
  return outcome.value;
}

// Invoke the installed inspect target function inside one frame (same re-inject-once policy).
async function runInspectPageInFrame(tab, frameId, args) {
  const invoke = async () => {
    if (await tabScriptingRestricted(tab)) {
      const res = await cdpEvalInFrame(tab, frameId, `window.__piArgs=${JSON.stringify(args || [])}; ${cdpInspectInvoke()}`, { awaitPromise: true });
      const outcome = unpackCdpInvoke(res, "Chrome inspect script failed");
      return outcome;
    }
    const results = await executeScriptTimed({
      target: { tabId: tab.id, frameIds: [frameId] },
      world: "MAIN",
      func: async (invocationArgs) => {
        try {
          const inspectTarget = globalThis.__piChromeInspectTarget;
          if (typeof inspectTarget !== "function") throw new Error("snapshot_injected.js did not install __piChromeInspectTarget");
          return { ok: true, value: await inspectTarget(...invocationArgs) };
        } catch (error) {
          return { ok: false, error: error?.stack || error?.message || String(error) };
        }
      },
      args: [args],
    }, `run inspect script in tab ${tab.id} frame ${frameId}`);
    return unpackFrameInvoke(results, "Chrome inspect script failed");
  };
  let outcome = await invoke();
  if (outcome.missingGlobal) {
    await injectSnapshotFile(tab.id, frameId).catch(() => undefined);
    outcome = await invoke();
  }
  if (outcome.error) throw new Error(outcome.error);
  return outcome.value;
}

// Normalize an executeScript result envelope into { value } | { error } | { missingGlobal }.
function unpackFrameInvoke(results, fallbackError) {
  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    return { missingGlobal: /did not install/.test(message), error: message };
  }
  const envelope = first?.result;
  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    const message = envelope.error || fallbackError;
    return { missingGlobal: /did not install/.test(message), error: message };
  }
  return { value: envelope?.value };
}

async function snapshotInTab(params) {
  // QoL blank-tab hint: track whether the target was resolved via this session's
  // automation-target path (implicit, no targetId) so a blank owned tab can be flagged.
  const resolution = {};
  const tab = await getTabByParams(params, { resolution });
  if (params.foreground) await bringToFront(tab);
  // Paused-page rail (M0): the snapshot script injected into a Debugger.paused page never runs;
  // auto-resume first and surface the pause in the snapshot result.
  const pauseNote = await ensurePageUsable(tab.id, "snapshot");
  // Trailing budget args are the service-worker-side hookup for the snippet's single budgeted
  // TreeWalker pass (node + wall-clock budgets): the values are passed positionally (args 8/9)
  // and read by snapshot_injected.js when it grows optional params (budget-exhausted).
  const args = [
    params.maxElements || 80,
    params.containingText ?? null,
    params.roleFilter ?? null,
    params.nearUid ?? null,
    params.mode || "auto",
    params.query ?? null,
    params.maxTextChars ?? null,
    SNAPSHOT_DOM_NODE_BUDGET,
    SNAPSHOT_DOM_TIME_BUDGET_MS,
  ];
  // re-injection: skip the file injection when this tab/frame already has the script installed;
  // a navigation clears the flag (and the missingGlobal re-inject covers a replaced global).
  if (!isSnapshotScriptInstalled(tab.id, 0)) await injectSnapshotFile(tab.id, 0);
  const snapshot = await runSnapshotPageInFrame(tab, 0, args);
  await mergeSubframeSnapshots(tab, snapshot, args);
  if (snapshot && typeof snapshot === "object" && isBlankAutomationTarget(tab, params, resolution)) {
    snapshot._blankAutomationTab = true;
  }
  if (pauseNote && snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    snapshot.pausedAutoResumed = pauseNote;
  }
  return snapshot;
}

// Sub-frame snapshots contribute only element summaries to the merged result; force interactive
// mode (elements only) so per-frame text/pageMap/forms work is skipped on the output side
// (subframe-snapshot-cost; snapshot_injected.js can additionally skip the computation lazily).
function subframeSnapshotArgs(args) {
  const copy = Array.isArray(args) ? args.slice() : [];
  copy[4] = "interactive";
  return copy;
}

// Best-effort cross-origin/sub-frame enumeration: snapshot each sub-frame in its own context and
// merge its elements (uid-prefixed + frame-tagged) into the top-frame result. Frames that fail to
// snapshot — or that we skip because the shared wall-clock budget lapsed — are listed as iframe
// placeholders so callers know content lives in a frame (subframe-snapshot-cost).
async function mergeSubframeSnapshots(tab, snapshot, args) {
  if (!Array.isArray(snapshot.elements) || !chrome.webNavigation || typeof chrome.webNavigation.getAllFrames !== "function") return;
  let frames = [];
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  } catch {
    return;
  }
  const subframes = (frames || []).filter((frame) => frame && typeof frame.frameId === "number" && frame.frameId > 0);
  if (!subframes.length) return;
  const started = Date.now();
  const subframeArgs = subframeSnapshotArgs(args);
  const results = new Array(subframes.length);
  let next = 0;
  // Bounded-concurrency worker pool (the serial per-frame full snapshots blew the command
  // timeout on multi-iframe pages).
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= subframes.length) return;
      const frame = subframes[i];
      if (Date.now() - started > SUBFRAME_SNAPSHOT_BUDGET_MS) {
        results[i] = { skipped: true };
        continue;
      }
      let value = null;
      try {
        value = await runSnapshotPageInFrame(tab, frame.frameId, subframeArgs);
      } catch {
        // Best-effort: a frame we could not snapshot is still listed as an iframe placeholder.
      }
      results[i] = value && Array.isArray(value.elements) ? { elements: value.elements } : { elements: null };
    }
  };
  await Promise.all(Array.from({ length: Math.min(SUBFRAME_SNAPSHOT_CONCURRENCY, subframes.length) }, worker));
  const extra = [];
  let skipped = 0;
  let snapshotted = 0;
  for (let i = 0; i < subframes.length; i++) {
    const frame = subframes[i];
    const res = results[i] || {};
    if (res.skipped) { skipped++; extra.push(placeholderFrame(frame)); continue; }
    const frameElements = res.elements;
    if (frameElements && frameElements.length) {
      snapshotted++;
      for (const el of frameElements) {
        if (el && typeof el.uid === "string") el.uid = `el-f${frame.frameId}-${el.uid.replace(/^el-/, "")}`;
        if (el) {
          el.frame = frame.frameId;
          // context-clobber: preserve any structured context object (uid/label) and ADD the frame
          // marker instead of replacing it with a bare 'frame:<id>' string.
          el.context = { ...(typeof el.context === "object" && el.context !== null ? el.context : {}), frame: frame.frameId };
        }
      }
      extra.push(...frameElements);
    } else {
      extra.push(placeholderFrame(frame));
    }
  }
  if (!extra.length) return;
  const cap = Math.max(snapshot.elements.length, SNAPSHOT_MAX_MERGED_ELEMENTS);
  snapshot.elements = [...snapshot.elements, ...extra].slice(0, cap);
  if (snapshot.summary && typeof snapshot.summary.totalInteractiveSampled === "number") {
    snapshot.summary.totalInteractiveSampled += extra.length;
  }
  if (typeof snapshot.summary === "object" && snapshot.summary !== null) {
    snapshot.summary.subframes = { total: subframes.length, snapshotted, skipped, merged: extra.length };
  }
}

function placeholderFrame(frame) {
  return { tag: "iframe", role: "iframe", context: { frame: frame.frameId }, label: frame.url || "iframe" };
}

async function inspectInTab(params) {
  if (!params.uid && !params.selector) throw new Error("chrome_inspect requires uid or selector");
  // QoL blank-tab hint: same automation-path tracking as snapshotInTab.
  const resolution = {};
  const tab = await getTabByParams(params, { resolution });
  if (params.foreground) await bringToFront(tab);
  const frameUid = params.uid ? parseFrameUid(params.uid) : null;
  const frameId = frameUid ? frameUid.frameId : 0;
  const args = [frameUid ? frameUid.localUid : (params.uid ?? null), params.selector ?? null, params.scrollIntoView === true];
  const result = await runInspectPageInFrame(tab, frameId, args);
  if (result && typeof result === "object" && isBlankAutomationTarget(tab, params, resolution)) {
    result._blankAutomationTab = true;
  }
  return result;
}

// One-shot init script registry, scoped per tab. The source is registered with CDP
// Page.addScriptToEvaluateOnNewDocument, which runs it at document_start in the page's MAIN
// world and is NOT subject to page CSP (the old func:(code)=>new Function(code) path was
// blocked by `script-src 'self'`). page.navigate registers before the nav and unregisters
// after load, so only the intended navigation receives the script.
const initScriptIds = new Map(); // tabId -> CDP script identifier
async function registerInitScript(tabId, source) {
  await attachDebugger(tabId);
  await cdp(tabId, "Page.enable", {}).catch(() => undefined);
  const result = await cdp(tabId, "Page.addScriptToEvaluateOnNewDocument", { source });
  if (result && result.identifier !== undefined) initScriptIds.set(tabId, result.identifier);
}
async function unregisterInitScript(tabId) {
  const identifier = initScriptIds.get(tabId);
  if (identifier === undefined) return;
  initScriptIds.delete(tabId);
  await cdp(tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => undefined);
}

// Always inject early console/network capture at document_start on every navigation.
// Catches console messages, errors, and network requests that fire during page load,
// before chrome_snapshot or chrome_evaluate install the instrumentation normally.
// The function installEarlyCapture sets __piChromeWrapped flags so the post-hoc
// installPiChromeInstrumentation() call is idempotent.
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    // A committed navigation invalidates the injected snapshot script: top-frame navigations
    // clear the whole tab; sub-frame navigations clear just that frame (re-injection).
    clearSnapshotScriptInstalled(details.tabId, details.frameId);
    if (details.frameId !== 0) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [0] },
      world: "MAIN",
      injectImmediately: true,
      func: installEarlyCapture,
      args: [],
    }).catch(() => undefined);
  });
}

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => snapshotScriptFrames.delete(tabId));
}

async function bringToFront(tab) {
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for tab ${tabId} to load`));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Single-shot full-page capture via CDP Page.captureScreenshot { captureBeyondViewport: true }
// (chrome_full_page_screenshot, TOOL_CONTRACTS §5.17). Returns the same wire shape as the tile
// path ({ fullPage, dataUrl, dimensions }) or null so takeScreenshot can fall back to tiles.
// Extremely tall pages (> MAX_FULLPAGE_TILES * 3 viewport heights) skip the single shot — a
// viewport-height-only buffer risks renderer OOM on a mega capture.
async function captureFullPageViaCdp(tab, params) {
  await attachDebugger(tab.id);
  const metrics = await cdp(tab.id, "Page.getLayoutMetrics", {}).catch(() => null);
  const contentSize = metrics?.cssContentSize;
  if (!contentSize || typeof contentSize.width !== "number" || typeof contentSize.height !== "number") return null;
  const viewportHeight = metrics?.cssVisualViewport?.clientHeight || 800;
  const height = contentSize.height;
  if (height / Math.max(viewportHeight, 1) > MAX_FULLPAGE_TILES * 3) return null;
  const format = params.format || "png";
  const scale = Math.max(0.1, Math.min(3, Number(params.scale) || 1));
  const clip = params.clip && typeof params.clip === "object"
    ? {
        x: Number(params.clip.x) || 0,
        y: Number(params.clip.y) || 0,
        width: Math.max(1, Number(params.clip.width) || 1),
        height: Math.max(1, Number(params.clip.height) || 1),
        scale,
      }
    : undefined;
  const shot = await cdp(tab.id, "Page.captureScreenshot", {
    format,
    quality: format === "jpeg" ? (typeof params.quality === "number" ? params.quality : 90) : undefined,
    captureBeyondViewport: true,
    fromSurface: true,
    scale,
    ...(clip ? { clip } : {}),
  });
  if (!shot || typeof shot.data !== "string" || !shot.data) return null;
  return {
    fullPage: true,
    dataUrl: `data:image/${format};base64,${shot.data}`,
    tab: await formatTab(tab),
    dimensions: {
      width: clip ? clip.width : contentSize.width,
      height: clip ? clip.height : height,
      viewportHeight,
      dpr: contentSize.scale ?? 1,
    },
    captureMode: "cdp",
  };
}

async function takeScreenshot(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  // Paused-page rail (M0): capture commands sent to a Debugger.paused page hang (the renderer
  // cannot composite a frame); auto-resume first and surface the pause in the result.
  const pauseNote = await ensurePageUsable(tab.id, "screenshot");
  const mergePauseNote = (obj) => {
    if (pauseNote && obj && typeof obj === "object" && !Array.isArray(obj)) obj.pausedAutoResumed = pauseNote;
    return obj;
  };
  // Element-scoped screenshots (feat-element-screenshot): resolve uid/selector to a viewport
  // rect and capture through the attached CDP debugger, which works on inactive tabs — so
  // background mode never activates the tab (no focus/restore churn like captureVisibleTab).
  if (params.uid || params.selector) {
    return elementScreenshot(tab, params);
  }
  let previousActiveId;
  if (!tab.active) {
    const activeBefore = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    previousActiveId = activeBefore[0]?.id;
    await chrome.tabs.update(tab.id, { active: true });
  }
  try {
    if (params.fullPage) {
      // P0 single-shot full page (chrome_full_page_screenshot, TOOL_CONTRACTS §5.17): prefer
      // CDP Page.captureScreenshot with captureBeyondViewport — no scroll/focus churn, no
      // lazy-load artifacts. Falls back to the tile-stitched path when the renderer rejects it
      // (older Chrome / headless builds) or the page is extremely tall (OOM guard).
      const single = await captureFullPageViaCdp(tab, params).catch((error) => {
        console.warn(`[pi-chrome] CDP full-page capture failed, falling back to tiles: ${String(error?.message || error)}`);
        return null;
      });
      if (single) return mergePauseNote(single);
      // Tile-stitched full page capture: scroll, capture, paste, repeat. Defaults to jpeg (PNG
      // tiles for tall pages are tens of MB per tile set) and caps pathological page heights.
      const tiles = await executeInTab({ ...params, foreground: false }, captureFullPageTiles, [MAX_FULLPAGE_TILES]);
      // captureFullPageTiles only computes scroll positions / metrics; we capture per scroll here
      // (chrome.tabs.captureVisibleTab can't be called from MAIN world).
      const captured = [];
      const tilePlan = Array.isArray(tiles.tiles) ? tiles.tiles.slice(0, MAX_FULLPAGE_TILES) : [];
      const format = params.format || "jpeg";
      const quality = format === "jpeg" ? (typeof params.quality === "number" ? params.quality : 90) : undefined;
      for (const tile of tilePlan) {
        await executeInTab({ ...params, foreground: false }, scrollToY, [tile.scrollY]);
        // Small settle delay; many sites have on-scroll animations / lazy-load.
        await sleep(120);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality });
        captured.push({ y: tile.y, dataUrl });
      }
      await executeInTab({ ...params, foreground: false }, scrollToY, [tiles.originalScrollY]);
      return mergePauseNote({
        fullPage: true,
        tab: await formatTab(tab),
        dimensions: { width: tiles.width, height: tiles.height, viewportHeight: tiles.viewportHeight, dpr: tiles.dpr },
        tiles: captured,
        tilesTruncated: Array.isArray(tiles.tiles) && tiles.tiles.length > MAX_FULLPAGE_TILES ? tiles.tiles.length - MAX_FULLPAGE_TILES : undefined,
      });
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: params.format || "png",
      quality: params.format === "jpeg" ? params.quality : undefined,
    });
    return mergePauseNote({ dataUrl, tab: await formatTab(tab) });
  } finally {
    // Restore the previous active tab before returning so the user is not left on the Pi tab
    // when this was a background capture (screenshot-tiles).
    if (previousActiveId !== undefined && previousActiveId !== tab.id) {
      await chrome.tabs.update(previousActiveId, { active: true }).catch(() => undefined);
    }
  }
}

// Element-scoped screenshot via CDP Page.captureScreenshot {clip} on the attached debugger
// (feat-element-screenshot). resolveTargetInTab computes the element's top-level viewport rect
// (it scrolls the element into view first), then we capture just that rect. CDP capture works
// on non-active tabs, so this path never activates/restores the tab in background mode.
async function elementScreenshot(tab, params) {
  if (params.fullPage) {
    throw new Error("chrome_screenshot: fullPage cannot be combined with uid/selector; drop uid/selector for a full-page capture");
  }
  let resolved;
  try {
    resolved = await resolveTargetInTab(tab.id, params);
  } catch (error) {
    throw new Error(`chrome_screenshot: ${error?.message || error}`);
  }
  if (!resolved.rect || typeof resolved.rect.width !== "number" || typeof resolved.rect.height !== "number") {
    throw new Error("chrome_screenshot: could not compute a bounding rect for the target element");
  }
  await attachDebugger(tab.id);
  const format = params.format || "png";
  // CDP clip is in top-level-viewport CSS px; clamp into positive integers like Chrome expects.
  const clip = {
    x: Math.max(0, Math.round(resolved.rect.left)),
    y: Math.max(0, Math.round(resolved.rect.top)),
    width: Math.max(1, Math.round(resolved.rect.width)),
    height: Math.max(1, Math.round(resolved.rect.height)),
    scale: 1,
  };
  const shot = await cdp(tab.id, "Page.captureScreenshot", {
    format,
    quality: format === "jpeg" ? (typeof params.quality === "number" ? params.quality : 90) : undefined,
    clip,
    captureBeyondViewport: false,
  });
  if (!shot || typeof shot.data !== "string" || !shot.data) {
    throw new Error("chrome_screenshot: CDP capture returned no image data");
  }
  return {
    dataUrl: `data:image/${format};base64,${shot.data}`,
    tab: await formatTab(tab),
    element: { uid: params.uid ?? null, selector: params.selector ?? null, rect: resolved.rect },
  };
}

// ---------------------------------------------------------------------------
// MAIN-world helpers (function declarations injected into the page).
// ---------------------------------------------------------------------------

function getPiChromeState() {
  const state = window.__PI_CHROME_STATE__ || {
    nextElementUid: 1,
    elements: {},
    console: [],
    network: [],
    nextRequestId: 1,
    instrumentationInstalled: false,
  };
  window.__PI_CHROME_STATE__ = state;
  // Migrate states created before the remembered-element eviction landed (parity with
  // snapshot_injected.js so whichever copy initializes first stays compatible).
  if (typeof state.rememberedCount !== "number") state.rememberedCount = Object.keys(state.elements || {}).length;
  if (!Array.isArray(state.evictedUids)) state.evictedUids = [];
  return state;
}

function rememberElement(element) {
  const state = getPiChromeState();
  if (!element.__piChromeUid) element.__piChromeUid = "el-" + state.nextElementUid++;
  if (!(element.__piChromeUid in state.elements)) state.rememberedCount++;
  state.elements[element.__piChromeUid] = element;
  evictRememberedElements(state);
  return element.__piChromeUid;
}

function rememberUidSequence(uid) {
  const n = Number(String(uid).replace(/^el-/, ""));
  return Number.isFinite(n) ? n : 0;
}

function recordEvictedUid(state, uid) {
  state.evictedUids.push(uid);
  if (state.evictedUids.length > 100) state.evictedUids.splice(0, state.evictedUids.length - 100);
}

// Cap the remembered-element map (elements-map): evict disconnected entries first, then the
// oldest uids, so a uid stays stable as long as its element is still live. Mirrors the policy in
// snapshot_injected.js and records dropped uids in state.evictedUids for summary surfacing.
function evictRememberedElements(state) {
  const MAX_REMEMBERED_ELEMENTS = 2000;
  if (state.rememberedCount <= MAX_REMEMBERED_ELEMENTS) return;
  const elements = state.elements;
  for (const uid of Object.keys(elements)) {
    const el = elements[uid];
    if (!el || !el.isConnected) {
      delete elements[uid];
      state.rememberedCount--;
      recordEvictedUid(state, uid);
    }
  }
  if (state.rememberedCount <= MAX_REMEMBERED_ELEMENTS) return;
  const byAge = Object.keys(elements).sort((a, b) => rememberUidSequence(a) - rememberUidSequence(b));
  const excess = state.rememberedCount - MAX_REMEMBERED_ELEMENTS;
  for (let i = 0; i < excess; i++) {
    const uid = byAge[i];
    if (uid) {
      delete elements[uid];
      state.rememberedCount--;
      recordEvictedUid(state, uid);
    }
  }
}

function elementBySelectorOrUid(selector, uid) {
  if (uid) {
    const element = getPiChromeState().elements[uid];
    if (!element || !element.isConnected) throw new Error(`No live element for uid: ${uid}. Take a fresh chrome_snapshot.`);
    return element;
  }
  if (selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`No element matches selector: ${selector}`);
    return element;
  }
  return null;
}

function isElementVisible(element) {
  if (!element || !element.getBoundingClientRect) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (rect.bottom < 0 || rect.right < 0) return false;
  if (rect.top > innerHeight || rect.left > innerWidth) return false;
  return true;
}

function occluderAt(x, y, expected) {
  const top = document.elementFromPoint(x, y);
  if (!top || top === expected) return null;
  if (expected && expected.contains(top)) return null;
  if (top.contains(expected)) return null;
  return {
    tag: top.tagName.toLowerCase(),
    id: top.id || undefined,
    className: typeof top.className === "string" ? top.className : undefined,
  };
}

function pageHash() {
  // Cheap rolling hash used for `pageMutated` (pagehash-layout). The old version forced a full
  // document innerText pass (layout + text generation) before AND after every interaction; this
  // samples bounded textContent prefixes instead (no forced layout), plus current input values
  // and the descendant count, which together still catch text edits, value changes, and DOM
  // structure changes.
  const body = document.body || document.documentElement;
  if (!body) return 0;
  let h = 0;
  const feed = (s) => { for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; };
  feed((body.textContent || "").slice(0, 4000));
  const inputs = body.querySelectorAll("input,textarea,select");
  let valueBlob = "";
  for (let i = 0; i < inputs.length && valueBlob.length < 4000; i++) {
    const v = inputs[i].value;
    if (typeof v === "string") valueBlob += v + "\x00";
  }
  feed(valueBlob);
  h = (h * 31 + body.getElementsByTagName("*").length) | 0;
  return h;
}

function sleepPage(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function dispatchPointerLikeEvent(element, type, x, y, prevX, prevY, opts = {}) {
  const isPointer = type.startsWith("pointer");
  const Ctor = isPointer ? PointerEvent : MouseEvent;
  const isMove = type === "pointermove" || type === "mousemove";
  const isUpOrClick = type === "pointerup" || type === "mouseup" || type === "click";
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x + (window.screenX || 0),
    screenY: y + (window.screenY || 0),
    movementX: Number.isFinite(prevX) ? x - prevX : 0,
    movementY: Number.isFinite(prevY) ? y - prevY : 0,
    button: 0,
    buttons: isMove || isUpOrClick ? 0 : 1,
  };
  if (isPointer) {
    init.pointerType = "mouse";
    init.pointerId = 1;
    init.isPrimary = true;
    init.width = 1;
    init.height = 1;
    init.pressure = opts.pressure ?? (type === "pointerdown" ? 0.5 : 0);
    init.tangentialPressure = 0;
    init.tiltX = 0;
    init.tiltY = 0;
  }
  const ev = new Ctor(type, init);
  element.dispatchEvent(ev);
  return ev.defaultPrevented;
}

function pointerEventSequence(element, x, y, sequence) {
  let defaultPrevented = false;
  const state = getPiChromeState();
  const prevX = state.pointer?.x;
  const prevY = state.pointer?.y;
  for (const type of sequence) {
    defaultPrevented = dispatchPointerLikeEvent(element, type, x, y, prevX, prevY) || defaultPrevented;
  }
  state.pointer = { x, y, t: performance.now() };
  return defaultPrevented;
}

async function humanMoveTo(x, y, steps) {
  const state = getPiChromeState();
  const startX = Number.isFinite(state.pointer?.x) ? state.pointer.x : window.__piChromeHelpers.rand(12, Math.max(24, innerWidth - 12));
  const startY = Number.isFinite(state.pointer?.y) ? state.pointer.y : window.__piChromeHelpers.rand(12, Math.max(24, innerHeight - 12));
  const n = steps || Math.max(12, Math.min(42, Math.round(Math.hypot(x - startX, y - startY) / 18)));
  let prevX = startX, prevY = startY;
  let defaultPrevented = false;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 8;
    const px = startX + (x - startX) * ease + window.__piChromeHelpers.rand(-wobble, wobble);
    const py = startY + (y - startY) * ease + window.__piChromeHelpers.rand(-wobble, wobble);
    const el = document.elementFromPoint(px, py) || document.body || document.documentElement;
    defaultPrevented = dispatchPointerLikeEvent(el, "pointermove", px, py, prevX, prevY) || defaultPrevented;
    defaultPrevented = dispatchPointerLikeEvent(el, "mousemove", px, py, prevX, prevY) || defaultPrevented;
    prevX = px; prevY = py;
    await sleepPage(window.__piChromeHelpers.rand(4, 18));
  }
  state.pointer = { x, y, t: performance.now() };
  return defaultPrevented;
}

function humanClickPoint(point) {
  if (!point.rect) return { x: point.x, y: point.y };
  const rect = point.rect;
  const insetX = Math.min(rect.width * 0.35, Math.max(2, rect.width / 2 - 1));
  const insetY = Math.min(rect.height * 0.35, Math.max(2, rect.height / 2 - 1));
  return {
    x: rect.left + rect.width / 2 + window.__piChromeHelpers.rand(-insetX, insetX),
    y: rect.top + rect.height / 2 + window.__piChromeHelpers.rand(-insetY, insetY),
  };
}

function installPiChromeInstrumentation() {
  const state = window.__piChromeHelpers.getPiChromeState();
  if (state.instrumentationInstalled) return;
  state.instrumentationInstalled = true;
  const pushConsole = (level, args) => {
    state.console.push({
      id: state.console.length + 1,
      level,
      timestamp: Date.now(),
      url: location.href,
      args: Array.from(args).map((arg) => {
        try {
          // console-deep-clone: primitives pass through untouched; objects are serialized once
          // to a capped string (never parsed back / deep-cloned), so a console.log({huge}) on a
          // hot path cannot blow up memory or slow every call.
          if (typeof arg === "string") return arg.length > 8000 ? arg.slice(0, 8000) + "…[truncated]" : arg;
          if (typeof arg === "number" || typeof arg === "boolean" || arg === null || arg === undefined) return arg;
          if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
          const json = JSON.stringify(arg);
          if (json === undefined) return String(arg).slice(0, 8000);
          return json.length > 8000 ? json.slice(0, 8000) + "…[truncated]" : json;
        } catch {
          return String(arg).slice(0, 8000);
        }
      }),
    });
    if (state.console.length > 500) state.console.splice(0, state.console.length - 500);
  };
  for (const level of ["debug", "log", "info", "warn", "error"]){
    const original = console[level];
    if (typeof original !== "function" || original.__piChromeWrapped) continue;
    const wrapped = function(...args) {
      pushConsole(level, args);
      return original.apply(this, args);
    };
    wrapped.__piChromeWrapped = true;
    console[level] = wrapped;
  }
  window.addEventListener("error", (event) => pushConsole("pageerror", [event.message, event.filename + ":" + event.lineno + ":" + event.colno]));
  window.addEventListener("unhandledrejection", (event) => pushConsole("unhandledrejection", [event.reason]));

  const trimBody = (text) => typeof text === "string" && text.length > 200000 ? text.slice(0, 200000) + `\n[truncated ${text.length - 200000} chars]` : text;
  const record = (entry) => {
    state.network.push(entry);
    if (state.network.length > 1000) state.network.splice(0, state.network.length - 1000);
    return entry;
  };
  if (window.fetch && !window.fetch.__piChromeWrapped) {
    const originalFetch = window.fetch.bind(window);
    const wrappedFetch = async (...args) => {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === "string" ? input : input?.url;
      const method = (init.method || input?.method || "GET").toUpperCase();
      const entry = record({ id, type: "fetch", method, url: String(url || ""), startedAt, pageUrl: location.href, status: "pending" });
      try {
        const response = await originalFetch(...args);
        entry.status = response.status;
        entry.statusText = response.statusText;
        entry.ok = response.ok;
        entry.responseUrl = response.url;
        entry.durationMs = Date.now() - startedAt;
        entry.responseHeaders = Array.from(response.headers.entries());
        response.clone().text().then((text) => {
          entry.responseBody = trimBody(text);
          entry.responseBodyTruncated = typeof text === "string" && text.length > 200000;
        }).catch((error) => { entry.responseBodyError = error?.message || String(error); });
        return response;
      } catch (error) {
        entry.error = error?.message || String(error);
        entry.durationMs = Date.now() - startedAt;
        throw error;
      }
    };
    wrappedFetch.__piChromeWrapped = true;
    window.fetch = wrappedFetch;
  }
  if (window.XMLHttpRequest && !XMLHttpRequest.prototype.open.__piChromeWrapped) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__piChromeRequest = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.open.__piChromeWrapped = true;
    XMLHttpRequest.prototype.send = function(body) {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const info = this.__piChromeRequest || {};
      const entry = record({ id, type: "xhr", method: info.method || "GET", url: info.url || "", startedAt, pageUrl: location.href, status: "pending" });
      this.addEventListener("loadend", () => {
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.responseUrl = this.responseURL;
        entry.durationMs = Date.now() - startedAt;
        try { entry.responseHeadersText = this.getAllResponseHeaders(); } catch {}
        try {
          if (typeof this.responseText === "string") {
            entry.responseBody = trimBody(this.responseText);
            entry.responseBodyTruncated = this.responseText.length > 200000;
          }
        } catch (error) { entry.responseBodyError = error?.message || String(error); }
      });
      this.addEventListener("error", () => { entry.error = "XMLHttpRequest error"; entry.durationMs = Date.now() - startedAt; });
      return originalSend.call(this, body);
    };
  }
}

// Early-capture version of installPiChromeInstrumentation, designed to be injected
// at document_start via webNavigation.onCommitted. Wraps console, fetch, and XHR
// before the page's own JavaScript runs, so page-load errors are captured.
// Sets __piChromeWrapped flags so the post-hoc installPiChromeInstrumentation()
// sees them and skips (idempotent).
// NOTE: This function is self-contained — it does NOT close over any outer scope
// because it gets serialized by chrome.scripting.executeScript({func: ...}).
function installEarlyCapture() {
  if (window.__piChromeEarlyCaptureInstalled) return;
  window.__piChromeEarlyCaptureInstalled = true;
  var state = window.__PI_CHROME_STATE__;
  if (!state) {
    state = {
      nextElementUid: 1,
      elements: {},
      console: [],
      network: [],
      nextRequestId: 1,
      instrumentationInstalled: false,
    };
    window.__PI_CHROME_STATE__ = state;
  }
  function pushConsole(level, args) {
    state.console.push({
      id: state.console.length + 1,
      level: level,
      timestamp: Date.now(),
      url: location.href,
      args: Array.from(args).map(function(arg) {
        try {
          // console-deep-clone: primitives pass through; objects serialize once to a capped
          // string instead of a full deep clone (same policy as installPiChromeInstrumentation).
          if (typeof arg === "string") return arg.length > 8000 ? arg.slice(0, 8000) + "…[truncated]" : arg;
          if (typeof arg === "number" || typeof arg === "boolean" || arg === null || arg === undefined) return arg;
          if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
          var json = JSON.stringify(arg);
          if (json === undefined) return String(arg).slice(0, 8000);
          return json.length > 8000 ? json.slice(0, 8000) + "…[truncated]" : json;
        } catch (e) {
          return String(arg).slice(0, 8000);
        }
      }),
    });
    if (state.console.length > 500) state.console.splice(0, state.console.length - 500);
  }
  for (var i = 0; i < 5; i++) {
    var levels = ["debug", "log", "info", "warn", "error"];
    var level = levels[i];
    var original = console[level];
    if (typeof original !== "function" || original.__piChromeWrapped) continue;
    var wrapped = function(lvl, orig) {
      return function() {
        pushConsole(lvl, arguments);
        return orig.apply(this, arguments);
      };
    }(level, original);
    wrapped.__piChromeWrapped = true;
    console[level] = wrapped;
  }
  window.addEventListener("error", function(event) {
    pushConsole("pageerror", [event.message, event.filename + ":" + event.lineno + ":" + event.colno]);
  });
  window.addEventListener("unhandledrejection", function(event) {
    pushConsole("unhandledrejection", [event.reason]);
  });
  var trimBody = function(text) {
    return typeof text === "string" && text.length > 200000 ? text.slice(0, 200000) + "\n[truncated " + (text.length - 200000) + " chars]" : text;
  };
  var record = function(entry) {
    state.network.push(entry);
    if (state.network.length > 1000) state.network.splice(0, state.network.length - 1000);
    return entry;
  };
  if (window.fetch && !window.fetch.__piChromeWrapped) {
    var originalFetch = window.fetch.bind(window);
    var wrappedFetch = async function() {
      var args = [];
      for (var k = 0; k < arguments.length; k++) args.push(arguments[k]);
      var id = "req-" + state.nextRequestId++;
      var startedAt = Date.now();
      var input = args[0];
      var init = args[1] || {};
      var url = typeof input === "string" ? input : (input ? input.url : "");
      var method = (init.method || (input ? input.method : null) || "GET").toUpperCase();
      var entry = record({ id: id, type: "fetch", method: method, url: String(url || ""), startedAt: startedAt, pageUrl: location.href, status: "pending" });
      try {
        var response = await originalFetch.apply(window, args);
        entry.status = response.status;
        entry.statusText = response.statusText;
        entry.ok = response.ok;
        entry.responseUrl = response.url;
        entry.durationMs = Date.now() - startedAt;
        entry.responseHeaders = Array.from(response.headers.entries());
        response.clone().text().then(function(text) {
          entry.responseBody = trimBody(text);
          entry.responseBodyTruncated = typeof text === "string" && text.length > 200000;
        }).catch(function(error) { entry.responseBodyError = error ? error.message : String(error); });
        return response;
      } catch (error) {
        entry.error = error ? error.message : String(error);
        entry.durationMs = Date.now() - startedAt;
        throw error;
      }
    };
    wrappedFetch.__piChromeWrapped = true;
    window.fetch = wrappedFetch;
  }
  if (window.XMLHttpRequest && !XMLHttpRequest.prototype.open.__piChromeWrapped) {
    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__piChromeRequest = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open.__piChromeWrapped = true;
    XMLHttpRequest.prototype.send = function(body) {
      var id = "req-" + state.nextRequestId++;
      var startedAt = Date.now();
      var info = this.__piChromeRequest || {};
      var entry = record({ id: id, type: "xhr", method: info.method || "GET", url: info.url || "", startedAt: startedAt, pageUrl: location.href, status: "pending" });
      this.addEventListener("loadend", function() {
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.responseUrl = this.responseURL;
        entry.durationMs = Date.now() - startedAt;
        try { entry.responseHeadersText = this.getAllResponseHeaders(); } catch (e) {}
        try {
          if (typeof this.responseText === "string") {
            entry.responseBody = trimBody(this.responseText);
            entry.responseBodyTruncated = this.responseText.length > 200000;
          }
        } catch (error) { entry.responseBodyError = error ? error.message : String(error); }
      });
      this.addEventListener("error", function() { entry.error = "XMLHttpRequest error"; entry.durationMs = Date.now() - startedAt; });
      return originalSend.apply(this, arguments);
    };
  }
  state.instrumentationInstalled = true;
}

function probePage() {
  // Sanity probe used by /chrome-doctor. Returns evidence that MAIN-world execution works.
  return {
    arithmetic: 1 + 1,
    location: location.href,
    title: document.title,
    documentReady: document.readyState,
    userAgent: navigator.userAgent.slice(0, 200),
    webdriver: !!navigator.webdriver,
  };
}

function captureFullPageTiles(maxTiles) {
  // Returns the *plan* for tile capture; the actual chrome.tabs.captureVisibleTab calls happen
  // in the SW. We just report the scroll positions and metrics. `maxTiles` caps pathological
  // pages (screenshot-tiles) so a 100k-px document does not produce an unbounded tile list.
  const html = document.documentElement;
  const body = document.body;
  const width = Math.max(html.scrollWidth, body ? body.scrollWidth : 0, innerWidth);
  const height = Math.max(html.scrollHeight, body ? body.scrollHeight : 0, innerHeight);
  const viewportHeight = innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const originalScrollY = scrollY;
  const cap = Number.isFinite(maxTiles) && maxTiles > 0 ? Math.floor(maxTiles) : 30;
  const tiles = [];
  let y = 0;
  while (y < height && tiles.length < cap) {
    tiles.push({ y, scrollY: y });
    y += viewportHeight;
  }
  return { width, height, viewportHeight, dpr, originalScrollY, tiles, tilesTruncated: tiles.length < Math.ceil(height / viewportHeight) };
}

function scrollToY(y) {
  window.scrollTo({ top: y, left: 0, behavior: "instant" });
  return { scrollY };
}

// MAIN-world web-storage accessors (feat-storage), run via executeInTab in the resolved tab.
// Each returns location.origin so the SW reports which origin the entries belong to.
function piWebStorageList(store) {
  const s = store === "sessionStorage" ? window.sessionStorage : window.localStorage;
  const entries = [];
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (key === null) continue;
    entries.push({ key, value: s.getItem(key) });
  }
  return { origin: location.origin, entries };
}

function piWebStorageGet(store, key) {
  const s = store === "sessionStorage" ? window.sessionStorage : window.localStorage;
  const value = s.getItem(key);
  return { origin: location.origin, key, value, exists: value !== null };
}

function piWebStorageSet(store, key, value) {
  const s = store === "sessionStorage" ? window.sessionStorage : window.localStorage;
  s.setItem(key, String(value));
  return { origin: location.origin, key, ok: true };
}

function piWebStorageDelete(store, key) {
  const s = store === "sessionStorage" ? window.sessionStorage : window.localStorage;
  const existed = s.getItem(key) !== null;
  s.removeItem(key);
  return { origin: location.origin, key, ok: true, existed };
}

function piWebStorageClear(store) {
  const s = store === "sessionStorage" ? window.sessionStorage : window.localStorage;
  const cleared = s.length;
  s.clear();
  return { origin: location.origin, cleared };
}

function resolvePoint(selector, uid, x, y) {
  const element = elementBySelectorOrUid(selector, uid);
  if (element) {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    return { element, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
  }
  if (typeof x !== "number" || typeof y !== "number") throw new Error("Provide selector, uid, or x/y");
  return { element: document.elementFromPoint(x, y), x, y, rect: undefined };
}

async function clickPage(selector, uid, x, y) {
  installPiChromeInstrumentation();
  const before = pageHash();
  const point = resolvePoint(selector, uid, x, y);
  if (!point.element) throw new Error("No element at click point");
  const clickPoint = humanClickPoint(point);
  point.x = clickPoint.x;
  point.y = clickPoint.y;
  point.element = document.elementFromPoint(point.x, point.y) || point.element;
  const visible = isElementVisible(point.element);
  const occluded = occluderAt(point.x, point.y, point.element);
  let defaultPrevented = await humanMoveTo(point.x, point.y);
  const state = getPiChromeState();
  const prevX = state.pointer?.x;
  const prevY = state.pointer?.y;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "pointerdown", point.x, point.y, prevX, prevY, { pressure: 0.5 }) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "mousedown", point.x, point.y, prevX, prevY) || defaultPrevented;
  if (typeof point.element.focus === "function" && /^(A|BUTTON|INPUT|TEXTAREA|SELECT|SUMMARY)$/.test(point.element.tagName)) {
    try { point.element.focus({ preventScroll: true }); } catch { try { point.element.focus(); } catch {} }
  }
  await sleepPage(window.__piChromeHelpers.rand(45, 140));
  defaultPrevented = dispatchPointerLikeEvent(point.element, "pointerup", point.x, point.y, prevX, prevY) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "mouseup", point.x, point.y, prevX, prevY) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "click", point.x, point.y, prevX, prevY) || defaultPrevented;
  state.pointer = { x: point.x, y: point.y, t: performance.now() };
  // Heuristic: if the clicked thing looks like a media play affordance and the page has paused
  // audio/video, the DOM-event click may not unlock autoplay. Surface a warning.
  let autoplayHint;
  const labelRaw = (point.element.getAttribute("aria-label") || point.element.textContent || "").trim();
  const label = labelRaw.toLowerCase();
  if (/^(play|start|begin|next|continue|unmute)/.test(label)) {
    const idleMedia = Array.from(document.querySelectorAll("audio,video")).some((m) => m.paused);
    if (idleMedia) autoplayHint = "This element looks like a media affordance and the page has paused media. DOM-event clicks do not satisfy user-activation gates; audio/video may not start.";
  }
  const pageMutated = pageHash() !== before;
  // Smart-auto retry hint: only set when DOM-event path produced no observable change AND the
  // element looks gated, OR the page just emitted a user-activation rejection. The dispatcher
  // uses this to decide whether to retry with Chrome input.
  let suggestChromeInput = false;
  let suggestReason;
  if (!pageMutated) {
    if (autoplayHint) { suggestChromeInput = true; suggestReason = "play/media affordance + idle media"; }
    else if (/copy(\s|$)|paste|share|download|fullscreen|sign in with|continue with|allow|enable/i.test(label)) {
      suggestChromeInput = true; suggestReason = `label '${labelRaw.slice(0, 40)}' looks gated`;
    } else {
      // Inspect recent console errors for activation-gate rejections.
      const recent = (state.console || []).slice(-8);
      const hit = recent.find((e) => /NotAllowedError|Document is not focused|requires transient activation|gesture is required/.test(
        (e.args || []).map((a) => typeof a === "string" ? a : (a && a.message) || JSON.stringify(a)).join(" ")
      ));
      if (hit) { suggestChromeInput = true; suggestReason = "recent console error indicates user-activation gate"; }
    }
  }
  return {
    x: point.x,
    y: point.y,
    selector,
    uid,
    tag: point.element.tagName,
    label: labelRaw.slice(0, 80) || undefined,
    input: "dom",
    defaultPrevented,
    elementVisible: visible,
    occludedBy: occluded || undefined,
    pageMutated,
    autoplayHint,
    suggestChromeInput: suggestChromeInput || undefined,
    suggestReason,
  };
}

async function hoverPage(selector, uid, x, y) {
  installPiChromeInstrumentation();
  const point = resolvePoint(selector, uid, x, y);
  if (!point.element) throw new Error("No element to hover");
  await humanMoveTo(point.x, point.y);
  const state = getPiChromeState();
  const prevX = state.pointer?.x, prevY = state.pointer?.y;
  let defaultPrevented = false;
  for (const type of ["pointerover", "mouseover", "pointerenter", "mouseenter"]) {
    defaultPrevented = dispatchPointerLikeEvent(point.element, type, point.x, point.y, prevX, prevY) || defaultPrevented;
  }
  // Small dwell so hover-intent handlers fire.
  await sleepPage(window.__piChromeHelpers.rand(80, 220));
  return { x: point.x, y: point.y, selector, uid, tag: point.element.tagName, defaultPrevented, input: "dom" };
}

async function dragPage(fromUid, fromSelector, fromX, fromY, toUid, toSelector, toX, toY, steps) {
  installPiChromeInstrumentation();
  const before = pageHash();
  const from = resolvePoint(fromSelector, fromUid, fromX, fromY);
  const to = resolvePoint(toSelector, toUid, toX, toY);
  if (!from.element) throw new Error("Drag source element not found");
  if (!to.element) throw new Error("Drag target element not found");
  // Move to source.
  await humanMoveTo(from.x, from.y);
  const state = getPiChromeState();
  let prevX = state.pointer?.x, prevY = state.pointer?.y;
  // Build a shared DataTransfer so HTML5 drag-and-drop handlers can populate / read it.
  const dt = new DataTransfer();
  const dragInit = (type, target, x, y) => {
    const ev = new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y,
      screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0),
      button: 0, buttons: 1, view: window,
      dataTransfer: dt,
    });
    target.dispatchEvent(ev);
    return ev;
  };
  dispatchPointerLikeEvent(from.element, "pointerover", from.x, from.y, prevX, prevY);
  dispatchPointerLikeEvent(from.element, "pointerdown", from.x, from.y, prevX, prevY, { pressure: 0.5 });
  dispatchPointerLikeEvent(from.element, "mousedown", from.x, from.y, prevX, prevY);
  await sleepPage(window.__piChromeHelpers.rand(40, 110));
  dragInit("dragstart", from.element, from.x, from.y);
  dragInit("drag", from.element, from.x, from.y);
  let lastOver = from.element;
  const n = steps || 18;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 6;
    const x = from.x + (to.x - from.x) * ease + window.__piChromeHelpers.rand(-wobble, wobble);
    const y = from.y + (to.y - from.y) * ease + window.__piChromeHelpers.rand(-wobble, wobble);
    const overEl = document.elementFromPoint(x, y) || to.element;
    dispatchPointerLikeEvent(overEl, "pointermove", x, y, prevX, prevY);
    dispatchPointerLikeEvent(overEl, "mousemove", x, y, prevX, prevY);
    if (overEl !== lastOver) {
      dragInit("dragleave", lastOver, x, y);
      dragInit("dragenter", overEl, x, y);
      lastOver = overEl;
    }
    dragInit("dragover", overEl, x, y);
    dragInit("drag", from.element, x, y);
    prevX = x; prevY = y;
    await sleepPage(window.__piChromeHelpers.rand(8, 26));
  }
  dispatchPointerLikeEvent(to.element, "pointerover", to.x, to.y, prevX, prevY);
  dispatchPointerLikeEvent(to.element, "mouseover", to.x, to.y, prevX, prevY);
  dragInit("drop", to.element, to.x, to.y);
  dragInit("dragend", from.element, to.x, to.y);
  dispatchPointerLikeEvent(to.element, "pointerup", to.x, to.y, prevX, prevY);
  dispatchPointerLikeEvent(to.element, "mouseup", to.x, to.y, prevX, prevY);
  state.pointer = { x: to.x, y: to.y, t: performance.now() };
  return {
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    steps: n,
    pageMutated: pageHash() !== before,
    note: "DOM-event drag with HTML5 DragEvent + shared DataTransfer.",
  };
}

async function scrollPage(selector, uid, deltaY, deltaX, steps) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let target;
  if (selector || uid) {
    target = elementBySelectorOrUid(selector, uid);
  } else {
    target = document.scrollingElement || document.documentElement || document.body;
  }
  if (!target) throw new Error("No scroll target");
  const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  const cx = Math.max(0, Math.min(innerWidth - 1, rect.left + Math.min(rect.width, innerWidth) / 2));
  const cy = Math.max(0, Math.min(innerHeight - 1, rect.top + Math.min(rect.height, innerHeight) / 2));
  const n = Math.max(3, Math.min(40, steps || Math.max(3, Math.ceil(Math.abs(deltaY || 0) / 100))));
  // Front-loaded wheel deltas, momentum-style.
  const totalY = deltaY || 0;
  const totalX = deltaX || 0;
  const weights = [];
  for (let i = 1; i <= n; i++) weights.push(1 / i);
  const sumW = weights.reduce((a, b) => a + b, 0);
  let movedY = 0, movedX = 0;
  for (let i = 0; i < n; i++) {
    const dy = totalY * (weights[i] / sumW);
    const dx = totalX * (weights[i] / sumW);
    const ev = new WheelEvent("wheel", {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy,
      deltaX: dx, deltaY: dy, deltaMode: 0,
    });
    target.dispatchEvent(ev);
    if (!ev.defaultPrevented) {
      // Apply scroll ourselves; mirrors what the browser would do.
      if (target === document.scrollingElement || target === document.documentElement || target === document.body) {
        window.scrollBy({ left: dx, top: dy, behavior: "instant" });
      } else {
        target.scrollTop += dy;
        target.scrollLeft += dx;
      }
    }
    movedY += dy; movedX += dx;
    await sleepPage(window.__piChromeHelpers.rand(12, 28));
  }
  return {
    deltaX: movedX, deltaY: movedY, steps: n,
    scrollTop: target.scrollTop, scrollLeft: target.scrollLeft,
    pageMutated: pageHash() !== before,
    input: "dom",
  };
}

function uploadFiles(selector, uid, files) {
  installPiChromeInstrumentation();
  const element = elementBySelectorOrUid(selector, uid);
  if (!element || element.tagName !== "INPUT" || element.type !== "file") {
    throw new Error("Target must be <input type=file>");
  }
  const dt = new DataTransfer();
  for (const f of files) {
    const bytes = Uint8Array.from(atob(f.base64 || ""), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], f.name, { type: f.type || "application/octet-stream" }));
  }
  element.files = dt.files;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { uploaded: files.map((f) => ({ name: f.name, type: f.type, size: (f.base64 || "").length })) };
}

function dispatchInputEvents(element, data, inputType = "insertText") {
  element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data }));
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeValue(element, value) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
}

function printableKeyCode(ch) {
  return ch.length === 1 ? usKeyLayoutForChar(ch).keyCode : 0;
}

function dispatchKeyEvent(element, type, key, mods = {}) {
  const SPECIAL = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, " ": 32, Shift: 16, Control: 17, Alt: 18, Meta: 91 };
  const code = key.length === 1 ? usKeyLayoutForChar(key).code : (key === " " ? "Space" : key);
  const keyCode = key.length === 1 ? printableKeyCode(key) : (SPECIAL[key] ?? 0);
  const ev = new KeyboardEvent(type, {
    key,
    code,
    keyCode,
    which: keyCode,
    charCode: type === "keypress" && key.length === 1 ? key.charCodeAt(0) : 0,
    shiftKey: !!mods.shiftKey,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    metaKey: !!mods.metaKey,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
  });
  element.dispatchEvent(ev);
  return ev;
}

async function typeCharacter(element, ch) {
  const needShift = ch.length === 1 && (/^[A-Z]$/.test(ch) || "~!@#$%^&*()_+{}|:\"<>?".includes(ch));
  if (needShift) {
    dispatchKeyEvent(element, "keydown", "Shift", { shiftKey: true });
    await sleepPage(window.__piChromeHelpers.rand(8, 24));
  }
  const mods = { shiftKey: needShift };
  const down = dispatchKeyEvent(element, "keydown", ch, mods);
  if (down.defaultPrevented) {
    if (needShift) dispatchKeyEvent(element, "keyup", "Shift", { shiftKey: false });
    return { defaultPrevented: true };
  }
  if (ch.length === 1) dispatchKeyEvent(element, "keypress", ch, mods);

  if (element.isContentEditable) {
    // execCommand("insertText") fires its own beforeinput + input. Don't double-dispatch.
    document.execCommand("insertText", false, ch);
  } else if ("value" in element) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    const next = element.value.slice(0, start) + ch + element.value.slice(end);
    const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ch });
    element.dispatchEvent(before);
    if (!before.defaultPrevented) {
      setNativeValue(element, next);
      try { element.selectionStart = element.selectionEnd = start + ch.length; } catch {}
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
    }
  } else {
    throw new Error("Focused element is not text-editable");
  }

  await sleepPage(window.__piChromeHelpers.rand(25, 95));
  dispatchKeyEvent(element, "keyup", ch, mods);
  if (needShift) {
    await sleepPage(window.__piChromeHelpers.rand(5, 18));
    dispatchKeyEvent(element, "keyup", "Shift", { shiftKey: false });
  }
  await sleepPage(window.__piChromeHelpers.rand(35, 140));
  return { defaultPrevented: false };
}

async function typeIntoPage(selector, uid, text, pressEnter) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let element = elementBySelectorOrUid(selector, uid) || document.activeElement;
  if (!element) throw new Error(selector || uid ? `No element for ${selector || uid}` : "No active element");
  const initialValue = "value" in element ? element.value : (element.isContentEditable ? element.textContent : null);
  element.focus();
  if (!(element.isContentEditable || "value" in element)) throw new Error("Focused element is not text-editable");
  for (const ch of Array.from(text)) await window.__piChromeHelpers.typeCharacter(element, ch);
  if (pressEnter) await pressKeyInPage("Enter");
  const finalValue = "value" in element ? element.value : element.textContent;
  const valueMatches = "value" in element ? element.value.includes(text) : (element.textContent || "").includes(text);
  const pageMutated = pageHash() !== before;
  // Smart-auto retry hint when typing didn't land at all (e.g., editor blocks DOM-event input).
  let suggestChromeInput = false, suggestReason;
  if (text.length > 0 && initialValue === finalValue) {
    suggestChromeInput = true;
    suggestReason = "value did not change — editor likely rejects DOM-event input";
  }
  return {
    selector, uid, length: text.length, pressEnter,
    input: "dom",
    valueMatches,
    pageMutated,
    suggestChromeInput: suggestChromeInput || undefined,
    suggestReason,
  };
}

async function fillPage(selector, uid, text, submit) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let element = elementBySelectorOrUid(selector, uid) || document.activeElement;
  if (!element) throw new Error(selector || uid ? `No element for ${selector || uid}` : "No active element");
  element.focus();
  if (element.isContentEditable) {
    element.textContent = "";
    document.execCommand("insertText", false, text);
  } else if ("value" in element) {
    setNativeValue(element, text);
    const length = String(text).length;
    try { element.selectionStart = element.selectionEnd = length; } catch {}
    dispatchInputEvents(element, text, "insertReplacementText");
  } else {
    throw new Error("Focused element is not text-editable");
  }
  if (submit) await pressKeyInPage("Enter");
  return {
    selector, uid, length: String(text).length, submit,
    input: "dom",
    valueMatches: "value" in element ? element.value === String(text) : undefined,
    pageMutated: pageHash() !== before,
  };
}

async function pressKeyInPage(key) {
  const normalized = normalizeKey(key);
  const target = document.activeElement || document.body;
  const before = pageHash();
  const down = dispatchKeyEvent(target, "keydown", normalized);
  if (normalized.length === 1) dispatchKeyEvent(target, "keypress", normalized);
  // Character insertion for printable keys when focus is in an editable.
  if (normalized.length === 1 && !down.defaultPrevented && (target.isContentEditable || ("value" in target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")))) {
    if (target.isContentEditable) {
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: normalized });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        document.execCommand("insertText", false, normalized);
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: normalized }));
      }
    } else {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: normalized });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        setNativeValue(target, target.value.slice(0, start) + normalized + target.value.slice(end));
        try { target.selectionStart = target.selectionEnd = start + 1; } catch {}
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: normalized }));
      }
    }
  } else if (normalized === "Backspace" && "value" in target) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    if (start > 0 || end > start) {
      const from = start === end ? start - 1 : start;
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        setNativeValue(target, target.value.slice(0, from) + target.value.slice(end));
        try { target.selectionStart = target.selectionEnd = from; } catch {}
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      }
    }
  }
  await sleepPage(window.__piChromeHelpers.rand(25, 95));
  const up = dispatchKeyEvent(target, "keyup", normalized);
  if (normalized === "Enter") {
    const form = target.closest?.("form");
    if (form) form.requestSubmit?.();
  }
  return {
    key: normalized,
    input: "dom",
    defaultPrevented: down.defaultPrevented || up.defaultPrevented,
    pageMutated: pageHash() !== before,
  };
}

function listConsoleMessages(clear) {
  window.__piChromeHelpers.installPiChromeInstrumentation();
  const state = window.__piChromeHelpers.getPiChromeState();
  const messages = state.console.slice();
  if (clear) state.console = [];
  return { messages, count: messages.length };
}

function listNetworkRequests(includePreservedRequests, clear) {
  window.__piChromeHelpers.installPiChromeInstrumentation();
  const state = window.__piChromeHelpers.getPiChromeState();
  const currentUrl = location.href;
  const requests = state.network
    .filter((request) => includePreservedRequests || request.pageUrl === currentUrl)
    .map(({ responseBody, ...summary }) => ({ ...summary, hasResponseBody: responseBody !== undefined }));
  if (clear) state.network = [];
  return {
    requests,
    count: requests.length,
    note: "In-page fetch/XHR capture. For document/static requests, enable chrome_network_capture (CDP Network domain) and read the returned cdpEntries.",
  };
}

function getNetworkRequest(requestId) {
  window.__piChromeHelpers.installPiChromeInstrumentation();
  const request = window.__piChromeHelpers.getPiChromeState().network.find((entry) => entry.id === requestId);
  if (!request) throw new Error(`No network request with id ${requestId}`);
  return request;
}

// =================== chrome_downloads (feat-downloads) ===================
// Browser-global download tracking: chrome.downloads.search + onChanged. The final `filename` is
// the resolved absolute filesystem path (Chrome rewrites it on auto-rename), which is what makes
// a 'click Export CSV' workflow observable to the agent.
function summarizeDownload(item) {
  return {
    id: item.id,
    finalPath: item.filename || null,
    url: item.url || null,
    state: item.state || "in_progress",
    mime: item.mime || null,
    bytesReceived: typeof item.bytesReceived === "number" ? item.bytesReceived : null,
    totalBytes: typeof item.totalBytes === "number" ? item.totalBytes : null,
    error: item.error || null,
    danger: item.danger || null,
    startedAt: item.startTime || null,
    endedAt: item.endTime || null,
    exists: typeof item.exists === "boolean" ? item.exists : null,
  };
}

function downloadsSearchQuery(params) {
  const query = {};
  if (params.id !== undefined) query.id = Number(params.id);
  if (params.filenameRegex) query.filenameRegex = params.filenameRegex;
  if (params.urlRegex) query.urlRegex = params.urlRegex;
  if (params.state) query.state = params.state;
  if (typeof params.limit === "number" && params.limit > 0) query.limit = params.limit;
  return query;
}

function downloadMatches(params, item, initialIds) {
  if (params.id !== undefined && item.id !== Number(params.id)) return false;
  if (params.filenameRegex) {
    try { if (!new RegExp(params.filenameRegex).test(item.filename || "")) return false; }
    catch { return false; }
  }
  if (params.urlRegex) {
    try { if (!new RegExp(params.urlRegex).test(item.url || "")) return false; }
    catch { return false; }
  }
  if (params.onlyNew === true && initialIds && initialIds.has(item.id)) return false;
  return true;
}

async function listDownloads(params) {
  const items = await chrome.downloads.search(downloadsSearchQuery(params));
  const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 200) : 50;
  const sorted = [...items].sort((a, b) => (b.startTime || "").localeCompare(a.startTime || ""));
  const active = sorted.filter((item) => item.state === "in_progress");
  return {
    downloads: sorted.slice(0, limit).map(summarizeDownload),
    count: items.length,
    inProgress: active.length,
  };
}

async function waitForDownload(params) {
  const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || DOWNLOAD_WAIT_DEFAULT_MS, 1000), DOWNLOAD_WAIT_MAX_MS);
  const started = Date.now();
  const initialIds = new Set((await chrome.downloads.search({}).catch(() => [])).map((item) => item.id));
  const settled = (item) => item.state === "complete" || item.state === "interrupted";
  // Suppress the download shelf for non-focus runs so a headless-ish session does not poke a
  // visible download bar; best-effort.
  if (params.foreground !== true) {
    try { await chrome.downloads.setShelfBehavior({ behavior: "suppress" }); } catch {}
  }
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer = null;
    let poller = null;
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poller);
      if (chrome.downloads.onChanged) chrome.downloads.onChanged.removeListener(check);
    };
    const check = async () => {
      if (finished) return;
      let items = [];
      try { items = await chrome.downloads.search({}); } catch { return; }
      const done = items.filter((item) => downloadMatches(params, item, initialIds) && settled(item));
      if (!done.length) return;
      finished = true;
      cleanup();
      resolve({
        downloads: done.map(summarizeDownload),
        elapsedMs: Date.now() - started,
        newDownload: done.some((item) => !initialIds.has(item.id)),
      });
    };
    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error(`downloads.wait timed out after ${timeoutMs}ms; no matching download settled`));
    }, timeoutMs);
    // Poll (keeps the MV3 worker alive during long waits) + onChanged for prompt completion.
    poller = setInterval(() => void check(), 500);
    if (chrome.downloads.onChanged) chrome.downloads.onChanged.addListener(check);
    void check();
  });
}

async function clearDownloads(params) {
  const items = await chrome.downloads.search(downloadsSearchQuery(params));
  let removed = 0;
  let removedFiles = 0;
  for (const item of items) {
    if (params.removeFiles === true) {
      try { await chrome.downloads.removeFile(item.id); removedFiles++; } catch {}
    }
    try { await chrome.downloads.erase(item.id); removed++; } catch {}
  }
  return { removed, removedFiles, matched: items.length };
}

// =================== chrome_dialog (feat-dialog) ===================
// Handles a JavaScript dialog (alert/confirm/prompt/beforeunload) surfaced by the Page domain of
// the attached debugger. The global onEvent listener records every dialog opening; this resolves
// the recorded entry when one already matches, otherwise arms a waiter for the next event.
async function handleDialogCommand(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  try { await cdp(tab.id, "Page.enable"); } catch {}
  const wantedType = params.type && params.type !== "any" ? String(params.type) : null;
  const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 10000, 1000), 60000);
  const matches = (info) => info && info.tabId === tab.id && (!wantedType || info.dialogType === wantedType);

  const existing = Array.from(pendingDialogs.values()).find(matches);
  if (existing) {
    pendingDialogs.delete(tab.id);
    return handleDialogNow(tab.id, existing, params);
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    let cleanup = () => {
      clearTimeout(timer);
      dialogWaiters.delete(tab.id);
      if (chrome.debugger.onEvent) chrome.debugger.onEvent.removeListener(listener);
    };
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error(`chrome_dialog: no ${params.type || "any"} dialog appeared in tab ${tab.id} within ${timeoutMs}ms`));
    }, timeoutMs);
    const listener = (source, method, eventParams) => {
      if (source.tabId !== tab.id || method !== "Page.javascriptDialogOpening") return;
      const info = pendingDialogs.get(tab.id);
      if (!matches(info)) return;
      finished = true;
      pendingDialogs.delete(tab.id);
      cleanup();
      void handleDialogNow(tab.id, info, params).then(resolve, reject);
    };
    dialogWaiters.add(tab.id);
    // Re-check after arming in case a dialog opened between the first scan and listener install.
    const late = Array.from(pendingDialogs.values()).find(matches);
    if (late) {
      pendingDialogs.delete(tab.id);
      cleanup();
      void handleDialogNow(tab.id, late, params).then(resolve, reject);
      return;
    }
    if (chrome.debugger.onEvent) chrome.debugger.onEvent.addListener(listener);
    // Blind-handle fallback: if the dialog was already open when the debugger attached, Chrome may
    // not re-report it as an event. Probe once with Page.handleJavaScriptDialog after a short
    // grace; it errors harmlessly when no dialog is showing, and we keep waiting for events.
    const probeTimer = setTimeout(() => {
      if (finished) return;
      void cdp(tab.id, "Page.handleJavaScriptDialog", { accept: params.accept !== false, ...(params.promptText !== undefined && params.accept !== false ? { promptText: String(params.promptText) } : {}) })
        .then(() => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve({
            handled: true,
            dialogType: params.type && params.type !== "any" ? params.type : "unknown",
            message: "(dialog already open when the debugger attached)",
            url: "",
            defaultPrompt: "",
            accept: params.accept !== false,
            promptText: params.promptText !== undefined ? String(params.promptText) : null,
            source: "blind-handle",
          });
        })
        .catch(() => { /* no dialog showing — keep waiting */ });
    }, 1500);
    const originalCleanup = cleanup;
    cleanup = () => {
      clearTimeout(probeTimer);
      originalCleanup();
    };
  });
}

async function handleDialogNow(tabId, info, params) {
  const accept = params.accept !== false; // default: accept (OK)
  const promptText = accept && params.promptText !== undefined ? String(params.promptText) : undefined;
  const commandParams = { accept };
  if (promptText !== undefined) commandParams.promptText = promptText;
  await cdp(tabId, "Page.handleJavaScriptDialog", commandParams);
  return {
    handled: true,
    dialogType: info.dialogType,
    message: info.message,
    url: info.url,
    defaultPrompt: info.defaultPrompt,
    accept,
    promptText: promptText ?? null,
  };
}

// =================== chrome_emulate (feat-emulate) ===================
// Device metrics / UA / touch emulation via CDP Emulation.* on the session automation tab.
// Emulation overrides live on the CDP target, so after `set` we register MODE_EMULATE (extends
// the attach keepalive + persists intent + re-applies on re-attach) and remember the state so
// `clear` (or a re-attach) can reset it. Extracted apply/clear helpers are the re-apply hooks.
//
// P0 extension (TOOL_CONTRACTS §5.6): locale / timezone / geolocation / idle overrides ride the
// same `page.emulate` wire kind and the same emulatedTabs record (as `env`), so `clear` resets
// the whole emulation surface. Media-feature emulation (chrome_emulate_media) is a sibling
// handler on the same kind, dispatched by `emulationScope:"media"` (host sets it).
async function chromeEmulate(params) {
  const tab = await getTabByParams(params);
  await attachDebugger(tab.id);
  if (params.emulationScope === "media") return chromeEmulateMedia(params, tab);
  if (params.action === "clear") {
    await clearEmulationOverrides(tab.id, params);
    await clearEnvOverrides(tab.id);
    const record = emulatedTabs.get(tab.id);
    if (record) delete record.env;
    if (record && !record.media && record.cpuThrottleRate === undefined) emulatedTabs.delete(tab.id);
    unregisterMode(tab.id, MODE_EMULATE);
    return { action: "clear", cleared: true };
  }
  const width = Math.max(200, Math.round(Number(params.width) || 1280));
  const height = Math.max(200, Math.round(Number(params.height) || 800));
  const deviceScaleFactor = Math.max(0.5, Number(params.deviceScaleFactor) || 1);
  const mobile = params.mobile === true;
  // Touch emulation is ON by default when setting metrics: the touch benchmark requires real
  // TouchEvents, which the renderer only synthesizes while touch emulation is enabled.
  const touch = params.touch !== false;
  const overrides = {
    width, height, deviceScaleFactor, mobile, touch,
    ua: params.ua ? String(params.ua) : null,
    platform: params.platform ? String(params.platform) : null,
    acceptLanguage: params.acceptLanguage ? String(params.acceptLanguage) : null,
  };
  const env = envOverridesFromParams(params);
  if (env) overrides.env = env;
  await applyEmulationOverrides(tab.id, overrides);
  const record = emulatedTabs.get(tab.id) || {};
  Object.assign(record, overrides);
  emulatedTabs.set(tab.id, record);
  registerMode(tab.id, MODE_EMULATE);
  return {
    action: "set", width, height, deviceScaleFactor, mobile, touch,
    ua: params.ua ? String(params.ua) : null,
    overrides: env || null,
  };
}

// Extract the env-override slice (locale/timezone/geolocation/idle) from page.emulate params,
// or null when none of the keys are present. Shared by chromeEmulate set and its re-apply path.
function envOverridesFromParams(params) {
  const env = {};
  if (params.locale !== undefined && params.locale !== null && params.locale !== "") env.locale = String(params.locale);
  if (params.timezoneId !== undefined && params.timezoneId !== null && params.timezoneId !== "") env.timezoneId = String(params.timezoneId);
  if (params.geolocation && typeof params.geolocation === "object") {
    const lat = Number(params.geolocation.latitude);
    const lon = Number(params.geolocation.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      env.geolocation = { latitude: lat, longitude: lon, accuracy: Number(params.geolocation.accuracy) || 0 };
    }
  }
  if (params.idle && typeof params.idle === "object") {
    if (typeof params.idle.isUserActive === "boolean" && typeof params.idle.isScreenUnlocked === "boolean") {
      env.idle = { isUserActive: params.idle.isUserActive, isScreenUnlocked: params.idle.isScreenUnlocked };
    }
  }
  return Object.keys(env).length ? env : null;
}

// Apply a full emulation override snapshot (used by chromeEmulate set AND the M0 re-apply hook).
// The snapshot may carry the media slice + env overrides; apply those too so a re-attach restores
// the entire emulation surface in one pass.
async function applyEmulationOverrides(tabId, o) {
  if (!o || typeof o !== "object") return;
  await cdp(tabId, "Emulation.setDeviceMetricsOverride", {
    width: o.width || 1280, height: o.height || 800,
    deviceScaleFactor: o.deviceScaleFactor || 1, mobile: o.mobile === true,
    screenWidth: o.width || 1280, screenHeight: o.height || 800,
    positionX: 0, positionY: 0,
  });
  if (o.ua) {
    await cdp(tabId, "Emulation.setUserAgentOverride", {
      userAgent: String(o.ua),
      ...(o.platform ? { platform: String(o.platform) } : {}),
      ...(o.acceptLanguage ? { acceptLanguage: String(o.acceptLanguage) } : {}),
    });
    await cdp(tabId, "Network.setUserAgentOverride", { userAgent: String(o.ua) }).catch(() => undefined);
  }
  await cdp(tabId, "Emulation.setTouchEmulationEnabled", { enabled: o.touch !== false, maxTouchPoints: o.touch !== false ? 5 : 1 });
  if (o.media && typeof o.media === "object") {
    await applyMediaOverrides(tabId, o.media, o.cpuThrottleRate);
  }
  if (o.env && typeof o.env === "object") {
    await applyEnvOverrides(tabId, o.env);
  }
}

// Reset emulation overrides. Preserves the legacy chromeEmulate clear semantics: a `ua` passed
// alongside clear re-applies a UA override after metrics are reset. Media/env overrides are NOT
// reset here — chrome_emulate_media has its own action=clear and env clears on chrome_emulate
// clear (they live on the same record).
async function clearEmulationOverrides(tabId, params) {
  await cdp(tabId, "Emulation.clearDeviceMetricsOverride").catch(() => undefined);
  await cdp(tabId, "Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => undefined);
  if (params && params.ua) {
    try {
      await cdp(tabId, "Emulation.setUserAgentOverride", { userAgent: String(params.ua) });
      await cdp(tabId, "Network.setUserAgentOverride", { userAgent: String(params.ua) }).catch(() => undefined);
    } catch {}
  }
}

// =================== chrome_emulate_media (P0, TOOL_CONTRACTS §5.5) ===================
// Media-feature emulation (prefers-color-scheme / reduced-motion / forced-colors / contrast /
// print / vision deficiency / auto-dark / focus) plus CPU throttling. Lives on the shared
// `page.emulate` wire kind (emulationScope:"media") and the shared emulatedTabs record; CDP
// Emulation.setCPUThrottlingRate is version-dependent so it degrades to a no-op when absent.
const MEDIA_FEATURE_KEYS = ["colorScheme", "reducedMotion", "forcedColors", "prefersContrast", "prefersReducedData"];
const VISION_DEFICIENCY_VALUES = new Set(["none", "achromatopsia", "blurredVision", "deuteranopia", "protanopia", "tritanopia"]);

async function chromeEmulateMedia(params, tab) {
  const tabId = tab.id;
  if (params.action === "clear") {
    await clearMediaOverrides(tabId);
    const record = emulatedTabs.get(tabId);
    if (record) {
      delete record.media;
      delete record.cpuThrottleRate;
      if (!record.width && !record.env) emulatedTabs.delete(tabId);
    }
    unregisterMode(tabId, MODE_MEDIA);
    return { action: "clear", media: {}, cpuThrottleRate: null, cleared: true };
  }
  const media = {};
  for (const key of MEDIA_FEATURE_KEYS) {
    if (params[key] !== undefined && params[key] !== null) media[key] = String(params[key]);
  }
  if (params.print === "emulate" || params.print === "no-override") media.print = String(params.print);
  if (params.visionDeficiency && VISION_DEFICIENCY_VALUES.has(String(params.visionDeficiency)) && String(params.visionDeficiency) !== "none") {
    media.visionDeficiency = String(params.visionDeficiency);
  }
  if (params.focusEmulation !== undefined) media.focusEmulation = params.focusEmulation === true;
  if (params.autoDarkMode !== undefined) media.autoDarkMode = params.autoDarkMode === true;
  const cpuThrottleRate = typeof params.cpuThrottleRate === "number" ? params.cpuThrottleRate : undefined;
  const record = emulatedTabs.get(tabId) || {};
  if (Object.keys(media).length) record.media = media;
  else delete record.media;
  if (cpuThrottleRate !== undefined) record.cpuThrottleRate = cpuThrottleRate;
  emulatedTabs.set(tabId, record);
  await applyMediaOverrides(tabId, media, cpuThrottleRate);
  registerMode(tabId, MODE_MEDIA);
  return { action: "set", media, cpuThrottleRate: cpuThrottleRate ?? null };
}

// Apply a media-feature snapshot (chrome_emulate_media set + MODE_MEDIA re-apply). Emulation.setEmulatedMedia
// always carries the full feature list, so clearing one key means re-sending the remaining set.
async function applyMediaOverrides(tabId, media, cpuThrottleRate) {
  if (!media || typeof media !== "object") media = {};
  const features = [];
  for (const key of MEDIA_FEATURE_KEYS) {
    if (media[key] && media[key] !== "no-preference") features.push({ name: key, value: String(media[key]) });
  }
  if (media.print === "emulate") features.push({ name: "print", value: "" });
  await cdp(tabId, "Emulation.setEmulatedMedia", { features }).catch(() => undefined);
  if (typeof media.autoDarkMode === "boolean") {
    await cdp(tabId, "Emulation.setAutoDarkModeOverride", { enabled: media.autoDarkMode }).catch(() => undefined);
  }
  if (typeof media.focusEmulation === "boolean") {
    await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: media.focusEmulation }).catch(() => undefined);
  }
  if (media.visionDeficiency && VISION_DEFICIENCY_VALUES.has(String(media.visionDeficiency))) {
    await cdp(tabId, "Emulation.setEmulatedVisionDeficiency", { type: String(media.visionDeficiency) }).catch(() => undefined);
  }
  if (typeof cpuThrottleRate === "number" && cpuThrottleRate >= 1) {
    await cdp(tabId, "Emulation.setCPUThrottlingRate", { rate: cpuThrottleRate }).catch(() => undefined);
  }
}

async function clearMediaOverrides(tabId) {
  await cdp(tabId, "Emulation.setEmulatedMedia", { features: [] }).catch(() => undefined);
  await cdp(tabId, "Emulation.setAutoDarkModeOverride", { enabled: false }).catch(() => undefined);
  await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined);
  await cdp(tabId, "Emulation.setEmulatedVisionDeficiency", { type: "none" }).catch(() => undefined);
  await cdp(tabId, "Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => undefined);
}

// =================== env overrides (chrome_emulate P0 extension) ===================
// locale / timezone / geolocation / idle ride Emulation.* and die with the attach, so the SW
// stores them in the emulatedTabs record and re-applies them on re-attach (MODE_EMULATE).
// Emulation.setIdleOverride is version-dependent — degrade to a no-op when the target lacks it.
async function applyEnvOverrides(tabId, env) {
  if (!env || typeof env !== "object") return;
  if (typeof env.locale === "string" && env.locale) {
    await cdp(tabId, "Emulation.setLocaleOverride", { locale: env.locale }).catch(() => undefined);
  }
  if (typeof env.timezoneId === "string" && env.timezoneId) {
    await cdp(tabId, "Emulation.setTimezoneOverride", { timezoneId: env.timezoneId }).catch(() => undefined);
  }
  if (env.geolocation && typeof env.geolocation === "object") {
    await cdp(tabId, "Emulation.setGeolocationOverride", {
      latitude: Number(env.geolocation.latitude) || 0,
      longitude: Number(env.geolocation.longitude) || 0,
      accuracy: Number(env.geolocation.accuracy) || 0,
    }).catch(() => undefined);
  }
  if (env.idle && typeof env.idle === "object") {
    await cdp(tabId, "Emulation.setIdleOverride", {
      isUserActive: env.idle.isUserActive === true,
      isScreenUnlocked: env.idle.isScreenUnlocked === true,
    }).catch(() => undefined);
  }
}

async function clearEnvOverrides(tabId) {
  await cdp(tabId, "Emulation.setLocaleOverride", { locale: "" }).catch(() => undefined);
  await cdp(tabId, "Emulation.setTimezoneOverride", { timezoneId: "" }).catch(() => undefined);
  await cdp(tabId, "Emulation.clearGeolocationOverride", {}).catch(() => undefined);
  await cdp(tabId, "Emulation.clearIdleOverride", {}).catch(() => undefined);
}

// =================== chrome_storage (feat-storage) ===================
// Cookie / web-storage / IndexedDB read-write plus auth-state detection. Wire action
// "storage.op" carries kind (cookies|localStorage|sessionStorage|indexedDB) and action
// (get|set|delete|clear|summary). Every response includes a compact `summary` whose values are
// always redacted; only `get` returns the raw values (unless redact=true suppresses them).
async function chromeStorage(params) {
  const kind = String(params.kind || "cookies");
  const action = String(params.action || "get");
  if (kind === "cookies") return cookieStorage(action, params);
  if (kind === "localStorage" || kind === "sessionStorage") return webStorageOperation(kind, action, params);
  if (kind === "indexedDB") return indexedDBOperation(action, params);
  throw new Error(`chrome_storage: unknown kind '${kind}' (use cookies, localStorage, sessionStorage, or indexedDB)`);
}

// Cookies are browser-global (no tab resolution), so cookie ops never create or touch a tab.
async function cookieStorage(action, params) {
  if (!chrome.cookies) throw new Error("chrome_storage: chrome.cookies API unavailable; reload the extension after granting the cookies permission");
  const filter = {};
  if (params.url !== undefined) filter.url = String(params.url);
  if (params.domain !== undefined) filter.domain = String(params.domain);
  if (params.name !== undefined) filter.name = String(params.name);
  const all = await chrome.cookies.getAll(filter);
  const cookieRecord = (c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
    session: c.session, expirationDate: c.expirationDate, storeId: c.storeId,
  });
  if (action === "get") {
    const cookies = all.map(cookieRecord);
    return { kind: "cookies", action, cookies, summary: cookieAuthSummary(all) };
  }
  if (action === "summary") {
    return { kind: "cookies", action, summary: cookieAuthSummary(all) };
  }
  if (action === "set") {
    if (params.name === undefined) throw new Error("chrome_storage cookies set requires name");
    if (params.value === undefined) throw new Error("chrome_storage cookies set requires value");
    let url = params.url !== undefined ? String(params.url) : null;
    if (!url && params.domain !== undefined) url = `https://${String(params.domain).replace(/^\./, "")}/`;
    if (!url) throw new Error("chrome_storage cookies set requires url (or domain)");
    const details = {
      url,
      name: String(params.name),
      value: String(params.value),
      path: params.path !== undefined ? String(params.path) : "/",
      secure: params.secure === true,
      httpOnly: params.httpOnly === true,
      sameSite: ["no_restriction", "lax", "strict", "unspecified"].includes(params.sameSite) ? params.sameSite : "unspecified",
    };
    if (params.domain !== undefined) details.domain = String(params.domain).replace(/^\./, "");
    if (params.expirationDate !== undefined) details.expirationDate = Number(params.expirationDate);
    const c = await chrome.cookies.set(details);
    if (!c) throw new Error("chrome_storage cookies set was rejected by Chrome");
    return { kind: "cookies", action, ok: true, cookie: cookieRecord(c) };
  }
  if (action === "delete") {
    if (params.name === undefined) throw new Error("chrome_storage cookies delete requires name");
    let url = params.url !== undefined ? String(params.url) : null;
    if (!url && params.domain !== undefined) url = `https://${String(params.domain).replace(/^\./, "")}/`;
    if (!url) throw new Error("chrome_storage cookies delete requires url (or domain)");
    const removed = await chrome.cookies.remove({ url, name: String(params.name) });
    return { kind: "cookies", action, ok: true, removed: removed !== null, name: String(params.name) };
  }
  if (action === "clear") {
    // chrome.cookies.remove matches on URL scheme: secure cookies only remove over https, so
    // try both schemes for non-secure cookies (feat-storage clear-all).
    let removed = 0;
    for (const c of all) {
      const host = c.domain.replace(/^\./, "");
      try { const r = await chrome.cookies.remove({ url: `https://${host}${c.path}`, name: c.name }); if (r !== null) removed++; } catch {}
      if (!c.secure) {
        try { const r = await chrome.cookies.remove({ url: `http://${host}${c.path}`, name: c.name }); if (r !== null) removed++; } catch {}
      }
    }
    return { kind: "cookies", action, ok: true, removed, matched: all.length, summary: cookieAuthSummary(all) };
  }
  throw new Error(`chrome_storage cookies: unsupported action ${action}`);
}

// Compact auth-state summary: origin list with cookie counts and cookie NAMES only — values are
// never included here (feat-storage redaction). A domain with session cookies reads as logged-in.
function cookieAuthSummary(cookies) {
  const byOrigin = new Map();
  for (const c of cookies) {
    const origin = c.domain || "(no domain)";
    let bucket = byOrigin.get(origin);
    if (!bucket) { bucket = { origin, cookieCount: 0, sessionCookieCount: 0, names: [] }; byOrigin.set(origin, bucket); }
    bucket.cookieCount++;
    if (c.session) bucket.sessionCookieCount++;
    if (bucket.names.length < 20) bucket.names.push(c.name);
  }
  return Array.from(byOrigin.values()).map((b) => ({
    origin: b.origin,
    cookieCount: b.cookieCount,
    sessionCookieCount: b.sessionCookieCount,
    loggedIn: b.sessionCookieCount > 0,
    cookieNames: b.names,
    namesTruncated: b.cookieCount > b.names.length,
  }));
}

async function webStorageOperation(kind, action, params) {
  const store = kind === "sessionStorage" ? "sessionStorage" : "localStorage";
  const key = params.key !== undefined ? String(params.key) : params.name !== undefined ? String(params.name) : undefined;
  const redact = params.redact === true;
  const redactEntry = (e) => ({ key: e.key, value: "[redacted]" });
  if (action === "get") {
    if (key !== undefined) {
      const value = await executeInTab(params, piWebStorageGet, [store, key]);
      const entry = redact ? redactEntry(value) : { key: value.key, value: value.value };
      return {
        kind, action, origin: value.origin, entry,
        summary: { origin: value.origin, keyCount: 1, keys: [value.key] },
      };
    }
    const list = await executeInTab(params, piWebStorageList, [store]);
    const entries = redact ? list.entries.map(redactEntry) : list.entries;
    return {
      kind, action, origin: list.origin, entryCount: entries.length, entries,
      summary: { origin: list.origin, keyCount: entries.length, keys: list.entries.map((e) => e.key) },
    };
  }
  if (action === "set") {
    if (key === undefined) throw new Error(`chrome_storage ${kind} set requires key`);
    if (params.value === undefined) throw new Error(`chrome_storage ${kind} set requires value`);
    const out = await executeInTab(params, piWebStorageSet, [store, key, params.value]);
    return { kind, action, ok: true, origin: out.origin, key, summary: { origin: out.origin, keyCount: 1, keys: [key] } };
  }
  if (action === "delete") {
    if (key === undefined) throw new Error(`chrome_storage ${kind} delete requires key`);
    const out = await executeInTab(params, piWebStorageDelete, [store, key]);
    return { kind, action, ok: true, origin: out.origin, key, existed: out.existed, summary: { origin: out.origin, keyCount: 1, keys: [key] } };
  }
  if (action === "clear") {
    const out = await executeInTab(params, piWebStorageClear, [store]);
    return { kind, action, ok: true, origin: out.origin, cleared: out.cleared, summary: { origin: out.origin, keyCount: 0, keys: [] } };
  }
  if (action === "summary") {
    const list = await executeInTab(params, piWebStorageList, [store]);
    return { kind, action, summary: { origin: list.origin, keyCount: list.entries.length, keys: list.entries.map((e) => e.key) } };
  }
  throw new Error(`chrome_storage ${kind}: unsupported action ${action}`);
}

// IndexedDB via CDP IndexedDB.enable / requestDatabaseNames / requestDatabase / requestData,
// plus deleteDatabase for clear. Per-record set/delete is intentionally not exposed — CDP
// writes through object stores are not ergonomic; page.evaluate with a real transaction is.
//
// P0 extension (TOOL_CONTRACTS §5.14, chrome_indexeddb_query): adds query / count / clearStore /
// deleteEntries / metadata actions with keyRange + indexName + offset support on the existing
// `storage.op` wire kind — no new plumbing.
async function indexedDBOperation(action, params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const originRes = await cdpEval(tab.id, "location.origin");
  if (originRes.exceptionDetails) {
    throw new Error(`chrome_storage IndexedDB: cannot read page origin: ${cdpExceptionText(originRes.exceptionDetails) || "unknown error"}`);
  }
  const securityOrigin = originRes.result?.value ? String(originRes.result.value) : String(tab.url || "");
  if (!securityOrigin) throw new Error("chrome_storage IndexedDB: could not determine the tab origin");
  await cdp(tab.id, "IndexedDB.enable").catch(() => undefined);
  const requireStore = () => {
    if (params.database === undefined || params.objectStore === undefined) {
      throw new Error("chrome_indexeddb_query requires database and objectStore for this action");
    }
    return { databaseName: String(params.database), objectStoreName: String(params.objectStore) };
  };
  const idbSummary = (extra = {}) => ({
    origin: securityOrigin,
    databases: [String(params.database ?? "")],
    objectStore: params.objectStore !== undefined ? String(params.objectStore) : undefined,
    ...extra,
  });
  if (action === "summary" || (action === "get" && params.database === undefined)) {
    const namesRes = await cdp(tab.id, "IndexedDB.requestDatabaseNames", { securityOrigin });
    const databaseNames = Array.isArray(namesRes?.databaseNames) ? namesRes.databaseNames : [];
    return { kind: "indexedDB", action, origin: securityOrigin, databases: databaseNames.map((name) => ({ name })), summary: { origin: securityOrigin, databases: databaseNames } };
  }
  if (action === "get") {
    const databaseName = String(params.database);
    const dbRes = await cdp(tab.id, "IndexedDB.requestDatabase", { securityOrigin, databaseName });
    const db = dbRes?.databaseWithObjectStores;
    const stores = Array.isArray(db?.objectStores) ? db.objectStores.map((s) => ({
      name: s.name, keyPath: s.keyPath ?? null, autoIncrement: s.autoIncrement === true,
      indexCount: Array.isArray(s.indexes) ? s.indexes.length : 0,
      indexes: Array.isArray(s.indexes) ? s.indexes.map((ix) => ({ name: ix.name, keyPath: ix.keyPath ?? null, unique: ix.unique === true, multiEntry: ix.multiEntry === true })) : [],
    })) : [];
    if (params.objectStore === undefined) {
      return { kind: "indexedDB", action, origin: securityOrigin, database: databaseName, stores, summary: { origin: securityOrigin, databases: [databaseName] } };
    }
    const objectStoreName = String(params.objectStore);
    const pageSize = Math.max(1, Math.min(200, Number(params.limit) || 50));
    const dataRes = await cdp(tab.id, "IndexedDB.requestData", {
      securityOrigin, databaseName, objectStoreName, indexName: "", skipCount: 0, pageSize,
    });
    const rawEntries = Array.isArray(dataRes?.objectStoreDataEntries) ? dataRes.objectStoreDataEntries : [];
    const entries = rawEntries.map((e) => ({
      key: cdpRemoteValue(e?.key), primaryKey: cdpRemoteValue(e?.primaryKey), value: cdpRemoteValue(e?.value),
    }));
    return { kind: "indexedDB", action, origin: securityOrigin, database: databaseName, objectStore: objectStoreName, entryCount: entries.length, entries, summary: { origin: securityOrigin, databases: [databaseName], objectStore: objectStoreName, entryCount: entries.length } };
  }
  if (action === "query") {
    const { databaseName, objectStoreName } = requireStore();
    const indexName = params.indexName !== undefined ? String(params.indexName) : "";
    const keyRange = buildIdbKeyRange(params.keyRange);
    const pageSize = Math.max(1, Math.min(200, Number(params.limit) || 100));
    const skipCount = Math.max(0, Number(params.offset) || 0);
    const dataRes = await cdp(tab.id, "IndexedDB.requestData", {
      securityOrigin, databaseName, objectStoreName, indexName, skipCount, pageSize, keyRange,
    });
    const rawEntries = Array.isArray(dataRes?.objectStoreDataEntries) ? dataRes.objectStoreDataEntries : [];
    let entries = rawEntries.map((e) => ({
      key: cdpRemoteValue(e?.key), primaryKey: cdpRemoteValue(e?.primaryKey), value: cdpRemoteValue(e?.value),
    }));
    if (params.filter && typeof params.filter === "object" && params.filter.keyPath !== undefined) {
      entries = entries.filter((e) => matchesIdbFilter(e.value, params.filter));
    }
    return {
      kind: "indexedDB", action, origin: securityOrigin, database: databaseName, objectStore: objectStoreName,
      ...(indexName ? { indexName } : {}),
      ...(keyRange ? { keyRange } : {}),
      entryCount: entries.length, hasMore: dataRes?.hasMore === true, entries,
      summary: idbSummary({ entryCount: entries.length, indexName: indexName || undefined }),
    };
  }
  if (action === "count") {
    const { databaseName, objectStoreName } = requireStore();
    const keyRange = buildIdbKeyRange(params.keyRange);
    const hasFilter = params.filter && typeof params.filter === "object" && params.filter.keyPath !== undefined;
    // No range/index/filter: the object store metadata already carries the exact count.
    if (!keyRange && params.indexName === undefined && !hasFilter) {
      const metaRes = await cdp(tab.id, "IndexedDB.getMetadata", { securityOrigin, databaseName, objectStoreName });
      const entryCount = typeof metaRes?.entriesCount === "number" ? metaRes.entriesCount : 0;
      return { kind: "indexedDB", action, origin: securityOrigin, database: databaseName, objectStore: objectStoreName, entryCount, summary: idbSummary({ entryCount }) };
    }
    // Range/index/filter counts page through requestData (bounded — IndexedDB cap risk #11).
    let entryCount = 0;
    let skipCount = 0;
    const pageSize = 200;
    const MAX_COUNT_SCAN = 20000;
    for (;;) {
      const dataRes = await cdp(tab.id, "IndexedDB.requestData", {
        securityOrigin, databaseName, objectStoreName,
        indexName: params.indexName !== undefined ? String(params.indexName) : "",
        skipCount, pageSize, keyRange,
      });
      const rawEntries = Array.isArray(dataRes?.objectStoreDataEntries) ? dataRes.objectStoreDataEntries : [];
      for (const e of rawEntries) {
        if (!hasFilter || matchesIdbFilter(cdpRemoteValue(e?.value), params.filter)) entryCount++;
      }
      skipCount += rawEntries.length;
      if (!dataRes?.hasMore || rawEntries.length === 0 || skipCount >= MAX_COUNT_SCAN) break;
    }
    return { kind: "indexedDB", action, origin: securityOrigin, database: databaseName, objectStore: objectStoreName, entryCount, summary: idbSummary({ entryCount }) };
  }
  if (action === "clearStore") {
    const { databaseName, objectStoreName } = requireStore();
    await cdp(tab.id, "IndexedDB.clearObjectStore", { securityOrigin, databaseName, objectStoreName });
    return { kind: "indexedDB", action, ok: true, origin: securityOrigin, database: databaseName, objectStore: objectStoreName, cleared: true, summary: idbSummary() };
  }
  if (action === "deleteEntries") {
    const { databaseName, objectStoreName } = requireStore();
    // filter {keyPath, value} doubles as a keyRange when no explicit range is given.
    const keyRange = buildIdbKeyRange(params.keyRange) || idbFilterAsKeyRange(params.filter);
    if (!keyRange) throw new Error("chrome_indexeddb_query deleteEntries requires keyRange (or filter with keyPath/value)");
    await cdp(tab.id, "IndexedDB.deleteObjectStoreEntries", { securityOrigin, databaseName, objectStoreName, keyRange });
    return { kind: "indexedDB", action, ok: true, origin: securityOrigin, database: databaseName, objectStore: objectStoreName, keyRange, deleted: true, summary: idbSummary() };
  }
  if (action === "metadata") {
    const { databaseName, objectStoreName } = requireStore();
    const metaRes = await cdp(tab.id, "IndexedDB.getMetadata", { securityOrigin, databaseName, objectStoreName });
    return {
      kind: "indexedDB", action, origin: securityOrigin, database: databaseName, objectStore: objectStoreName,
      metadata: { entriesCount: typeof metaRes?.entriesCount === "number" ? metaRes.entriesCount : 0, keyGeneratorValue: metaRes?.keyGeneratorValue ?? null },
      summary: idbSummary({ entryCount: typeof metaRes?.entriesCount === "number" ? metaRes.entriesCount : 0 }),
    };
  }
  if (action === "clear") {
    if (params.database === undefined) throw new Error("chrome_storage IndexedDB clear requires database (deletes the whole database)");
    const databaseName = String(params.database);
    await cdp(tab.id, "IndexedDB.deleteDatabase", { securityOrigin, databaseName });
    return { kind: "indexedDB", action, ok: true, origin: securityOrigin, deletedDatabase: databaseName };
  }
  if (action === "set" || action === "delete") {
    throw new Error("chrome_storage IndexedDB does not support per-record set/delete via CDP; use chrome_evaluate with an IndexedDB transaction to modify records");
  }
  throw new Error(`chrome_storage IndexedDB: unsupported action ${action}`);
}

// Build the CDP IndexedDB.KeyRange shape ({ lower?, upper?, lowerOpen?, upperOpen? }) from a
// host-side { lower, upper, lowerOpen, upperOpen } object. Compound keys (arrays) round-trip as
// JSON — CDP accepts array keys directly. Returns undefined when no bounds are given.
function buildIdbKeyRange(keyRange) {
  if (!keyRange || typeof keyRange !== "object") return undefined;
  const range = {};
  if (keyRange.lower !== undefined && keyRange.lower !== null) range.lower = keyRange.lower;
  if (keyRange.upper !== undefined && keyRange.upper !== null) range.upper = keyRange.upper;
  if (keyRange.lowerOpen !== undefined) range.lowerOpen = keyRange.lowerOpen === true;
  if (keyRange.upperOpen !== undefined) range.upperOpen = keyRange.upperOpen === true;
  return Object.keys(range).length ? range : undefined;
}

// A { keyPath, value } filter approximates a single-key equality range: lower=upper=value.
function idbFilterAsKeyRange(filter) {
  if (!filter || typeof filter !== "object" || filter.keyPath === undefined || filter.value === undefined) return null;
  const keyPath = String(filter.keyPath);
  if (keyPath.includes(".") || keyPath === "value") return null; // only direct store keys map to a range
  return { lower: filter.value, upper: filter.value };
}

// Client-side record filter (query/count): matches when the record value's dotted keyPath equals
// filter.value. Primitive values (string/number/boolean) compare exactly; object values compare
// by JSON serialization (CDP previews are lossy for nested objects — documented in the tool).
function matchesIdbFilter(value, filter) {
  if (!filter || filter.keyPath === undefined) return true;
  const keyPath = String(filter.keyPath);
  let actual = value;
  if (keyPath && keyPath !== "value") {
    for (const part of keyPath.split(".")) {
      if (actual === null || actual === undefined) return false;
      actual = actual[part];
    }
  }
  const expected = filter.value;
  if (actual === expected) return true;
  try {
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

// Convert a CDP RemoteObject into a JSON-safe value for IndexedDB reads: primitives carry
// `.value`; objects come back as a bounded preview summary instead of raw descriptors.
function cdpRemoteValue(obj) {
  if (!obj || typeof obj !== "object") return obj ?? null;
  if (obj.value !== undefined) return obj.value;
  if (obj.preview && typeof obj.preview === "object") {
    const props = Array.isArray(obj.preview.properties) ? obj.preview.properties : [];
    const parts = props.slice(0, 8).map((p) => `${p.name}:${p.value !== undefined ? p.value : p.type || "?"}`);
    if (props.length > 8 || obj.preview.overflow) parts.push("…");
    return `[${obj.preview.type || obj.type || "object"}${parts.length ? " " + parts.join(", ") : ""}]`;
  }
  return obj.description ?? obj.type ?? null;
}

// =================== chrome_perf_metrics (feat-perf-metrics) ===================
// One-shot CDP Performance metrics from the attached tab. Performance.enable restarts metric
// collection, then getMetrics snapshots counters (task duration, JS heap, layout/node counts).
// Cheap by design: no persistent-attach change, no tracing (a later chrome_trace stages that).
async function chromePerfMetrics(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  // Paused-page rail (M0): Performance.getMetrics needs the renderer, which a Debugger.paused
  // page freezes — auto-resume first.
  const pauseNote = await ensurePageUsable(tab.id, "perf metrics");
  await attachDebugger(tab.id);
  await cdp(tab.id, "Performance.enable").catch(() => undefined);
  const res = await cdp(tab.id, "Performance.getMetrics");
  const metrics = Array.isArray(res?.metrics)
    ? res.metrics.map((m) => ({ name: m.name, value: m.value }))
    : [];
  const result = { metrics, tab: await formatTab(tab) };
  if (pauseNote) result.pausedAutoResumed = pauseNote;
  return result;
}

function normalizeKey(key) {
  const table = {
    enter: "Enter",
    escape: "Escape",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
  };
  return table[String(key).toLowerCase()] || key;
}
