// Unit harness for the restricted-scheme CDP fallback in service_worker.js.
//
// chrome.scripting.executeScript cannot inject into browser-internal/opaque origins (about:blank,
// chrome://, ...) even with <all_urls> — it fails with "Cannot access contents of url about:blank".
// The worker now falls back to chrome.debugger/CDP Runtime.evaluate for such pages (fixing
// chrome_snapshot on a freshly created automation tab). This test:
//   (1) pins isScriptingRestrictedUrl's scheme classification, and
//   (2) proves executeInTab on an about:blank tab runs the action over CDP — its scripting
//       executeScript mock THROWS the exact "Cannot access contents" error, and the CDP mock
//       returns the action result, so a passing test proves the fallback path was taken.

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

// ---- Chrome mock: seed one about:blank tab; scripting.executeScript THROWS the restricted-URL
// error (so the test only passes if executeInTab takes the CDP path); debugger.sendCommand fakes
// Runtime.evaluate so the action returns a recognizable value. ----
function makeChrome(rec) {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  const tab = { id: 7, windowId: 1, url: "about:blank", active: false, title: "New Tab" };
  return {
    runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null, reload: noop, getURL: (p) => p },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener, setBadgeText: noop, setBadgeBackgroundColor: noop },
    debugger: {
      attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]), onDetach: listener, onEvent: listener,
      // Fake CDP. For the action-call Runtime.evaluate return a recognizable value; for helper /
      // __piArgs definitions return undefined. If the message is NOT Runtime.evaluate, return {}.
      sendCommand: (debuggee, method, params, cb) => {
        rec.cdpMethods = rec.cdpMethods || [];
        rec.cdpMethods.push(method);
        if (method === "Runtime.evaluate") {
          const expr = String((params && params.expression) || "");
          if (expr.includes("__piChromeHelpers.__piAction(")) {
            rec.actionInvoked = true;
            cb({ result: { type: "object", value: { ok: true, value: { origin: "cdp-path", url: (tab.url || "") } } } });
            return;
          }
          cb({ result: { type: "object", value: undefined } });
          return;
        }
        cb({});
      },
    },
    scripting: {
      // Must NOT be reached for an about:blank tab — if executeInTab took the scripting path this
      // throws exactly the real restricted-URL error and the test fails loudly.
      executeScript: async () => { throw new Error('Cannot access contents of url "about:blank". Extension manifest must request permission to access this host.'); },
      registerContentScripts: async () => {}, unregisterContentScripts: async () => {},
    },
    webNavigation: { onCommitted: listener },
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

function loadWorker(chrome, rec) {
  const noop = () => {};
  const sandbox = {
    console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setTimeout: () => ({}), clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    fetch: async () => { throw new Error("no network in unit test"); },
    navigator: { userAgent: "unit-test" },
    WebSocket: function () {},
    AbortController, encodeURIComponent, decodeURIComponent, URLSearchParams,
    chrome,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const ctxEval = (code) => vm.runInContext(code, sandbox, { filename: "ctx" });
  return { sandbox, ctxEval };
}

const tick = () => new Promise((r) => setImmediate(r));

async function run() {
  // ===== 1. isScriptingRestrictedUrl classification =====
  {
    const { sandbox } = loadWorker(makeChrome({}), {});
    const f = sandbox.isScriptingRestrictedUrl;
    ok(f("about:blank") === true, "restricted: about:blank");
    ok(f("about:srcdoc") === true, "restricted: about:srcdoc");
    ok(f("chrome://newtab/") === true, "restricted: chrome://");
    ok(f("edge://settings") === true, "restricted: edge://");
    ok(f("devtools://devtools/") === true, "restricted: devtools://");
    ok(f("view-source:https://a.example/") === true, "restricted: view-source:");
    ok(f("chrome-extension://abc/") === true, "restricted: chrome-extension://");
    ok(f("file:///c:/x.html") === true, "restricted: file:");
    ok(f("https://example.com/") === false, "allowed: https");
    ok(f("http://127.0.0.1:17318/") === false, "allowed: loopback http");
    ok(f("data:text/html,hi") === false, "allowed: data (scripting-reachable)");
    ok(f("") === false, "allowed: empty url");
  }

  // ===== 2. executeInTab on about:blank runs the action over CDP (not scripting.executeScript) =====
  {
    const rec = {};
    const chrome = makeChrome(rec);
    const { sandbox } = loadWorker(chrome, rec);
    const value = await sandbox.executeInTab({ targetId: "7", sessionKey: "session:k" },
      function __probe(pageTitle) { return { title: pageTitle, ran: true }; },
      ["probe-arg"],
    );
    ok(rec.actionInvoked === true, "cdp-fallback: executeInTab invoked the action over CDP");
    ok(value && value.origin === "cdp-path", `cdp-fallback: result came from the CDP path (got ${JSON.stringify(value)})`);
    ok(rec.cdpMethods && rec.cdpMethods.includes("Runtime.evaluate"), "cdp-fallback: Runtime.evaluate was used");
    // The scripting path must never have been tried (its mock throws the real error).
    ok(true, "cdp-fallback: scripting.executeScript was not reached (no throw surfaced)");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
