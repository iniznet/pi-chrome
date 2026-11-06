// Unit harness for the shared in-page colour probe (CSS_CONTRAST_PROBE_SRC) that both
// chrome_css_audit and chrome_a11y_audit resolve colours through.
//
// Why it exists (pi-trackers#116): a computed colour keeps its colour space, so
// `oklch(0.52 0.014 260)` read back as a string and a numeric parse of it scored the oklch
// channels as 0-255 RGB — a legible 5.29:1 pair was reported as 1.00:1 and counted as a failure.
// The probe paints a 1x1 canvas and reads the pixel back so the engine resolves the colour, and a
// value the engine refuses must come back as unresolved, never as a contrast failure.
//
// The probe source is evaluated against a fake canvas that mimics Chrome: a colour it accepts
// serializes back unchanged, an unparseable assignment leaves the previous fillStyle in place, and
// getImageData returns the sRGB bytes measured in the live browser.
//
// Run: node --test test-suite/unit/css-contrast.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const workerSrc = fs.readFileSync(workerPath, "utf8");

// Measured in the live browser: fillStyle = colour, then getImageData -> sRGB bytes.
const PIXEL = {
  "oklch(0.52 0.014 260)": [100, 105, 113, 255],
  "oklch(0.985 0.002 260)": [251, 250, 250, 255],
  "oklch(0.52 0.014 260 / 0.5)": [100, 105, 113, 128],
  "rgb(170, 170, 170)": [170, 170, 170, 255],
  "rgb(255, 255, 255)": [255, 255, 255, 255],
};

function fakeCanvas(options = {}) {
  if (options.noContext) return { getContext: () => null, width: 1, height: 1 };
  let fill = "#000000";
  const ctx = {
    get fillStyle() { return fill; },
    set fillStyle(value) {
      const text = String(value);
      // Chrome serializes a value it accepts; anything else leaves the previous value in place.
      if (PIXEL[text] || /^#[0-9a-f]{3,8}$/i.test(text) || /^(rgb|hsl)a?\(/i.test(text)) fill = text;
    },
    clearRect() {},
    fillRect() {},
    getImageData() {
      if (options.throwOnRead) throw new Error("SecurityError: the canvas is tainted");
      return { data: Uint8ClampedArray.from(PIXEL[fill] || [0, 0, 0, 0]) };
    },
  };
  return { getContext: () => ctx, width: 1, height: 1 };
}

function extractProbeSource(source) {
  const marker = "const CSS_CONTRAST_PROBE_SRC = `";
  const start = source.indexOf(marker);
  assert.ok(start > 0, "CSS_CONTRAST_PROBE_SRC must exist in service_worker.js");
  const from = start + marker.length;
  const end = source.indexOf("\n`;", from);
  assert.ok(end > from, "CSS_CONTRAST_PROBE_SRC must be a template literal");
  // The probe carries no escapes and no interpolation, so the raw slice is its source text.
  return source.slice(from + 1, end + 1);
}

const probeSrc = extractProbeSource(workerSrc);

function loadProbe(canvasOptions = {}) {
  const context = vm.createContext({ document: { createElement: () => fakeCanvas(canvasOptions) } });
  return vm.runInContext(`(() => {\n${probeSrc}\nreturn piProbe;\n})()`, context);
}

test("an oklch pair resolves to sRGB before the ratio", () => {
  const probe = loadProbe();
  const fg = probe.piSrgb("oklch(0.52 0.014 260)");
  const bg = probe.piSrgb("oklch(0.985 0.002 260)");
  assert.deepEqual(Array.from(fg), [100, 105, 113, 1]);
  assert.deepEqual(Array.from(bg), [251, 250, 250, 1]);
  const verdict = probe.piVerdict(fg, bg, 4.5);
  // The pre-fix numeric parse scored this pair 1.00:1 and counted a failure.
  assert.equal(verdict.verdict, "ok");
  assert.ok(verdict.ratio > 5.2 && verdict.ratio < 5.4, `expected ~5.29:1, got ${verdict.ratio}`);
});

test("a genuine failure is still reported", () => {
  const probe = loadProbe();
  const verdict = probe.piVerdict(probe.piSrgb("rgb(170, 170, 170)"), probe.piSrgb("rgb(255, 255, 255)"), 4.5);
  assert.equal(verdict.verdict, "low");
  assert.ok(verdict.ratio > 2.2 && verdict.ratio < 2.4, `expected ~2.32:1, got ${verdict.ratio}`);
});

test("a colour the engine refuses is unresolved, not a failure", () => {
  const probe = loadProbe();
  assert.equal(probe.piSrgb("nonsense(1 2 3)"), null);
  const verdict = probe.piVerdict(probe.piSrgb("nonsense(1 2 3)"), probe.piSrgb("rgb(255, 255, 255)"), 4.5);
  assert.equal(verdict.verdict, "unresolved");
  assert.equal(verdict.ratio, null);
});

test("a page that removed 2D contexts resolves nothing and never throws", () => {
  const probe = loadProbe({ noContext: true });
  assert.equal(probe.piSrgb("oklch(0.52 0.014 260)"), null);
  assert.equal(probe.piVerdict(null, null, 4.5).verdict, "unresolved");
});

test("a throwing pixel readback is unresolved, not a crash", () => {
  const probe = loadProbe({ throwOnRead: true });
  assert.equal(probe.piSrgb("oklch(0.52 0.014 260)"), null);
});

test("alpha is reported so a translucent ground is walked past", () => {
  const probe = loadProbe();
  const translucent = probe.piSrgb("oklch(0.52 0.014 260 / 0.5)");
  assert.equal(translucent[3], 128 / 255);
  assert.equal(probe.piOpaque(translucent), false);
  assert.equal(probe.piOpaque(probe.piSrgb("rgb(255, 255, 255)")), true);
});

test("one colour parser survives: both audits share the probe", () => {
  const uses = workerSrc.split("${CSS_CONTRAST_PROBE_SRC}").length - 1;
  assert.equal(uses, 2, "the css audit expression and the a11y callFunctionOn must interpolate the probe");
  assert.equal(/function colorLuminance/.test(workerSrc), false, "the a11y host-side colour parser must be gone");
  assert.ok(/counts\.unresolvedContrast\+\+/.test(workerSrc), "the css audit must count unresolved nodes");
});
