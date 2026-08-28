// Unit harness for the CSP-bypass layer in service_worker.js.
//
// The real CSP bypass (CDP Runtime.evaluate not being subject to page CSP) can only be
// proven in a browser — see challenge 39-strict-csp-fallback. These tests instead validate
// the JS *logic* of the refactor that the bypass depends on:
//   - evaluateInTab: wrapper-string construction, expression/statement fallback, value
//     marker round-trip (undefined/function/symbol/bigint/Error/DOMRect), error propagation.
//   - executeInTab: 2-phase define-then-invoke, envelope unwrap, error propagation, and that
//     all real HELPER_FUNCS serialize+assign without a parse error.
//   - page.waitFor: service-worker-side polling via evaluateInTab (selector + expression).
//
// We load the worker into a vm sandbox with mocked chrome.* APIs, then replace `cdp` with a
// shim that evaluates the expression in a separate "page world" vm context (simulating CDP
// Runtime.evaluate returnByValue). No browser, no network, no deps.

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

// ---- page world: simulates the page's MAIN world for Runtime.evaluate ----
const pageGlobals = {
  console, JSON, Date, Math, Promise, Object, Array, String, Number, Boolean,
  Error, TypeError, SyntaxError, RangeError, BigInt, Symbol, structuredClone,
  setTimeout, parseInt, parseFloat, isNaN,
  document: {
    title: "page title",
    _present: new Set(),
    querySelector(sel) { return this._present.has(sel) ? { sel } : null; },
  },
};
pageGlobals.window = pageGlobals;
pageGlobals.globalThis = pageGlobals;
const pageWorld = vm.createContext(pageGlobals);

// Simulate CDP Runtime.evaluate returnByValue serialization.
function toCdpResult(v) {
  if (v === undefined) return { result: { type: "undefined" } };
  if (v === null) return { result: { type: "object", subtype: "null", value: null } };
  const t = typeof v;
  if (t === "number" || t === "string" || t === "boolean")
    return { result: { type: t, value: v } };
  // object/array: returnByValue deep-clones JSON-able structures
  return { result: { type: "object", value: JSON.parse(JSON.stringify(v)) } };
}

// ---- worker sandbox ----
const noop = () => {};
const listener = { addListener: noop, removeListener: noop };
const sandbox = {
  console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
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
    action: { onClicked: listener },
    debugger: { sendCommand: noop, attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]) },
    scripting: { executeScript: async () => [{ result: undefined }] },
    tabs: { query: async () => [], get: async () => ({}), create: async () => ({}), update: async () => ({}), remove: async () => {} },
    windows: { update: async () => {} },
    webNavigation: { onCommitted: listener },
  },
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

// ---- override the page-touching primitives with the page-world shim ----
sandbox.attachDebugger = async () => ({});
sandbox.bringToFront = async () => {};
sandbox.getTabByParams = async (p) => ({ id: (p && p.targetId) || 1, windowId: 1 });
sandbox.cdp = async (_tabId, method, params) => {
  if (method !== "Runtime.evaluate") return {};
  try {
    const value = await vm.runInContext(params.expression, pageWorld);
    return toCdpResult(value);
  } catch (e) {
    return { exceptionDetails: { exception: { className: e.name, description: String(e.stack || e.message) }, text: "Uncaught " + String(e) } };
  }
};
// Phase-2 of executeInTab: run the injected wrapper func against the page world,
// where Phase-1 (via cdp shim above) already defined window.__piAction + helpers.
sandbox.chrome.scripting.executeScript = async ({ func, args }) => {
  const fn = vm.runInContext("(" + func.toString() + ")", pageWorld);
  const result = await fn(...(args || []));
  return [{ result }];
};

const { evaluateInTab, executeInTab, dispatch } = sandbox;

async function run() {
  // ===== evaluateInTab: primitives & objects =====
  ok((await evaluateInTab({ expression: "2 + 2" })) === 4, "evaluate: arithmetic expression");
  ok((await evaluateInTab({ expression: "document.title" })) === "page title", "evaluate: expression without return");
  ok((await evaluateInTab({ expression: "'a' + 'b'" })) === "ab", "evaluate: string concat");
  const obj = await evaluateInTab({ expression: "({a:1, b:[2,3]})" });
  ok(obj && obj.a === 1 && obj.b[1] === 3, "evaluate: object literal round-trips");

  // ===== value markers =====
  ok((await evaluateInTab({ expression: "void 0" })) === undefined, "evaluate: undefined marker -> undefined");
  ok((await evaluateInTab({ expression: "10n" })) === "10", "evaluate: bigint marker -> string");
  ok(/^\[Function:/.test(await evaluateInTab({ expression: "(function foo(){})" })), "evaluate: function marker");
  // symbol marker (advertised in the header, was never asserted)
  ok((await evaluateInTab({ expression: "Symbol('symA')" })) === "[Symbol: symA]", "evaluate: symbol marker -> [Symbol: desc]");
  // Error value marker: the wrapper must throw the unwrapped Error (message + name preserved)
  await throwsWith(() => evaluateInTab({ expression: "new Error('marker-boom')" }), /marker-boom/, "evaluate: Error value marker propagates");
  ok((await evaluateInTab({ expression: "Promise.resolve(42)" })) === 42, "evaluate: promise is awaited");

  // DOMRect-like (toJSON + width/height/top) is expanded, not flattened to {}
  const rect = await evaluateInTab({ expression: "({ x:1,y:2,width:3,height:4,top:2,right:4,bottom:6,left:1, toJSON(){return {}} })" });
  ok(rect && rect.width === 3 && rect.bottom === 6, "evaluate: DOMRect-like expanded");

  // ===== statement-form fallback (expression form is a SyntaxError) =====
  // `let x=...; x` is not a valid expression, so the wrapper must retry as a statement body.
  ok((await evaluateInTab({ expression: "let x = 5; x" })) === undefined, "evaluate: statement form falls back (no return -> undefined)");
  ok((await evaluateInTab({ expression: "let y = 7; return y" })) === 7, "evaluate: statement form with explicit return");

  // ===== error propagation =====
  await throwsWith(() => evaluateInTab({ expression: "throw new Error('boom')" }), /chrome_evaluate failed[\s\S]*boom/, "evaluate: runtime error propagates");

  // ===== executeInTab: 2-phase define + invoke =====
  // Real HELPER_FUNCS get serialized + assigned in Phase 1; a parse error there would throw here.
  const sum = await executeInTab({ targetId: 1 }, function add(a, b) { return a + b; }, [3, 4]);
  ok(sum === 7, "executeInTab: action runs with args after helper injection");

  const asyncResult = await executeInTab({ targetId: 1 }, async function asyncEcho(v) { return v * 2; }, [21]);
  ok(asyncResult === 42, "executeInTab: async action awaited");

  await throwsWith(
    () => executeInTab({ targetId: 1 }, function boom() { throw new Error("action failed"); }, []),
    /action failed/,
    "executeInTab: thrown action error propagates via envelope",
  );

  // ===== page.waitFor (service-worker-side polling) =====
  pageGlobals.document._present.add("#ready");
  const wf = await dispatch("page.waitFor", { targetId: 1, kind: "selector", value: "#ready", timeoutMs: 1000, intervalMs: 20 });
  ok(wf && typeof wf.elapsedMs === "number", "waitFor: selector present resolves");

  const wfExpr = await dispatch("page.waitFor", { targetId: 1, kind: "expression", value: "1 === 1", timeoutMs: 1000, intervalMs: 20 });
  ok(wfExpr && typeof wfExpr.elapsedMs === "number", "waitFor: truthy expression resolves");

  await throwsWith(
    () => dispatch("page.waitFor", { targetId: 1, kind: "selector", value: "#never", timeoutMs: 120, intervalMs: 30 }),
    /Timed out after 120ms/,
    "waitFor: missing selector times out",
  );

  // ===== usKeyLayoutForChar / cdpKeyInfo: US-layout key codes =====
  // Regression: punctuation must NOT use charCodeAt() (".":46 collides with VK_DELETE,
  // "-":45 with VK_INSERT), which made apps drop the char on keydown. This is now a
  // table-driven spec over every ASCII printable so the layout tables and the type path's
  // duplicated shift predicate cannot silently diverge again.
  const { usKeyLayoutForChar, cdpKeyInfo } = sandbox;

  // Independent US-layout spec, written as literals (not derived from the worker) so a
  // change to the tables in service_worker.js must be consciously mirrored here.
  const SHIFT_DIGIT_SPEC = { ")": "0", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9" };
  const PUNCT_SPEC = {
    "`": { code: "Backquote", keyCode: 192 }, "~": { code: "Backquote", keyCode: 192, needShift: true },
    "-": { code: "Minus", keyCode: 189 }, "_": { code: "Minus", keyCode: 189, needShift: true },
    "=": { code: "Equal", keyCode: 187 }, "+": { code: "Equal", keyCode: 187, needShift: true },
    "[": { code: "BracketLeft", keyCode: 219 }, "{": { code: "BracketLeft", keyCode: 219, needShift: true },
    "]": { code: "BracketRight", keyCode: 221 }, "}": { code: "BracketRight", keyCode: 221, needShift: true },
    "\\": { code: "Backslash", keyCode: 220 }, "|": { code: "Backslash", keyCode: 220, needShift: true },
    ";": { code: "Semicolon", keyCode: 186 }, ":": { code: "Semicolon", keyCode: 186, needShift: true },
    "'": { code: "Quote", keyCode: 222 }, "\"": { code: "Quote", keyCode: 222, needShift: true },
    ",": { code: "Comma", keyCode: 188 }, "<": { code: "Comma", keyCode: 188, needShift: true },
    ".": { code: "Period", keyCode: 190 }, ">": { code: "Period", keyCode: 190, needShift: true },
    "/": { code: "Slash", keyCode: 191 }, "?": { code: "Slash", keyCode: 191, needShift: true },
    " ": { code: "Space", keyCode: 32 },
  };
  // The type path duplicates the shift decision as /^[A-Z]$/ || "~!@#$%^&*()_+{}|:\"<>?".includes(ch)
  // in both cdpTypeChar and the DOM-event typeCharacter fallback. Pin it here so the
  // duplication cannot silently diverge from the layout tables again.
  const typePathNeedsShift = (ch) => /^[A-Z]$/.test(ch) || "~!@#$%^&*()_+{}|:\"<>?".includes(ch);
  const expectedLayout = (ch) => {
    if (/^[a-z]$/.test(ch)) return { code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), needShift: false };
    if (/^[A-Z]$/.test(ch)) return { code: `Key${ch}`, keyCode: ch.charCodeAt(0), needShift: true };
    if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, keyCode: ch.charCodeAt(0), needShift: false };
    if (SHIFT_DIGIT_SPEC[ch]) { const d = SHIFT_DIGIT_SPEC[ch]; return { code: `Digit${d}`, keyCode: d.charCodeAt(0), needShift: true }; }
    const p = PUNCT_SPEC[ch];
    if (p) return { code: p.code, keyCode: p.keyCode, needShift: !!p.needShift };
    throw new Error(`no expected layout for ${JSON.stringify(ch)}`);
  };
  let layoutBad = 0;
  for (let i = 0x20; i <= 0x7e; i++) {
    const ch = String.fromCharCode(i);
    const exp = expectedLayout(ch);
    const got = usKeyLayoutForChar(ch);
    if (got.code !== exp.code || got.keyCode !== exp.keyCode || got.needShift !== exp.needShift) {
      layoutBad++;
      ok(false, `keylayout: ${JSON.stringify(ch)} -> ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`);
    }
  }
  ok(layoutBad === 0, "keylayout: all 95 ASCII printables resolve per US-layout spec");
  // Pin the historical charCodeAt() collisions explicitly so a regression is obvious.
  const period = usKeyLayoutForChar(".");
  ok(period.code === "Period" && period.keyCode === 190 && !period.needShift, "keylayout: '.' -> Period/190 (not 46/VK_DELETE)");
  const dash = usKeyLayoutForChar("-");
  ok(dash.code === "Minus" && dash.keyCode === 189 && !dash.needShift, "keylayout: '-' -> Minus/189 (not 45/VK_INSERT)");
  const slash = usKeyLayoutForChar("/");
  ok(slash.code === "Slash" && slash.keyCode === 191 && !slash.needShift, "keylayout: '/' -> Slash/191");
  // Shifted digit symbols must land on their digit's physical key (code/keyCode) with shift.
  let shiftDigitBad = 0;
  for (const sym of Object.keys(SHIFT_DIGIT_SPEC)) {
    const exp = expectedLayout(sym);
    const got = usKeyLayoutForChar(sym);
    if (got.code !== exp.code || got.keyCode !== exp.keyCode || got.needShift !== true) {
      shiftDigitBad++;
      ok(false, `keylayout: shift-digit ${JSON.stringify(sym)} -> ${JSON.stringify(got)} expected ${exp.code}/${exp.keyCode}+shift`);
    }
  }
  ok(shiftDigitBad === 0, `keylayout: every SHIFT_DIGIT symbol (${Object.keys(SHIFT_DIGIT_SPEC).length}) maps to its digit key + shift`);
  // The type path's duplicated shift predicate must agree with the layout tables for every char.
  let shiftAgreeBad = 0;
  for (let i = 0x20; i <= 0x7e; i++) {
    const ch = String.fromCharCode(i);
    if (typePathNeedsShift(ch) !== usKeyLayoutForChar(ch).needShift) {
      shiftAgreeBad++;
      ok(false, `keylayout: type-path shift predicate disagrees with layout for ${JSON.stringify(ch)}`);
    }
  }
  ok(shiftAgreeBad === 0, "keylayout: type-path shift predicate agrees with layout tables for all ASCII printables");
  // Unknown (non-ASCII) chars must fall back to text-driven insertion, not a bogus keyCode.
  const unicode = usKeyLayoutForChar("é");
  ok(unicode.code === "é" && unicode.keyCode === 0 && !unicode.needShift, "keylayout: non-ASCII char falls back to text-driven (keyCode 0)");
  // cdpKeyInfo must delegate single chars to the same layout and keep named keys untouched.
  let cdpInfoBad = 0;
  for (let i = 0x20; i <= 0x7e; i++) {
    const ch = String.fromCharCode(i);
    const info = cdpKeyInfo(ch);
    const layout = usKeyLayoutForChar(ch);
    if (info.code !== layout.code || info.windowsVirtualKeyCode !== layout.keyCode || info.text !== ch) {
      cdpInfoBad++;
      ok(false, `cdpKeyInfo: ${JSON.stringify(ch)} -> ${JSON.stringify(info)} expected code ${layout.code} vk ${layout.keyCode} text ${JSON.stringify(ch)}`);
    }
  }
  ok(cdpInfoBad === 0, "cdpKeyInfo: all ASCII printables keep code/vk/text consistent with the layout");
  const ent = cdpKeyInfo("Enter");
  ok(ent.code === "Enter" && ent.windowsVirtualKeyCode === 13, "cdpKeyInfo: named key 'Enter' unaffected");

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
