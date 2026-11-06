// pi-trackers#117 — a background chrome_* call must never take the OS foreground, and a capture
// must not depend on the window being focused.
//
// Two promises are pinned here:
//   (1) activation and window focus are separate acts: bringToFront(tab, focusWindowRequested)
//       activates the tab always, and moves the OS foreground only when the flag is true. This is
//       exercised behaviourally against a stub chrome API, not just grepped.
//   (2) the screenshot path no longer reads chrome.tabs.captureVisibleTab, which needs an active
//       tab inside a focused window. Behind another app it raised the window and failed with
//       "image readback failed" (or hung for 25 s), which is the reported defect.
//
// Host side (index.ts cannot be imported standalone: it loads the pi SDK) is asserted at source
// level, like p0-tools.test.mjs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/index.ts");
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const indexSrc = fs.readFileSync(indexPath, "utf8");
const workerSrc = fs.readFileSync(workerPath, "utf8");

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---- (1) activation and focus are separate ------------------------------------------------
const splitStart = workerSrc.indexOf("async function activateTab(tab) {");
const splitEnd = workerSrc.indexOf("}", workerSrc.indexOf("if (focusWindowRequested) await focusWindow(tab);")) + 1;
ok(splitStart > 0 && splitEnd > splitStart, "service worker defines activateTab / focusWindow / bringToFront");

const chunk = splitStart > 0 && splitEnd > splitStart ? workerSrc.slice(splitStart, splitEnd) : "";
ok(/async function bringToFront\(tab, focusWindowRequested\)/.test(chunk), "bringToFront takes an explicit focus flag");

if (chunk) {
  const recordFocusCalls = async (flag) => {
    const calls = [];
    const chrome = {
      tabs: { update: async (id, props) => { calls.push({ api: "tabs.update", id, props }); return { id, ...props }; } },
      windows: { update: async (id, props) => { calls.push({ api: "windows.update", id, props }); return {}; } },
    };
    const mod = new Function("chrome", chunk + "\nreturn { activateTab, focusWindow, bringToFront };");
    const api = mod(chrome);
    await api.bringToFront({ id: 5, windowId: 9 }, flag);
    return calls;
  };
  const background = await recordFocusCalls(false);
  ok(background.some((c) => c.api === "tabs.update" && c.props.active === true), "a background bringToFront still activates the tab");
  ok(!background.some((c) => c.api === "windows.update"), "a background bringToFront never touches the OS foreground");
  const foreground = await recordFocusCalls(true);
  ok(foreground.some((c) => c.api === "windows.update" && c.props.focused === true), "an explicit focus request does focus the window");
}

const focusedTrue = workerSrc.split("\n").map((line, i) => ({ line, n: i + 1 })).filter((e) => /focused:\s*true/.test(e.line));
ok(focusedTrue.length === 1, `exactly one focused:true site remains (found ${focusedTrue.length})`);
ok(focusedTrue.every((entry) => {
  const at = workerSrc.split("\n").slice(0, entry.n - 1).join("\n").length;
  const owner = workerSrc.slice(workerSrc.lastIndexOf("async function", at)).slice(0, 120);
  return /async function focusWindow\(tab\)/.test(owner);
}), "the remaining focused:true sits inside focusWindow");

// ---- (2) the capture path is focus-independent ---------------------------------------------
ok(!/chrome\.tabs\.captureVisibleTab\s*\(/.test(workerSrc), "no chrome.tabs.captureVisibleTab call remains: captures no longer need a focused window");
ok(/async function captureViewportViaCdp\(tab, params\)/.test(workerSrc), "the viewport capture goes through CDP");
const takeStart = workerSrc.indexOf("async function takeScreenshot(params) {");
const takeEnd = workerSrc.indexOf("\n}", takeStart);
const take = takeStart >= 0 ? workerSrc.slice(takeStart, takeEnd) : "";
ok(/captureViewportViaCdp\(tab, params\)/.test(take), "takeScreenshot delegates the viewport capture to CDP");
ok(!/chrome\.tabs\.captureVisibleTab\s*\(/.test(take), "takeScreenshot calls no visible-tab capture");
ok(!/previousActiveId/.test(take), "takeScreenshot has no activate-and-restore dance");
ok(/captureFullPageViaCdp\(tab, params\)/.test(take), "the full-page path stays on the CDP single shot");
ok(!/scrollToY|captureFullPageTiles/.test(workerSrc), "the scrolling tile fallback is gone");

const createParams = workerSrc.slice(workerSrc.indexOf("const createParams = {"), workerSrc.indexOf("const createParams = {") + 160);
ok(/active: params\.foreground === true/.test(createParams), "tab.new activates only on an explicit foreground");
ok(!/active: true/.test(createParams), "tab.new does not hard-code activation");
ok(/if \(params\.focusWindow\) await focusWindow\(tab\);/.test(workerSrc), "tab.activate focuses the window only on an explicit request");

// ---- (3) host: focus is explicit only ------------------------------------------------------
ok(/focusWindow: typed\.background === false \|\| typed\.foreground === true/.test(indexSrc), "withBackground sends focusWindow only for an explicit request");
ok(/focusWindow: wireParams\.background === false/.test(indexSrc), "tab.* actions send focusWindow only for an explicit request");
ok(/background: Type\.Optional\(Type\.Boolean\(\{ description: "If true \(the default\), act without focusing Chrome/.test(indexSrc), "chrome_tab exposes the background opt-in");
ok(/foreground: !background/.test(indexSrc) && /foreground: !wantBackground/.test(indexSrc), "the session default still activates a tab for watching");

if (failures) {
  console.error(`\n${failures} failed, ${passes} passed`);
  process.exit(1);
}
console.log(`ok: screenshot focus contract (${passes} assertions)`);
