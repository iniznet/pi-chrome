// Unit harness for snapshot_injected.js — the MAIN-world DOM snapshot library injected by the
// MV3 service worker — plus the sub-frame merge layer it feeds (mergeSubframeSnapshots in
// service_worker.js).
//
// The real library is loaded into a node vm "page world" behind a minimal DOM shim built in this
// file (TreeWalker/NodeFilter, ShadowRoot, elementsFromPoint, getComputedStyle,
// getBoundingClientRect, ...). No jsdom, no browser, no deps. The DOM library source is never
// touched; every shim lives here.
//
// Coverage (finding [test-snapshot-injected]):
//   1. createDomBudget — the candidate walk stops after 8000 nodes and when the wall-clock
//      budget (250ms, sampled every 64th node) lapses mid-walk.
//   2. rememberElement/evictRememberedElements — disconnected elements are evicted first, then
//      the lowest uid sequence (MAX_REMEMBERED_ELEMENTS=2000).
//   3. collectInteractiveCandidates — open shadow roots are pierced (host + shadow elements are
//      both collected), closed roots stay opaque.
//   4. mergeSubframeSnapshots (service_worker.js) — sub-frame uids are prefixed (el-f<frameId>-N)
//      and frame-tagged, failed/skipped frames become placeholders, merged elements are capped at
//      SNAPSHOT_MAX_MERGED_ELEMENTS=400, and totalInteractiveSampled is updated consistently.
//   5. snapshotPage via the shim — the el- uid scheme is sequential and stable across snapshots,
//      and the inViewport / off-viewport flags plus summary counters agree.
//
// Run: node --test test-suite/unit/snapshot-injected.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snapshotPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/snapshot_injected.js");
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const snapshotSrc = fs.readFileSync(snapshotPath, "utf8");
const workerSrc = fs.readFileSync(workerPath, "utf8");

// Values produced inside a vm realm carry that realm's Object/Array prototypes, which
// node:assert/strict deepStrictEqual rejects. Normalize before structural comparison.
const toPlain = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// Minimal DOM shim (browser-facing surface snapshot_injected.js touches)
// ---------------------------------------------------------------------------

const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

function rect(x, y, width, height) {
  return { x, y, width, height, top: y, bottom: y + height, left: x, right: x + width };
}

// Concrete leading tags of a comma selector ("*" for attribute-only parts), used by the
// document query fast path to short-circuit selectors whose tags cannot exist in the tree.
function leadTags(sel) {
  const tags = [];
  for (const part of String(sel).split(",")) {
    const t = part.trim().match(/^[a-zA-Z][\w-]*/);
    tags.push(t ? t[0].toLowerCase() : "*");
  }
  return tags;
}

// Memoized nth-of-type positions: the library's uniqueness probes rebuild sibling lists per
// probe, so cache the same-tag child list per parent (the fixtures never mutate mid-snapshot).
const sibIndex = new WeakMap();
function nthOfTypeIndex(el) {
  const parent = el.parentElement;
  if (!parent) return 0;
  let byTag = sibIndex.get(parent);
  if (!byTag) {
    byTag = new Map();
    for (const child of parent.children) {
      const key = child.tagName;
      if (!byTag.has(key)) byTag.set(key, []);
      byTag.get(key).push(child);
    }
    sibIndex.set(parent, byTag);
  }
  const list = byTag.get(el.tagName) || [];
  return list.indexOf(el) + 1;
}

// Comma-separated CSS-ish selector matcher, compiled once per selector string and memoized so the
// library's per-candidate uniqueness probes (which scan the whole tree) stay cheap on the
// 8000-node budget fixtures. Supports the selectors the library actually uses: tag, #id, .class,
// [attr], [attr="v"], :nth-of-type(n), :not(...), and "*" (attribute-only selectors).
const selectorCache = new Map();

function matchesSelector(el, sel) {
  let pred = selectorCache.get(sel);
  if (!pred) {
    pred = compileSelector(sel);
    selectorCache.set(sel, pred);
  }
  return pred(el);
}

function compileSelector(sel) {
  const parts = String(sel).split(",").map((p) => compileSingle(p.trim()));
  return (el) => parts.some((p) => p(el));
}

function compileSingle(sel) {
  if (sel.startsWith(":not(")) {
    const inner = compileSingle(sel.slice(5, -1).trim());
    return (el) => !inner(el);
  }
  if (sel === ":invalid" || sel === ":required" || sel === ":root") return () => false;

  const nots = [];
  let rest = sel;
  let m;
  const notRe = /:not\(([^()]*)\)/g;
  while ((m = notRe.exec(sel)) !== null) nots.push(compileSingle(m[1].trim()));
  rest = rest.replace(/:\s*not\([^()]*\)/g, " ");

  let id = null;
  const idMatch = rest.match(/^#([a-zA-Z_][\w-]*)/);
  if (idMatch) {
    id = idMatch[1];
    rest = rest.slice(idMatch[0].length);
  }

  let tag = "*";
  const tagMatch = rest.match(/^[a-zA-Z][\w-]*/);
  if (tagMatch) {
    tag = tagMatch[0].toLowerCase();
    rest = rest.slice(tagMatch[0].length);
  }

  const classes = [...rest.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((cm) => cm[1]);
  const nth = [...rest.matchAll(/:nth-of-type\((\d+)\)/g)].map((nm) => Number(nm[1]));
  rest = rest.replace(/\.([a-zA-Z_][\w-]*)/g, " ").replace(/:nth-of-type\(\d+\)/g, " ");
  const attrs = [...rest.matchAll(/\[([^\]]+)\]/g)].map((am) => {
    const inside = am[1].trim();
    if (inside.includes("=")) {
      const eq = inside.indexOf("=");
      const name = inside.slice(0, eq).trim();
      let val = inside.slice(eq + 1).trim();
      if (/^["']/.test(val) && val.length >= 2) val = val.slice(1, -1);
      return (el) => el.getAttribute(name) === val;
    }
    return (el) => el.getAttribute(inside) !== null;
  });

  return (el) => {
    if (id !== null && el.id !== id) return false;
    if (tag !== "*" && el.tagName.toLowerCase() !== tag) return false;
    for (const c of classes) if (!el.classList.includes(c)) return false;
    if (nth.length) {
      if (nthOfTypeIndex(el) !== nth[0]) return false;
    }
    for (const a of attrs) if (!a(el)) return false;
    for (const n of nots) if (n(el)) return false;
    return true;
  };
}

// TEMP-PROFILE
const stats = { qsa: 0, qs: 0, qall: 0, walk: 0, matches: 0, rect: 0, style: 0 };

// Subtree query. Fast path for "#id" so the O(n²) uniqueness probes the library performs for
// every candidate selector stay cheap on the 8000-node budget fixtures.
function queryAll(root, sel) {
  stats.qall++;
  const out = [];
  const stack = [...(root.children || [])];
  if (sel[0] === "#" && !/[\\ >]/.test(sel)) {
    const id = sel.slice(1);
    while (stack.length) {
      const el = stack.pop();
      if (el.id === id) out.push(el);
      for (const child of el.children) stack.push(child);
    }
    return out;
  }
  while (stack.length) {
    const el = stack.pop();
    if (matchesSelector(el, sel)) out.push(el);
    for (const child of el.children) stack.push(child);
  }
  return out;
}

// Depth-first pre-order walker, one element per nextNode() (matches TreeWalker SHOW_ELEMENT).
function makeWalker(root) {
  const order = [];
  const stack = [];
  if (root.nodeType === ELEMENT_NODE) stack.push(root);
  else stack.push(...(root.children || []).slice().reverse());
  while (stack.length) {
    const el = stack.pop();
    order.push(el);
    stack.push(...(el.children || []).slice().reverse());
  }
  let i = 0;
  return { nextNode() { return i < order.length ? order[i++] : null; } };
}

class FakeShadowRoot {
  constructor(host) {
    this.nodeType = DOCUMENT_FRAGMENT_NODE;
    this.host = host;
    this.children = [];
    this.ownerDocument = host.ownerDocument;
  }
  appendChild(child) {
    child.parentElement = null; // shadow boundary: closest()/parent chain stops here
    child.ownerRoot = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  getElementById(id) { return queryAll(this, "#" + id)[0] || null; }
}

class FakeElement {
  constructor(tag, opts = {}) {
    this.nodeType = ELEMENT_NODE;
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...(opts.attrs || {}) };
    this.children = [];
    this.parentElement = null;
    this.ownerRoot = null;
    this.ownerDocument = opts.ownerDocument || null;
    this.shadowRoot = null; // open shadow root (pierced by the walker)
    this._closedShadow = null; // closed shadow content (opaque to the walker)
    this.rect = opts.rect || rect(0, 0, 100, 20);
    this.style = opts.style || {};
    this.id = this.attrs.id || "";
    this.className = this.attrs.class || "";
    this.classList = this.className.split(/\s+/).filter(Boolean);
    this._text = opts.text !== undefined ? opts.text : "";
    this.isConnected = opts.isConnected !== undefined ? opts.isConnected : true;
    this.__piChromeUid = undefined;
    this.value = opts.value !== undefined ? opts.value : "";
    this.checked = opts.checked !== undefined ? opts.checked : false;
    this.disabled = opts.disabled !== undefined ? opts.disabled : false;
    this.required = opts.required !== undefined ? opts.required : false;
    this.href = opts.href || this.attrs.href || "";
  }
  getAttribute(name) {
    const key = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
  }
  setAttribute(name, value) { this.attrs[String(name).toLowerCase()] = String(value); }
  matches(sel) { return matchesSelector(this, sel); }
  contains(node) {
    if (node === this) return true;
    if (this.children.some((c) => c.contains(node))) return true;
    if (this.shadowRoot && this.shadowRoot.children.some((c) => c.contains(node))) return true;
    return false;
  }
  getRootNode() { return this.ownerRoot || this.ownerDocument || null; }
  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur.matches && cur.matches(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  getBoundingClientRect() { stats.rect++; return { ...this.rect }; }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  scrollIntoView() {}
  get innerText() { return this._text; }
  get textContent() { return this._text; }
  appendChild(child) {
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }
  attachShadow({ mode = "open" } = {}) {
    const root = new FakeShadowRoot(this);
    if (mode === "open") this.shadowRoot = root;
    else this._closedShadow = root;
    return root;
  }
}

class FakeDocument {
  constructor() {
    this.nodeType = DOCUMENT_NODE;
    this.children = [];
    this.title = "Test Page";
    this.activeElement = null;
    this._hitTest = () => [];
    this._idIndex = null; // lazy id -> element map, invalidated on appendChild
    this._tagIndex = null; // lazy tag -> count map, invalidated on appendChild
  }
  get body() { return this._body || null; }
  set body(v) { this._body = v; }
  get documentElement() { return this.children[0] || null; }
  appendChild(child) {
    child.parentElement = null;
    child.ownerDocument = this;
    this.children.push(child);
    this._idIndex = null;
    this._tagIndex = null;
    return child;
  }
  _ensureIdIndex() {
    if (this._idIndex) return this._idIndex;
    const index = new Map();
    const stack = [...this.children];
    while (stack.length) {
      const el = stack.pop();
      if (el.id) {
        if (!index.has(el.id)) index.set(el.id, []);
        index.get(el.id).push(el);
      }
      for (const child of el.children) stack.push(child);
    }
    this._idIndex = index;
    return index;
  }
  _ensureTagIndex() {
    if (this._tagIndex) return this._tagIndex;
    const index = new Map();
    const stack = [...this.children];
    while (stack.length) {
      const el = stack.pop();
      index.set(el.tagName, (index.get(el.tagName) || 0) + 1);
      for (const child of el.children) stack.push(child);
    }
    this._tagIndex = index;
    return index;
  }
  createTreeWalker(root) { return makeWalker(root); }
  querySelector(sel) { stats.qs++; return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    stats.qsa++;
    // Document-level lookups use lazy indexes: #id probes resolve from the id map, and a
    // selector whose concrete leading tags are absent from the tree short-circuits to [] — the
    // O(n²) uniqueness/label probes the library performs hit these paths constantly.
    if (sel[0] === "#" && !/[\\ >]/.test(sel)) {
      return [...(this._ensureIdIndex().get(sel.slice(1)) || [])];
    }
    const tags = leadTags(sel);
    if (tags.every((t) => t !== "*")) {
      const tagIndex = this._ensureTagIndex();
      if (!tags.some((t) => (tagIndex.get(t) || 0) > 0)) return [];
    }
    return queryAll(this, sel);
  }
  getElementById(id) { return (this._ensureIdIndex().get(id) || [null])[0] || null; }
  elementsFromPoint(x, y) { return this._hitTest(x, y) || []; }
  elementFromPoint(x, y) { const s = this._hitTest(x, y) || []; return s[0] || null; }
}

function computedStyle(el) {
  const s = el.style || {};
  return {
    visibility: s.visibility ?? "visible",
    display: s.display ?? "block",
    pointerEvents: s.pointerEvents ?? "auto",
  };
}

// ---------------------------------------------------------------------------
// Page-world loader: fresh vm context per scenario with a controllable clock
// ---------------------------------------------------------------------------

function loadPageWorld({ clockStep = 0 } = {}) {
  let now = 1000;
  const ClockDate = { now: () => { const v = now; now += clockStep; return v; } };
  const doc = new FakeDocument();
  const html = new FakeElement("html", { attrs: { id: "__html__" } });
  doc.appendChild(html);
  const body = new FakeElement("body", { attrs: { id: "__body__" } });
  html.appendChild(body);
  doc.body = body;

  const sandbox = {
    console, JSON, Date: ClockDate, Math, Promise, Object, Array, String, Number, Boolean,
    Error, TypeError, Map, Set, Symbol, BigInt, structuredClone,
    Node: { ELEMENT_NODE, DOCUMENT_NODE, DOCUMENT_FRAGMENT_NODE },
    NodeFilter: { SHOW_ELEMENT: 1 },
    getComputedStyle: computedStyle,
    CSS: { escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
    location: { href: "https://example.com/page" },
    innerHeight: 600,
    innerWidth: 800,
    scrollX: 0,
    scrollY: 0,
    document: doc,
    addEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const state = {
    nextElementUid: 1,
    elements: {},
    rememberedCount: 0,
    meaningfulContainerCache: new Map(),
    console: [],
    network: [],
    nextRequestId: 1,
    instrumentationInstalled: true,
    lastSnapshotDigest: null,
  };
  sandbox.__PI_CHROME_STATE__ = state;

  vm.createContext(sandbox);
  vm.runInContext(snapshotSrc, sandbox, { filename: "snapshot_injected.js" });
  return { sandbox, doc, body, html, state, clock: { get now() { return now; } } };
}

function addButtons(body, n, { prefix = "btn", y = 0 } = {}) {
  for (let i = 1; i <= n; i++) {
    const b = new FakeElement("button", {
      attrs: { id: prefix + "-" + i },
      text: "Button " + i,
      rect: rect(0, y, 100, 20),
    });
    b.ownerDocument = body.ownerDocument;
    body.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Worker-world loader for mergeSubframeSnapshots (real service_worker.js)
// ---------------------------------------------------------------------------

function makeWorkerSandbox() {
  let now = 1000;
  const ClockDate = { now: () => now };
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  const sandbox = {
    console, JSON, Date: ClockDate, Math, Promise, Object, Array, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setTimeout, clearTimeout,
    setInterval: () => 0,
    clearInterval: noop,
    fetch: async () => { throw new Error("no network in unit test"); },
    navigator: { userAgent: "unit-test" },
    WebSocket: function () {},
    chrome: {
      runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null },
      alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
      action: { onClicked: listener, setBadgeText: noop, setBadgeBackgroundColor: noop },
      debugger: { sendCommand: noop, attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]), onDetach: listener, onEvent: listener },
      scripting: { executeScript: async () => [{ result: undefined }] },
      tabs: { onRemoved: listener, onUpdated: listener, query: async () => [], get: async () => ({}), create: async () => ({}), update: async () => ({}), remove: async () => {} },
      windows: { update: async () => {}, create: async () => ({}), remove: async () => {} },
      webNavigation: { onCommitted: listener, getAllFrames: async () => [] },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(workerSrc, sandbox, { filename: "service_worker.js" });
  } catch (err) {
    throw new Error("failed to load service_worker.js into the test sandbox: " + err.message);
  }
  return { sandbox, clock: { get now() { return now; }, set now(v) { now = v; } } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("1a. DOM budget stops the candidate walk after 8000 nodes", () => {
  const { sandbox, body } = loadPageWorld({ clockStep: 0 });
  addButtons(body, 8100, { prefix: "btn" });
  const t0 = performance.now();
  const snapshot = sandbox.__piChromeSnapshotPage(9000, null, null, null, "interactive", null, null);
  console.error("[perf] 1a full snapshotPage:", (performance.now() - t0).toFixed(0) + "ms", "elements:", snapshot.elements.length);
  console.error("[perf] stats:", JSON.stringify(stats));
  // html + body consume 2 of the 8000-node budget; the walk stops at node 8001, so exactly
  // 8000 - 2 candidates were collected (and no more, despite 8100 interactive buttons).
  assert.equal(snapshot.elements.length, 8000 - 2, "walk must stop at the 8000-node budget");
  assert.ok(snapshot.elements.length < 8100, "walk must not collect every button");
  assert.ok(snapshot.elements.every((el) => /^el-\d+$/.test(el.uid)), "candidates carry el- uids");
});

test("1b. DOM budget stops the walk when the wall-clock budget lapses", () => {
  // The clock advances 200ms per Date.now() call. createDomBudget samples the clock every
  // 64th node; the 250ms budget trips at the second sample (node 128), long before the
  // 8000-node cap, so only the first ~125 candidates survive.
  const { sandbox, body } = loadPageWorld({ clockStep: 200 });
  addButtons(body, 8100, { prefix: "btn" });
  const snapshot = sandbox.__piChromeSnapshotPage(9000, null, null, null, "interactive", null, null);
  assert.ok(snapshot.elements.length < 8000, "wall-clock lapse must stop the walk early");
  assert.equal(snapshot.elements.length, 125, "walk stops at the first lapsed clock sample (node 128)");
});

test("2. remembered-element eviction drops disconnected elements first, then lowest uid", () => {
  const { sandbox, doc, body, state } = loadPageWorld({ clockStep: 0 });
  // Seed 1995 remembered elements (3 disconnected) so a small real snapshot trips the cap.
  for (let i = 1; i <= 1995; i++) {
    state.elements["el-" + i] = { __piChromeUid: "el-" + i, isConnected: !(i === 100 || i === 200 || i === 300) };
  }
  state.rememberedCount = 1995;
  state.nextElementUid = 1996;

  for (let i = 1; i <= 10; i++) {
    const b = new FakeElement("button", { attrs: { id: "nb" + i }, text: "NB" + i, rect: rect(0, i * 20, 100, 20) });
    b.ownerDocument = doc;
    body.appendChild(b);
  }
  sandbox.__piChromeSnapshotPage(80, null, null, null, "interactive", null, null);

  // Disconnected elements are swept before any uid-based eviction…
  assert.equal(state.elements["el-100"], undefined, "disconnected el-100 evicted");
  assert.equal(state.elements["el-200"], undefined, "disconnected el-200 evicted");
  assert.equal(state.elements["el-300"], undefined, "disconnected el-300 evicted");
  // …then the lowest uid sequences are dropped to fit MAX_REMEMBERED_ELEMENTS=2000.
  assert.equal(state.elements["el-1"], undefined, "lowest uid el-1 evicted only after disconnected sweep");
  assert.equal(state.elements["el-2"], undefined, "lowest uid el-2 evicted");
  assert.equal(state.elements["el-3"]?.isConnected, true, "el-3 survives (uid-based eviction stops at the cap)");
  assert.equal(state.elements["el-2005"]?.isConnected, true, "newest remembered element survives");
  assert.equal(state.rememberedCount, 2000, "rememberedCount pinned to the cap");
  assert.equal(Object.keys(state.elements).length, 2000, "elements map sized to the cap");
  assert.equal(state.nextElementUid, 2006, "10 new uids were assigned");
});

test("3. host + open-shadow candidates collected, closed roots opaque", () => {
  const { sandbox, doc, body } = loadPageWorld({ clockStep: 0 });
  const mk = (tag, opts) => {
    const el = new FakeElement(tag, opts);
    el.ownerDocument = doc;
    body.appendChild(el);
    return el;
  };
  mk("button", { attrs: { id: "light" }, text: "Light button", rect: rect(0, 0, 100, 20) });
  const host = mk("x-widget", { attrs: { id: "host", role: "button" }, text: "Host button", rect: rect(0, 30, 100, 20) });
  const openRoot = host.attachShadow({ mode: "open" });
  openRoot.appendChild(new FakeElement("button", { attrs: { id: "in-shadow" }, text: "Shadow button", rect: rect(0, 0, 100, 20) }));
  openRoot.appendChild(new FakeElement("span", { attrs: { id: "deco" }, text: "deco", rect: rect(0, 0, 50, 10) }));
  const closedHost = mk("x-closed", { attrs: { id: "closedhost", role: "button" }, text: "Closed host", rect: rect(0, 60, 100, 20) });
  const closedRoot = closedHost.attachShadow({ mode: "closed" });
  closedRoot.appendChild(new FakeElement("button", { attrs: { id: "closed-inner" }, text: "Closed inner", rect: rect(0, 0, 100, 20) }));
  mk("a", { attrs: { id: "rolebtn", role: "button", href: "#" }, text: "Role button", rect: rect(0, 90, 100, 20) });
  mk("div", { attrs: { id: "tabzero", tabindex: "0" }, text: "Tabby", rect: rect(0, 120, 100, 20) });

  const snapshot = sandbox.__piChromeSnapshotPage(80, null, null, null, "interactive", null, null);
  const labels = toPlain(snapshot.elements.map((e) => e.label).sort());
  assert.deepEqual(labels, [
    "Closed host", "Host button", "Light button", "Role button", "Shadow button", "Tabby",
  ], "light-DOM and pierced open-shadow candidates are all collected");
  assert.ok(!labels.includes("Closed inner"), "closed shadow content must stay opaque");
  assert.ok(snapshot.elements.some((e) => e.shadowPath === true), "shadow elements are marked shadowPath");
});

test("4a. mergeSubframeSnapshots prefixes frame uids, tags frames, adds placeholders", async () => {
  const { sandbox } = makeWorkerSandbox();
  sandbox.chrome.webNavigation.getAllFrames = async () => [
    { frameId: 0, url: "https://example.com/top" },
    { frameId: 2, url: "https://example.com/f2" },
    { frameId: 3, url: "https://example.com/f3" },
  ];
  sandbox.runSnapshotPageInFrame = async (_tab, frameId) => {
    if (frameId === 3) throw new Error("frame boom");
    return {
      elements: [
        { uid: "el-7", tag: "button", label: "Go" },
        { uid: "el-8", tag: "input", label: "Name", context: { uid: "el-8", label: "Name" } },
      ],
    };
  };
  const snapshot = {
    elements: [{ uid: "el-1", tag: "a", label: "Top link" }, { uid: "el-2", tag: "button", label: "Save" }],
    summary: { totalInteractiveSampled: 2 },
  };
  await sandbox.mergeSubframeSnapshots({ id: 42 }, snapshot, [80, null, null, null, "auto", null, null, 8000, 250]);

  assert.equal(snapshot.elements.length, 5);
  assert.equal(snapshot.elements[0].uid, "el-1", "top-frame elements are untouched");
  assert.equal(snapshot.elements[0].frame, undefined, "top-frame elements carry no frame marker");
  assert.equal(snapshot.elements[2].uid, "el-f2-7", "sub-frame uid is prefixed el-f<frameId>-N");
  assert.equal(snapshot.elements[2].frame, 2, "sub-frame element tagged with its frameId");
  assert.deepEqual(toPlain(snapshot.elements[2].context), { frame: 2 }, "frame marker added to context");
  assert.deepEqual(toPlain(snapshot.elements[3].context), { uid: "el-8", label: "Name", frame: 2 }, "structured context preserved, frame marker added");
  const placeholder = snapshot.elements[4];
  assert.equal(placeholder.tag, "iframe", "failed frame becomes an iframe placeholder");
  assert.equal(placeholder.role, "iframe");
  assert.equal(placeholder.label, "https://example.com/f3");
  assert.equal(placeholder.context.frame, 3);
  assert.equal(snapshot.summary.totalInteractiveSampled, 2 + 3, "totalInteractiveSampled counts merged entries");
  assert.deepEqual(toPlain(snapshot.summary.subframes), { total: 2, snapshotted: 1, skipped: 0, merged: 3 });
});

test("4b. mergeSubframeSnapshots caps merged elements at SNAPSHOT_MAX_MERGED_ELEMENTS=400", async () => {
  const { sandbox } = makeWorkerSandbox();
  sandbox.chrome.webNavigation.getAllFrames = async () => [
    { frameId: 0, url: "https://example.com/top" },
    { frameId: 2, url: "https://example.com/f2" },
    { frameId: 3, url: "https://example.com/f3" },
  ];
  sandbox.runSnapshotPageInFrame = async (_tab, frameId) => {
    const n = frameId === 2 ? 250 : 200;
    return { elements: Array.from({ length: n }, (_, i) => ({ uid: "el-" + (i + 1), tag: "button", label: "F" + frameId + "-" + (i + 1) })) };
  };
  const top = Array.from({ length: 10 }, (_, i) => ({ uid: "el-" + (i + 1), tag: "a", label: "T" + (i + 1) }));
  const snapshot = { elements: top.slice(), summary: { totalInteractiveSampled: 10 } };
  await sandbox.mergeSubframeSnapshots({ id: 42 }, snapshot, [80, null, null, null, "auto", null, null, 8000, 250]);

  assert.equal(snapshot.elements.length, 400, "merged array capped at max(10, 400)");
  assert.equal(snapshot.elements[0].uid, "el-1");
  assert.equal(snapshot.elements[9].uid, "el-10", "all top-frame elements survive the cap");
  assert.equal(snapshot.elements[10].uid, "el-f2-1", "frame elements follow the top frame");
  assert.equal(snapshot.elements[399].uid, "el-f3-140", "10 top + 250 frame2 + 140 of frame3 fit under the cap");
  assert.ok(!snapshot.elements.some((e) => e.uid === "el-f3-200"), "frame elements beyond the cap are dropped");
  assert.equal(snapshot.summary.totalInteractiveSampled, 10 + 450, "accounting counts all merged extras (uncapped)");
  assert.deepEqual(toPlain(snapshot.summary.subframes), { total: 2, snapshotted: 2, skipped: 0, merged: 450 });
});

test("4c. mergeSubframeSnapshots lists budget-skipped frames as placeholders", async () => {
  const { sandbox, clock } = makeWorkerSandbox();
  sandbox.chrome.webNavigation.getAllFrames = async () => [
    { frameId: 0, url: "https://example.com/top" },
    { frameId: 2, url: "https://example.com/f2" },
    { frameId: 3, url: "https://example.com/f3" },
    { frameId: 4, url: "https://example.com/f4" },
    { frameId: 5, url: "https://example.com/f5" },
    { frameId: 6, url: "https://example.com/f6" },
  ];
  let release;
  const gate = new Promise((r) => { release = r; });
  sandbox.runSnapshotPageInFrame = async () => { await gate; return { elements: [{ uid: "el-1", tag: "button" }] }; };
  const snapshot = { elements: [{ uid: "el-1", tag: "a" }], summary: { totalInteractiveSampled: 1 } };
  const pending = sandbox.mergeSubframeSnapshots({ id: 42 }, snapshot, [80, null, null, null, "auto", null, null, 8000, 250]);
  await new Promise((r) => setTimeout(r, 20)); // let the 4 workers reach the gate
  clock.now += 20_000; // 20s > SUBFRAME_SNAPSHOT_BUDGET_MS (10s)
  release();
  await pending;

  const placeholders = snapshot.elements.filter((e) => e.tag === "iframe");
  assert.equal(placeholders.length, 1, "the frame claimed after the budget lapsed is a placeholder");
  assert.equal(placeholders[0].context.frame, 6, "skipped frame is the one past the budget");
  assert.equal(snapshot.summary.subframes.total, 5);
  assert.equal(snapshot.summary.subframes.snapshotted, 4);
  assert.equal(snapshot.summary.subframes.skipped, 1);
  assert.equal(snapshot.summary.subframes.merged, 5, "4 element sets + 1 placeholder");
  assert.equal(snapshot.summary.totalInteractiveSampled, 1 + 5);
});

test("4d. mergeSubframeSnapshots is a no-op without sub-frames", async () => {
  const { sandbox } = makeWorkerSandbox();
  sandbox.chrome.webNavigation.getAllFrames = async () => [{ frameId: 0, url: "https://example.com/top" }];
  const snapshot = { elements: [{ uid: "el-1", tag: "a" }], summary: { totalInteractiveSampled: 1 } };
  await sandbox.mergeSubframeSnapshots({ id: 42 }, snapshot, [80, null, null, null, "auto", null, null, 8000, 250]);
  assert.equal(snapshot.elements.length, 1, "elements untouched");
  assert.equal(snapshot.summary.totalInteractiveSampled, 1);
  assert.equal(snapshot.summary.subframes, undefined, "no subframe summary emitted");
});

test("5. el- uid scheme is stable and viewport/off-viewport flags are consistent", () => {
  const { sandbox, doc, body, state } = loadPageWorld({ clockStep: 0 });
  body._text = "Welcome\nA test page paragraph.";
  const mk = (tag, opts) => {
    const el = new FakeElement(tag, opts);
    el.ownerDocument = doc;
    body.appendChild(el);
    return el;
  };
  mk("h1", { attrs: { id: "title" }, text: "Welcome", rect: rect(0, 10, 300, 30) });
  mk("p", { attrs: { id: "intro" }, text: "A test page paragraph.", rect: rect(0, 50, 300, 20) });
  mk("a", { attrs: { id: "top", href: "#top" }, text: "Top link", rect: rect(0, 90, 100, 20) });
  mk("button", { attrs: { id: "save" }, text: "Save", rect: rect(0, 130, 100, 20) });
  mk("input", { attrs: { id: "email", type: "email" }, text: "", value: "alice@example.com", rect: rect(0, 170, 200, 20) });
  mk("textarea", { attrs: { id: "msg" }, text: "Hello", rect: rect(0, 210, 200, 40) });
  mk("div", { attrs: { id: "wrap" }, text: "Footer link", rect: rect(0, 930, 780, 40) });
  mk("a", { attrs: { id: "footer", href: "#footer" }, text: "Footer link", rect: rect(0, 950, 100, 20) });
  mk("select", { attrs: { id: "kind" }, text: "", rect: rect(0, 300, 120, 20) });

  const snapshot = sandbox.__piChromeSnapshotPage(80, null, null, null, "auto", null, null);

  // el- uid scheme: sequential, unique, assigned to candidates in sorted order.
  assert.ok(snapshot.elements.every((e) => /^el-\d+$/.test(e.uid)), "every element carries an el- uid");
  assert.equal(new Set(snapshot.elements.map((e) => e.uid)).size, snapshot.elements.length, "uids are unique");
  assert.equal(snapshot.elements[0].uid, "el-1", "first candidate gets el-1");

  // In-viewport-first ordering with a below-fold element sampled last.
  assert.deepEqual(toPlain(snapshot.elements.map((e) => e.selector)), ["#top", "#save", "#email", "#msg", "#kind", "#footer"]);

  // Viewport / aboveFold-style flags behave.
  assert.ok(snapshot.elements.every((e) => typeof e.inViewport === "boolean"), "every element carries an inViewport flag");
  assert.equal(snapshot.elements.filter((e) => e.inViewport).length, 5, "five candidates are in the 600px viewport");
  assert.equal(snapshot.elements.find((e) => e.selector === "#footer").inViewport, false, "below-fold element flagged off-viewport");
  assert.equal(snapshot.elements.find((e) => e.selector === "#email").value, "alice@example.com", "form values survive non-sensitive fields");

  // Summary counters agree with the returned elements array.
  assert.equal(snapshot.summary.totalInteractiveSampled, snapshot.elements.length);
  assert.equal(snapshot.summary.visibleInteractiveCount, 5);
  assert.equal(snapshot.summary.offViewportSampled, 1);
  assert.equal(snapshot.summary.offViewportTotal, 1);
  assert.ok(snapshot.summary.hints.some((h) => h.includes("below the fold")), "off-viewport hint surfaced");

  // auto mode payloads still compute (text + pageMap).
  assert.ok(snapshot.text.includes("Welcome"), "auto mode carries body text");
  assert.equal(snapshot.pageMap.headings[0].text, "Welcome", "pageMap headings populated");

  // uid stability across snapshots: same element, same uid, no per-snapshot leak.
  const uidCountAfterFirst = Object.keys(state.elements).length;
  const again = sandbox.__piChromeSnapshotPage(80, null, null, null, "auto", null, null);
  assert.equal(again.elements[0].uid, "el-1", "uid reused across snapshots");
  assert.deepEqual(toPlain(again.elements.map((e) => e.selector)), toPlain(snapshot.elements.map((e) => e.selector)), "element set stable");
  assert.equal(Object.keys(state.elements).length, uidCountAfterFirst, "no uid leak on re-snapshot");
});
