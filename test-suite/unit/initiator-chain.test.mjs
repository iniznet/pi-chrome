// Unit harness for chrome_network_initiator_chain — the P0 Request-initiator chain tool.
//
// Loads the REAL service_worker.js into a vm sandbox (sw-lifecycle pattern) and drives the real
// top-level helpers (captureInitiator, initiatorLinkUrl, pickInitiatorTarget, buildInitiatorChain)
// plus the real `network.initiatorChain` dispatch path, and the REAL commands.ts
// formatInitiatorChain formatter (node type-stripping). The tool shipped in Phase 1, so all
// assertions here must stay green.
//
// TOOL_CONTRACTS.md §5 row 21: reads the cdpNetworkEntries store; pickInitiatorTarget by
// requestId exact or requestUrlIncludes (latest match + ambiguous); walks ancestors via
// initiatorLinkUrl (initiator.url → first stack frame URL → last redirect hop) mapped byUrl;
// visited-set cycle guard; INITIATOR_CHAIN_MAX_DEPTH=16; reverse-scan collectInitiatorDependents
// (cap 50); response { requestId, url, method, resourceType, status, initiator, chain, ambiguous?,
// dependents?, dependentCount, dependentsTruncated, chainDepthCapped }.

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const src = fs.readFileSync(workerPath, "utf8");
const commandsPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/commands.ts");

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; }
  else { failures++; console.error(`  ✗ ${msg}`); }
}
function throwsWith(fn, re, msg) {
  try { fn(); ok(false, `${msg} (expected throw)`); }
  catch (e) { ok(re.test(String(e.message || e)), `${msg} (got: ${e.message})`); }
}

// ---- Chrome mock (foundation-smoke superset: stateful storage.session + a seeded tab). ----
function makeChrome(rec) {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  const sessionStore = {};
  const tabs = { 7: { id: 7, windowId: 1, url: "https://app.example/", title: "App", active: false } };
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
      query: async () => [tabs[7]], get: async (id) => tabs[id] || null,
      create: async () => { throw new Error("no window"); }, update: async () => {}, remove: async () => {}, group: async () => -1, ungroup: async () => {},
    },
    windows: { create: async () => { throw new Error("no windows"); }, get: async () => { throw new Error("no window"); }, remove: async () => {}, update: async () => {} },
    storage: { session: { get: async (k) => (k in sessionStore ? { [k]: sessionStore[k] } : {}), set: async (o) => Object.assign(sessionStore, o) } },
    sessionStore,
  };
}

function loadWorker() {
  const rec = {};
  const chrome = makeChrome(rec);
  const warns = [];
  const consoleSpy = { log: () => {}, warn: (...a) => { warns.push(a.map(String).join(" ")); }, error: () => {}, info: () => {} };
  const noop = () => {};
  const sandbox = {
    console: consoleSpy, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setTimeout: () => ({}), clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    fetch: async () => { throw new Error("no fetch in initiator-chain harness"); },
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

const cmdJs = stripTypeScriptTypes(fs.readFileSync(commandsPath, "utf8"), { mode: "strip" });
const cmdMod = await import("data:text/javascript;base64," + Buffer.from(cmdJs).toString("base64"));
const { formatInitiatorChain } = cmdMod;

function storeWith(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.requestId, e);
  return m;
}

async function run() {
  const { sandbox, ctxEval } = loadWorker();

  // ===== 1. captureInitiator: full record, capped stack, parent-chain flatten. =====
  {
    const cap = sandbox.captureInitiator;
    ok(cap(null) === null, "capture: null initiator -> null");
    ok(cap({ type: "parser" }).type === "parser", "capture: type-only initiator kept");
    const withStack = cap({
      type: "script",
      url: "https://a.test/app.js",
      lineNumber: 10,
      columnNumber: 5,
      stack: {
        callFrames: [
          { functionName: "submitForm", url: "https://a.test/app.js", lineNumber: 10, columnNumber: 5 },
          { functionName: "onClick", url: "https://a.test/app.js", lineNumber: 30, columnNumber: 2 },
        ],
        parent: {
          callFrames: [{ functionName: "dispatch", url: "https://a.test/lib.js", lineNumber: 1, columnNumber: 1 }],
          parent: null,
        },
      },
    });
    ok(withStack.url === "https://a.test/app.js" && withStack.lineNumber === 10 && withStack.columnNumber === 5, "capture: url/line/column preserved");
    ok(Array.isArray(withStack.stack) && withStack.stack.length === 3, "capture: parent chain flattened into one stack");
    ok(withStack.stack[0].functionName === "submitForm" && withStack.stack[2].url === "https://a.test/lib.js", "capture: child frames first, parent appended");
    const big = { type: "script", stack: { callFrames: Array.from({ length: 30 }, (_, i) => ({ functionName: `f${i}`, url: "u", lineNumber: i, columnNumber: i })) } };
    ok(cap(big).stack.length === 20, "capture: stack capped at INITIATOR_STACK_MAX_FRAMES (20)");
  }

  // ===== 2. buildInitiatorChain: parser document chain + script loader. =====
  {
    const entries = storeWith([
      { requestId: "doc-1", url: "https://app.example/", method: "GET", resourceType: "Document", startedAt: 1000, initiator: { type: "parser" } },
      { requestId: "script-1", url: "https://app.example/app.js", method: "GET", resourceType: "Script", startedAt: 2000, initiator: { type: "parser", url: "https://app.example/" } },
      { requestId: "fetch-1", url: "https://api.example.com/data", method: "POST", resourceType: "XHR", startedAt: 3000, initiator: { type: "script", url: "https://app.example/app.js", lineNumber: 42, columnNumber: 17 } },
    ]);
    const res = sandbox.buildInitiatorChain(entries, { requestId: "fetch-1" });
    ok(res.requestId === "fetch-1" && res.url === "https://api.example.com/data", "chain: target resolved by requestId");
    ok(res.method === "POST" && res.resourceType === "XHR" && res.status === null, "chain: method/resourceType/status carried");
    ok(Array.isArray(res.chain) && res.chain.length === 2, "chain: two ancestors walked");
    ok(res.chain[0].requestId === "doc-1" && res.chain[1].requestId === "script-1", "chain: root-first order (document, then loader script)");
    ok(res.chain[1].initiator.type === "parser" && res.chain[1].initiator.url === "https://app.example/", "chain: loader node carries its own initiator record");
    ok(res.initiator.lineNumber === 42 && res.initiator.columnNumber === 17, "chain: target initiator line/column preserved");
    ok(res.chainDepthCapped === false, "chain: not depth-capped on a short chain");
  }

  // ===== 3. initiatorLinkUrl fallbacks: stack-frame URL, then last redirect hop. =====
  {
    // Script initiator WITHOUT url still links via its first stack frame URL.
    const stackLinked = storeWith([
      { requestId: "doc", url: "https://app.example/", method: "GET", resourceType: "Document", startedAt: 1, initiator: { type: "parser" } },
      { requestId: "loader", url: "https://app.example/loader.js", method: "GET", resourceType: "Script", startedAt: 2, initiator: { type: "parser", url: "https://app.example/" } },
      {
        requestId: "api",
        url: "https://api.example.com/x",
        method: "GET",
        resourceType: "XHR",
        startedAt: 3,
        initiator: { type: "script", stack: [{ functionName: "main", url: "https://app.example/loader.js", lineNumber: 9, columnNumber: 1 }] },
      },
    ]);
    const viaStack = sandbox.buildInitiatorChain(stackLinked, { requestId: "api" });
    ok(viaStack.chain.some((n) => n.requestId === "loader"), "link: stack-frame URL links a url-less script initiator to its loader");
    ok(viaStack.chain.some((n) => n.requestId === "doc"), "link: chain continues past the loader to the document");

    // No initiator URL/stack: falls back to the last redirect hop.
    const viaRedirect = storeWith([
      { requestId: "doc", url: "https://app.example/", method: "GET", resourceType: "Document", startedAt: 1, initiator: { type: "parser" } },
      {
        requestId: "final",
        url: "https://cdn.example/app.js",
        method: "GET",
        resourceType: "Script",
        startedAt: 4,
        initiator: null,
        redirects: [{ url: "https://redirector.example/go", status: 302 }, { url: "https://app.example/app.js", status: 200 }],
      },
      { requestId: "origin", url: "https://app.example/app.js", method: "GET", resourceType: "Script", startedAt: 2, initiator: { type: "parser", url: "https://app.example/" } },
    ]);
    const viaHop = sandbox.buildInitiatorChain(viaRedirect, { requestId: "final" });
    ok(viaHop.chain.some((n) => n.requestId === "origin"), "link: last redirect hop links to the original request");
  }

  // ===== 4. URL-substring ambiguity: latest match + candidates. =====
  {
    const entries = storeWith([
      { requestId: "analytics-1", url: "https://cdn.example/analytics.js?t=1", method: "GET", resourceType: "Script", startedAt: 100, initiator: { type: "parser", url: "https://app.example/" } },
      { requestId: "analytics-2", url: "https://cdn.example/analytics.js?t=2", method: "GET", resourceType: "Script", startedAt: 900, initiator: { type: "script", url: "https://app.example/app.js" } },
      { requestId: "app", url: "https://app.example/app.js", method: "GET", resourceType: "Script", startedAt: 50, initiator: { type: "parser", url: "https://app.example/" } },
    ]);
    const res = sandbox.buildInitiatorChain(entries, { requestUrlIncludes: "analytics.js" });
    ok(res.requestId === "analytics-2", "ambig: requestUrlIncludes picks the most recent match");
    ok(res.ambiguous && res.ambiguous.matched === 2 && Array.isArray(res.ambiguous.candidates), "ambig: ambiguity reported with candidate requestIds");
    ok(res.chain.some((n) => n.requestId === "app"), "ambig: latest match's own ancestors are still walked");
  }

  // ===== 5. Cycle guard + depth cap. =====
  {
    const cycle = storeWith([
      { requestId: "a", url: "https://x.test/a.js", method: "GET", resourceType: "Script", startedAt: 1, initiator: { type: "script", url: "https://x.test/b.js" } },
      { requestId: "b", url: "https://x.test/b.js", method: "GET", resourceType: "Script", startedAt: 2, initiator: { type: "script", url: "https://x.test/a.js" } },
    ]);
    const res = sandbox.buildInitiatorChain(cycle, { requestId: "a" });
    ok(res.chain.length === 1 && res.chain[0].requestId === "b", "cycle: visited-set stops at one hop");
    const deep = new Map();
    for (let i = 0; i < 20; i++) {
      const parentUrl = i === 0 ? "https://d.test/root.html" : `https://d.test/loader-${i - 1}.js`;
      deep.set(`r${i}`, { requestId: `r${i}`, url: `https://d.test/loader-${i}.js`, method: "GET", resourceType: "Script", startedAt: i, initiator: { type: "script", url: parentUrl } });
    }
    deep.set("root", { requestId: "root", url: "https://d.test/root.html", method: "GET", resourceType: "Document", startedAt: -1, initiator: { type: "parser" } });
    const deepRes = sandbox.buildInitiatorChain(deep, { requestId: "r19" });
    ok(deepRes.chain.length === 16, "depth: capped at INITIATOR_CHAIN_MAX_DEPTH (16)");
    ok(deepRes.chainDepthCapped === true, "depth: chainDepthCapped flag set when capped");
    ok(deepRes.chain[0].requestId === "r3", "depth: capped chain is a contiguous suffix walk");
  }

  // ===== 6. Dependents reverse scan. =====
  {
    const entries = storeWith([
      { requestId: "app", url: "https://app.example/app.js", method: "GET", resourceType: "Script", startedAt: 100, initiator: { type: "parser", url: "https://app.example/" } },
      { requestId: "fetch-1", url: "https://api.example.com/a", method: "GET", resourceType: "XHR", startedAt: 200, initiator: { type: "script", url: "https://app.example/app.js" } },
      { requestId: "fetch-2", url: "https://api.example.com/b", method: "GET", resourceType: "XHR", startedAt: 300, initiator: { type: "script", url: "https://app.example/app.js" } },
      { requestId: "other", url: "https://other.example/x", method: "GET", resourceType: "Document", startedAt: 400, initiator: { type: "parser", url: "https://other.example/" } },
    ]);
    const res = sandbox.buildInitiatorChain(entries, { requestId: "app", includeDependents: true });
    ok(res.dependents && res.dependents.length === 2, "dependents: both dependent fetches found");
    ok(res.dependents.some((d) => d.requestId === "fetch-1") && res.dependents.some((d) => d.requestId === "fetch-2"), "dependents: correct requestIds");
    ok(!res.dependents.some((d) => d.requestId === "other"), "dependents: unrelated request excluded");
    ok(res.dependentCount === 2 && res.dependentsTruncated === false, "dependents: count + truncation flag");
    const noDeps = sandbox.buildInitiatorChain(entries, { requestId: "app" });
    ok(noDeps.dependents === undefined && noDeps.dependentCount === undefined, "dependents: omitted unless requested");
    // Cap: INITIATOR_CHAIN_MAX_DEPENDENTS=50 with 60 dependents truncates.
    const many = new Map();
    many.set("app", { requestId: "app", url: "https://app.example/app.js", method: "GET", resourceType: "Script", startedAt: 1, initiator: { type: "parser", url: "https://app.example/" } });
    for (let i = 0; i < 60; i++) {
      many.set(`d${i}`, { requestId: `d${i}`, url: `https://app.example/use${i}.js`, method: "GET", resourceType: "Script", startedAt: 2 + i, initiator: { type: "script", url: "https://app.example/app.js" } });
    }
    const capped = sandbox.buildInitiatorChain(many, { requestId: "app", includeDependents: true });
    ok(capped.dependents.length === 50, "dependents: capped at INITIATOR_CHAIN_MAX_DEPENDENTS (50)");
    ok(capped.dependentsTruncated === true, "dependents: truncated flag set at the cap");
  }

  // ===== 7. Missing-target errors. =====
  {
    const entries = storeWith([
      { requestId: "a", url: "https://a.test/x", method: "GET", resourceType: "Document", startedAt: 1, initiator: { type: "parser" } },
    ]);
    throwsWith(() => sandbox.buildInitiatorChain(entries, { requestId: "missing" }), /No CDP network entry with requestId missing/, "errors: unknown requestId throws");
    throwsWith(() => sandbox.buildInitiatorChain(entries, {}), /requires requestId or requestUrlIncludes/, "errors: no target params throws");
    throwsWith(() => sandbox.buildInitiatorChain(entries, { requestUrlIncludes: "zzz-not-there" }), /No captured CDP network request whose URL includes/, "errors: unmatched urlIncludes throws");
  }

  // ===== 8. Real dispatch path: seeded store + tab. =====
  {
    // Seed the CDP capture store for tab 7 (dispatch resolves it via getTabByParams targetId).
    ctxEval(`cdpNetworkEntries.set(7, new Map());`);
    const seed = [
      { requestId: "doc-1", url: "https://app.example/", method: "GET", resourceType: "Document", startedAt: 1000, initiator: { type: "parser" } },
      { requestId: "script-1", url: "https://app.example/app.js", method: "GET", resourceType: "Script", startedAt: 1500, initiator: { type: "parser", url: "https://app.example/" } },
      { requestId: "fetch-1", url: "https://api.example.com/data", method: "GET", resourceType: "XHR", startedAt: 2000, initiator: { type: "script", url: "https://app.example/app.js", lineNumber: 7, columnNumber: 1 } },
    ];
    ctxEval(`const __seed = ${JSON.stringify(seed)}; for (const e of __seed) cdpNetworkEntries.get(7).set(e.requestId, e);`);

    const result = await sandbox.dispatch("network.initiatorChain", { targetId: 7, requestId: "fetch-1" });
    ok(result.requestId === "fetch-1", "dispatch: network.initiatorChain resolves the target entry");
    ok(result.chain.some((n) => n.requestId === "doc-1"), "dispatch: ancestor chain built through the real dispatch switch");
  }

  // ===== 9. Real dispatch error: no capture store. =====
  {
    const err = await errorOfAsync(() => loadWorker().sandbox.dispatch("network.initiatorChain", { targetId: 7, requestId: "fetch-1" }));
    ok(err && /enable chrome_network_capture/.test(String(err.message || err)), "dispatch: no capture store surfaces the enable-capture error");
  }

  // ===== 10. formatInitiatorChain (commands.ts). =====
  {
    const res = {
      requestId: "fetch-1",
      url: "https://api.example.com/data",
      method: "POST",
      chain: [
        { requestId: "doc-1", url: "https://app.example/", method: "GET", resourceType: "Document", initiator: { type: "parser" } },
        { requestId: "script-1", url: "https://app.example/app.js", method: "GET", resourceType: "Script", initiator: { type: "parser", url: "https://app.example/", lineNumber: 8, columnNumber: 3 } },
      ],
      initiator: { type: "script", url: "https://app.example/app.js", lineNumber: 42, columnNumber: 17, stack: [{ functionName: "submitForm", url: "https://app.example/app.js", lineNumber: 42, columnNumber: 17 }] },
    };
    const text = formatInitiatorChain(res);
    ok(text.startsWith("Request POST https://api.example.com/data (fetch-1)"), "format: header line renders method + url + requestId");
    ok(text.includes("Initiator chain:"), "format: chain section header present");
    ok(text.includes("GET https://app.example/") && text.includes("→ GET https://app.example/app.js:8:3") && text.includes("→ POST https://api.example.com/data"), "format: root-first arrow chain with line:col hints");
    ok(text.includes("Triggering stack:") && text.includes("submitForm @ https://app.example/app.js:42:17"), "format: triggering stack rendered");

    const amb = formatInitiatorChain({ url: "https://cdn.example/a.js", method: "GET", requestId: "a-2", ambiguous: { matched: 2, candidates: ["a-1", "a-2"] } });
    ok(amb.includes("2 captured requests match") && amb.includes("candidates: a-1, a-2"), "format: ambiguity warning rendered");
    const deps = formatInitiatorChain({ url: "https://app.example/app.js", method: "GET", requestId: "app", chain: [], dependents: [{ method: "GET", url: "https://api.example.com/a" }], dependentCount: 1, dependentsTruncated: false });
    ok(deps.includes("Dependents (1):") && deps.includes("→ GET https://api.example.com/a"), "format: dependents section rendered");
    ok(formatInitiatorChain(null) !== undefined && formatInitiatorChain("junk") !== undefined, "format: junk input never crashes");
    ok(formatInitiatorChain({ url: "https://a.test/x", method: "GET", chain: [] }).includes("was not linked to another captured request"), "format: unlinked request hint rendered");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

// Dispatch helper: call the sandbox's real dispatch() for network.initiatorChain.
async function errorOfAsync(fn) {
  try { await fn(); return null; }
  catch (e) { return e; }
}

run().catch((e) => { console.error(e); process.exit(1); });
