// Unit harness for the service worker's exactly-once executed-command journal.
//
// The journal (service_worker.js) exists so a command the SW acknowledged but whose result
// never reached the bridge (owner death between /next and /result) is not re-executed when the
// client retries with the SAME stable id. Only a compact digest is persisted per entry
// ({id, action, ok, resultHash, completedAt, aborted?}) under a TTL, an entry-count cap AND a
// total-byte budget (oldest-first eviction); full results for replay live in a small in-memory
// LRU. See REPORT.md finding [test-journal] / [journal-quota].
//
// Like the sibling unit tests we load the REAL worker into a vm sandbox with a stateful
// chrome.storage mock and a fetch shim that records /ack + /result wire traffic, then drive the
// real helpers (sweepJournal) and the real handleCommand end-to-end:
//   (1) sweepJournal drops TTL-expired entries, entries missing completedAt, caps >N entries
//       dropping the oldest by completedAt, and enforces the total-byte budget;
//   (2) handling the same command id twice does NOT re-dispatch and posts deduplicated:true
//       with the replayed result;
//   (3) a throwing action posts an error and leaves the id absent so a same-id retry re-executes;
//   (4) byte-budget + digest persistence keeps the total stored journal bounded and never
//       persists full results.

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

// Read a top-level SW constant (e.g. JOURNAL_MAX_ENTRIES) straight from the source so the tests
// stay in sync if a budget is tuned.
function swConst(name) {
  const match = src.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
  if (!match) throw new Error(`constant ${name} not found in service_worker.js`);
  // The constant expressions are plain arithmetic (e.g. `10 * 60 * 1000`), safe to evaluate.
  return Function(`"use strict"; return (${match[1]});`)();
}

const JOURNAL_MAX_ENTRIES = swConst("JOURNAL_MAX_ENTRIES");
const JOURNAL_TTL_MS = swConst("JOURNAL_TTL_MS");
const JOURNAL_MAX_BYTES = swConst("JOURNAL_MAX_BYTES");
const JOURNAL_STORAGE_KEY = swConst("JOURNAL_STORAGE_KEY");

// ---- stateful chrome.* mock. Only what the worker touches at load time and during
// handleCommand/sweepJournal (runtime + storage.session + listener no-ops) is needed.
function makeChrome(storage) {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  return {
    runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener },
    debugger: { sendCommand: noop, attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]), onDetach: listener, onEvent: listener },
    scripting: { executeScript: async () => [{ result: undefined }], registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
    webNavigation: { onCommitted: listener },
    tabs: {
      onUpdated: listener, onRemoved: listener,
      query: async () => [], get: async () => { throw new Error("no tab"); },
      create: async () => { throw new Error("no window"); }, update: async () => { throw new Error("no tab"); },
      remove: async () => {}, group: async () => -1, ungroup: async () => {},
    },
    windows: { create: async () => { throw new Error("no windows"); }, get: async () => { throw new Error("no window"); }, remove: async () => {}, update: async () => {} },
    storage: {
      session: {
        get: async (key) => (key in storage ? { [key]: storage[key] } : {}),
        set: async (obj) => { Object.assign(storage, obj); },
      },
    },
  };
}

// ---- fetch shim recording /ack and /result posts (returns 200 so no retries happen).
function makeWire() {
  const posts = [];
  const fetch = async (url, opts = {}) => {
    let body = null;
    try { body = JSON.parse(opts.body || "null"); } catch { body = opts.body; }
    posts.push({ url: String(url), body });
    return { ok: true, status: 200 };
  };
  return { posts, fetch };
}

function loadWorker(chrome, wire) {
  const noop = () => {};
  const sandbox = {
    console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    fetch: wire ? wire.fetch : async () => { throw new Error("no network in unit test"); },
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

// Count real dispatch() invocations by wrapping the worker's global dispatch (same technique as
// the csp-eval suite wraps `cdp`). handleCommand resolves `dispatch` through the global object,
// so the wrapped version is what every command path actually calls. The getter keeps `calls`
// live (a plain property would snapshot the counter at creation time).
function countDispatches(w) {
  const real = w.dispatch;
  let calls = 0;
  w.dispatch = (action, params) => { calls++; return real(action, params); };
  return { get calls() { return calls; } };
}

function resultPosts(wire) { return wire.posts.filter((p) => p.url.endsWith("/result")).map((p) => p.body); }
function ackPosts(wire) { return wire.posts.filter((p) => p.url.endsWith("/ack")).map((p) => p.body); }

async function run() {
  // ===== (1) sweepJournal: TTL, missing completedAt, entry cap, byte budget. =====
  {
    const w = loadWorker(makeChrome({}));
    const now = Date.now();

    // TTL + missing/invalid completedAt are dropped; fresh entries survive.
    const j1 = {
      fresh: { id: "fresh", action: "tab.version", ok: true, resultHash: "a1", completedAt: now },
      expired: { id: "expired", action: "a", ok: true, resultHash: "b2", completedAt: now - JOURNAL_TTL_MS - 1 },
      noTs: { id: "noTs", action: "a", ok: true, resultHash: "c3" },
      nullTs: { id: "nullTs", action: "a", ok: true, resultHash: "d4", completedAt: null },
      nullEntry: null,
    };
    w.sweepJournal(j1, now);
    ok("fresh" in j1, "ttl: fresh entry retained");
    ok(!("expired" in j1), "ttl: TTL-expired entry removed");
    ok(!("noTs" in j1), "ttl: entry missing completedAt removed");
    ok(!("nullTs" in j1), "ttl: entry with non-numeric completedAt removed");
    ok(!("nullEntry" in j1), "ttl: null entry removed");

    // Entry-count cap drops the OLDEST by completedAt, keeps exactly N.
    const j2 = {};
    for (let i = 0; i < JOURNAL_MAX_ENTRIES + 30; i++) {
      j2[`id-${i}`] = { id: `id-${i}`, action: "x", ok: true, resultHash: "h", completedAt: now + i * 1000 };
    }
    w.sweepJournal(j2, now + 100000);
    const ids2 = Object.keys(j2);
    ok(ids2.length === JOURNAL_MAX_ENTRIES, `cap: journal capped at ${JOURNAL_MAX_ENTRIES} entries (got ${ids2.length})`);
    ok(!("id-0" in j2) && !("id-29" in j2), "cap: oldest 30 entries dropped");
    ok("id-30" in j2 && `id-${JOURNAL_MAX_ENTRIES + 29}` in j2, "cap: newest entries retained");

    // Byte budget: oversized entries are evicted oldest-first until the FULL serialized journal
    // (values AND keys) fits under JOURNAL_MAX_BYTES.
    const j3 = {};
    for (let i = 0; i < 200; i++) {
      j3[`big-${i}`] = { id: `big-${i}`, action: "a".repeat(3000), ok: true, resultHash: "h", completedAt: now + i * 1000 };
    }
    w.sweepJournal(j3, now + 100000);
    const kept3 = Object.keys(j3);
    ok(JSON.stringify(j3).length <= JOURNAL_MAX_BYTES, `bytes: persisted size ${JSON.stringify(j3).length}B <= ${JOURNAL_MAX_BYTES}B budget`);
    ok(kept3.length < 200, "bytes: oversized journal was evicted");
    ok(!("big-0" in j3), "bytes: oldest entry evicted first");
    const ascending = kept3.every((id, idx, arr) => idx === 0 || j3[arr[idx - 1]].completedAt < j3[id].completedAt);
    ok(ascending, "bytes: survivors are the newest entries (oldest-first eviction)");
  }

  // ===== (2) handleCommand: same id twice => NO re-dispatch, deduplicated replay. =====
  {
    const storage = {};
    const wire = makeWire();
    const w = loadWorker(makeChrome(storage), wire);
    const d = countDispatches(w);

    const cmd = { id: "cmd-dup-1", action: "tab.version", params: {} };
    await w.handleCommand({ ...cmd });
    await w.handleCommand({ ...cmd });

    ok(d.calls === 1, "dedupe: dispatch ran exactly ONCE for the same id");
    ok(ackPosts(wire).length === 1, "dedupe: /ack posted only for the first handling");

    const results = resultPosts(wire);
    ok(results.length === 2, "dedupe: two /result posts (first execution + replayed retry)");
    const first = results[0];
    const second = results[1];
    ok(first.ok === true && first.deduplicated === undefined, "dedupe: first result is a normal ok:true delivery");
    ok(second.ok === true && second.deduplicated === true, "dedupe: retried id is answered with deduplicated:true");
    ok(JSON.stringify(second.result) === JSON.stringify(first.result), "dedupe: retry replays the exact recorded result");

    const journal = storage[JOURNAL_STORAGE_KEY] || {};
    ok(Object.keys(journal).length === 1 && journal["cmd-dup-1"] !== undefined, "dedupe: journal holds exactly one entry for the id");
    ok(journal["cmd-dup-1"].ok === true && typeof journal["cmd-dup-1"].resultHash === "string", "dedupe: journal entry stores the success digest");
  }

  // ===== (3) handleCommand: a throwing action posts an error and leaves the id ABSENT. =====
  {
    const storage = {};
    const wire = makeWire();
    const w = loadWorker(makeChrome(storage), wire);
    const d = countDispatches(w);

    const cmd = { id: "cmd-throw-1", action: "tab.save", params: {} }; // tab.save throws without params.name
    await w.handleCommand({ ...cmd });
    await w.handleCommand({ ...cmd }); // retry with the SAME id must re-execute

    ok(d.calls === 2, "throw: a same-id retry after failure re-executes (never deduped)");
    const results = resultPosts(wire);
    ok(results.length === 2 && results.every((r) => r.ok === false), "throw: both attempts posted ok:false");
    ok(/requires a name/.test(results[0].error), `throw: error surfaces the action message (got: ${results[0].error})`);
    ok(results.every((r) => r.deduplicated === undefined), "throw: failed commands are never deduplicated");
    const journal = storage[JOURNAL_STORAGE_KEY] || {};
    ok(!("cmd-throw-1" in journal), "throw: failed command leaves the id ABSENT from the journal so a retry re-executes");
  }

  // ===== (3b) interrupted (timeout/pre-reload) ids: retried ids are warned, not re-run. =====
  {
    const storage = {};
    const wire = makeWire();
    const w = loadWorker(makeChrome(storage), wire);
    const d = countDispatches(w);

    w.markInterrupted("cmd-aborted-1", {}, "page.type");
    const journal = storage[JOURNAL_STORAGE_KEY] || {};
    ok(journal["cmd-aborted-1"] && journal["cmd-aborted-1"].aborted === true, "interrupted: markInterrupted persists an aborted marker");

    await w.handleCommand({ id: "cmd-aborted-1", action: "page.type", params: {} });
    ok(d.calls === 0, "interrupted: retrying an aborted id does NOT re-dispatch");
    const res = resultPosts(wire).at(-1);
    ok(res.ok === false && res.deduplicated === true && /interrupted/.test(res.error), "interrupted: retry answered with the interrupted warning, deduplicated:true");
  }

  // ===== (4) byte budget + digest persistence: many commands keep the stored journal bounded,
  // and only digests (never full results) are persisted. =====
  {
    const storage = {};
    const wire = makeWire();
    const w = loadWorker(makeChrome(storage), wire);
    const real = w.dispatch;
    w.dispatch = (action, params) => {
      if (action === "big.payload") return { ok: true, data: "y".repeat(80_000), extra: 42 }; // ~80KB result
      return real(action, params);
    };

    // 240 commands, half returning ~80KB results, with long ids (id length also counts toward
    // the persisted size). sweepJournal runs on every handleCommand, including after each add.
    for (let i = 0; i < 240; i++) {
      await w.handleCommand({ id: `cmd-${i}-${"x".repeat(1200)}`, action: i % 2 ? "big.payload" : "tab.version", params: {} });
    }

    const journal = storage[JOURNAL_STORAGE_KEY] || {};
    const persistedSize = JSON.stringify(journal).length;
    ok(persistedSize <= JOURNAL_MAX_BYTES, `budget: persisted journal is ${persistedSize}B <= ${JOURNAL_MAX_BYTES}B after 240 commands`);
    ok(Object.keys(journal).length <= JOURNAL_MAX_ENTRIES, `budget: journal entry count ${Object.keys(journal).length} <= ${JOURNAL_MAX_ENTRIES}`);

    // Digests only: no entry carries the full result, even though big.payload returned 80KB.
    for (const entry of Object.values(journal)) {
      ok(entry && typeof entry.resultHash === "string" && entry.resultHash.length === 8 && !("result" in entry),
        `digest: entry ${entry.id} persists the compact hash, never the full result`);
      ok(typeof entry.action === "string" && typeof entry.completedAt === "number", `digest: entry ${entry.id} keeps the required digest fields`);
    }

    // Compactness is deterministic and independent of result size.
    const d1 = w.resultDigest("hello world");
    const d2 = w.resultDigest("hello world");
    ok(d1 === d2 && /^[0-9a-f]{8}$/.test(d1), "digest: deterministic compact 8-hex FNV-1a hash");
    const huge = { nested: "z".repeat(200_000), list: Array.from({ length: 1000 }, (_, i) => i) };
    ok(w.resultDigest(huge).length === 8, "digest: a huge result still hashes to 8 hex chars");

    // Full results are replay-cached in memory only (never in storage).
    ok(!JSON.stringify(storage).includes("y".repeat(80_000)), "budget: no full result body ever reached chrome.storage");
  }

  // ===== (4b) in-memory replay LRU is bounded: oldest results are evicted, so dedupe replay
  // degrades to a "retry with a new id" hint instead of stale data. =====
  {
    const storage = {};
    const wire = makeWire();
    const w = loadWorker(makeChrome(storage), wire);
    const d = countDispatches(w);

    // 50 distinct small-result commands: the LRU holds at most RECENT_RESULTS_MAX (40), so the
    // oldest is evicted while the newest still replays.
    for (let i = 0; i < 50; i++) {
      await w.handleCommand({ id: `lru-${i}`, action: "tab.version", params: {} });
    }
    await w.handleCommand({ id: "lru-0", action: "tab.version", params: {} });
    const evicted = resultPosts(wire).at(-1);
    ok(evicted.ok === false && evicted.deduplicated === true && /no longer retained/.test(evicted.error),
      "lru: oldest result evicted from the replay LRU (dedupe answered, no stale replay)");
    await w.handleCommand({ id: "lru-49", action: "tab.version", params: {} });
    const replayed = resultPosts(wire).at(-1);
    ok(replayed.ok === true && replayed.deduplicated === true, "lru: newest result still replays from the LRU");
    ok(d.calls === 50, "lru: no dispatch happened for either retried id (dedupe only)");
  }

  // ===== (4c) oversized results are journaled as a digest but refused by the replay LRU, so a
  // same-id retry is answered without re-executing the side effect. =====
  {
    const storage = {};
    const wire = makeWire();
    const w = loadWorker(makeChrome(storage), wire);
    const real = w.dispatch;
    let dispatches = 0;
    w.dispatch = (action, params) => {
      dispatches++;
      if (action === "huge.payload") return { ok: true, data: "q".repeat(600_000) }; // >512KB
      return real(action, params);
    };

    await w.handleCommand({ id: "huge-1", action: "huge.payload", params: {} });
    const journal = storage[JOURNAL_STORAGE_KEY] || {};
    ok(journal["huge-1"] && journal["huge-1"].ok === true && journal["huge-1"].resultHash.length === 8,
      "lru: oversized result is journaled as a compact digest");
    await w.handleCommand({ id: "huge-1", action: "huge.payload", params: {} });
    const refused = resultPosts(wire).at(-1);
    ok(refused.ok === false && refused.deduplicated === true && /no longer retained/.test(refused.error),
      "lru: oversized result refused by the replay LRU -> 'retry with a new id' hint, no re-dispatch");
    ok(dispatches === 1, "lru: oversized command executed exactly once (retry deduped)");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
