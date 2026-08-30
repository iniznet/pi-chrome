// P0-batch host catalog + wire-routing harness (test-p0 / test-host).
//
// Pins the P0 tool surface of tasks/impl/TOOL_CONTRACTS.md §4/§5 against the REAL shipped
// sources (source-level for index.ts — it imports the pi SDK and cannot be loaded standalone):
//   (1) catalog consistency — every P0 CHROME_TOOL_NAMES entry has a pi.registerTool block
//   (2) schema surface — each tool's parameters Type.Object lists the contract's distinguishing
//       inputs (the new kinds / extended actions)
//   (3) wire routing — every P0 kind has a `case` in the SW dispatch switch (extended kinds
//       reuse their existing case, no protocol change) and every tool routes via
//       authorizedBridgeSend (never a raw bridge.send from a tool block)
//   (4) CDP mapping — the SW implements the contract's CDP methods (DOM.getNodeForLocation,
//       IndexedDB.clearObjectStore, Emulation.setCPUThrottlingRate, Memory.getDOMCounters, ...)
//   (5) payload-cap degrade-with-marker — 1MB command / 8MB result caps + the /result
//       resultTooLarge degrade marker; file-export tools (chrome_full_page_screenshot,
//       chrome_network_export) write artifacts under .pi instead of inlining payloads
//   (6) protocol round-trip — a P0 kind command (css.computedStyle) flows through the real
//       BridgeProtocol with no protocol change (poll/ack/settle), proving new kinds are pure
//       dispatch additions, not wire-protocol changes
//
// The catalog fixture is authoritative TOOL_CONTRACTS.md §4 rows 1-21 (the P0 batch). Tests
// are written against that contract: they may fail until the P0 implementation lands in the
// same phase (expected — never treat that as a harness failure).

import { stripTypeScriptTypes } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/index.ts");
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const commandsPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/commands.ts");

const indexSrc = fs.readFileSync(indexPath, "utf8");
const workerSrc = fs.readFileSync(workerPath, "utf8");

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; }
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---- P0 catalog fixture (TOOL_CONTRACTS.md §4 rows 1-21) --------------------
// params: distinguishing schema keys that MUST appear in the tool's parameters Type.Object.
// sw: contract CDP methods/behavior the SW MUST implement (searched in service_worker.js).
const P0_TOOLS = [
  { name: "chrome_computed_style", kind: "css.computedStyle", params: ["properties"], sw: [/CSS\.getComputedStyleForNode/] },
  { name: "chrome_box_model", kind: "css.boxModel", params: ["uid", "selector"], sw: [/DOM\.getBoxModel/] },
  { name: "chrome_dom_at_point", kind: "dom.point", params: ["x:", "y:", "includeDepth"], sw: [/DOM\.getNodeForLocation/] },
  { name: "chrome_node_html", kind: "page.outerHTML", params: ["uid", "selector"], sw: [/outerHTML/] },
  { name: "chrome_emulate_media", kind: "page.emulate", params: ["colorScheme", "reducedMotion", "cpuThrottleRate"], sw: [/Emulation\.setEmulatedMedia/, /Emulation\.setCPUThrottlingRate/] },
  { name: "chrome_emulate", kind: "page.emulate", params: ["locale", "timezoneId", "geolocation", "idle"], sw: [/Emulation\.setTimezoneOverride/, /Emulation\.setIdleOverride/] },
  { name: "chrome_get_properties", kind: "page.properties", params: ["depth", "ownProperties", "accessorPropertiesOnly"], sw: [/Runtime\.getProperties/] },
  { name: "chrome_watch_expression", kind: "page.watch", params: ["expression", "durationMs", "maxSamples"], sw: [] },
  { name: "chrome_network_summary", kind: "network.summary", params: [], sw: [] },
  { name: "chrome_network_cache", kind: "network.cache", params: ["enabled"], sw: [/Network\.setCacheDisabled/] },
  { name: "chrome_network_throttle", kind: "network.throttle", params: ["offline", "latencyMs", "downloadThroughput", "uploadThroughput"], sw: [/Network\.emulateNetworkConditions/] },
  { name: "chrome_collect_garbage", kind: "page.collectGarbage", params: [], sw: [/HeapProfiler\.collectGarbage/] },
  { name: "chrome_memory_counters", kind: "page.memoryCounters", params: ["prepareForLeakDetection"], sw: [/Memory\.getDOMCounters/] },
  { name: "chrome_indexeddb_query", kind: "storage.op", params: ["keyRange", "indexName", "objectStore", "offset"], sw: [/IndexedDB\.requestData/, /IndexedDB\.clearObjectStore/, /IndexedDB\.deleteObjectStoreEntries/] },
  { name: "chrome_event_listeners", kind: "page.eventListeners", params: ["depth"], sw: [/DOMDebugger\.getEventListeners/] },
  { name: "chrome_drop", kind: "page.drop", params: ["dataTransfer", "fromUid", "toUid"], sw: [/Input\.dispatchDragEvent/] },
  { name: "chrome_full_page_screenshot", kind: "page.screenshot", params: ["captureBeyondViewport", "path", "format"], sw: [/captureBeyondViewport/] },
  { name: "chrome_scroll_to", kind: "page.scrollTo", params: ["block", "inline", "uid"], sw: [/scrollIntoView/] },
  { name: "chrome_browser_info", kind: "browser.info", params: [], sw: [/Browser\.getVersion/, /Browser\.getBrowserCommandLine/] },
  { name: "chrome_targets", kind: "target.list", params: ["filter"], sw: [/chrome\.debugger\.getTargets/] },
  { name: "chrome_network_initiator_chain", kind: "network.initiatorChain", params: ["requestId", "requestUrlIncludes", "includeDependents"], sw: [/buildInitiatorChain/] },
];

// ---- String-aware brace matching (skips strings, template literals + ${} interpolation, -----
// and comments) so we can carve exact registerTool/Type.Object regions out of index.ts. The
// ${} interpolation depth is tracked on a STACK: a `}` inside an interpolation only closes it
// when depth returns to the level the interpolation opened at (so nested object literals like
// `${(result as { elapsedMs?: number })?.elapsedMs}` are handled).
function matchBrace(src, openIndex) {
  let depth = 0;
  let i = openIndex;
  let state = "code"; // code | sq | dq | tpl
  const tplStack = []; // depths at which each open ${} interpolation started
  for (; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (state === "sq") {
      if (c === "\\") { i++; continue; }
      if (c === "'") state = "code";
      continue;
    }
    if (state === "dq") {
      if (c === "\\") { i++; continue; }
      if (c === '"') state = "code";
      continue;
    }
    if (state === "tpl") {
      if (c === "\\") { i++; continue; }
      if (c === "`") { state = "code"; continue; }
      if (c === "$" && next === "{") { tplStack.push(depth); state = "code"; continue; }
      continue;
    }
    // code state
    if (c === "/" && next === "/") { // line comment
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") { // block comment
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (c === "'") { state = "sq"; continue; }
    if (c === '"') { state = "dq"; continue; }
    if (c === "`") { state = "tpl"; continue; }
    if (c === "{") { depth++; continue; }
    if (c === "}") {
      depth--;
      if (tplStack.length > 0 && depth === tplStack[tplStack.length - 1]) {
        tplStack.pop();
        state = "tpl";
        continue;
      }
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractRegisterToolBlocks(src) {
  const blocks = [];
  const re = /pi\.registerTool\(\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf("{", m.index);
    const close = matchBrace(src, open);
    if (close < 0) break;
    const block = src.slice(open, close + 1);
    const nameMatch = /name:\s*"([^"]+)"/.exec(block);
    if (nameMatch) blocks.push({ name: nameMatch[1], block });
    re.lastIndex = close + 1;
  }
  return blocks;
}

// Extract the `parameters: Type.Object({ ... })` region of a tool block.
function extractParameters(block) {
  const m = /parameters:\s*Type\.Object\(\{/.exec(block);
  if (!m) return "";
  const open = block.indexOf("{", m.index);
  const close = matchBrace(block, open);
  return close < 0 ? "" : block.slice(open, close + 1);
}

function extractCHROME_TOOL_NAMES(src) {
  const m = /const CHROME_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const toolNames = extractCHROME_TOOL_NAMES(indexSrc);
const toolBlocks = extractRegisterToolBlocks(indexSrc);
const blocksByName = new Map(toolBlocks.map((b) => [b.name, b.block]));

// ---- BridgeProtocol round-trip harness (real shipped commands.ts) ------------
const cmdJs = stripTypeScriptTypes(fs.readFileSync(commandsPath, "utf8"), { mode: "strip" });
const cmdMod = await import("data:text/javascript;base64," + Buffer.from(cmdJs).toString("base64"));
const { BridgeProtocol } = cmdMod;

function makeSettle() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  const timer = setTimeout(() => {}, 60_000);
  return {
    promise, timer,
    resolve: (v) => resolve(v), reject: (e) => reject(e),
    cleanup: () => clearTimeout(timer),
  };
}

function run() {
  // ===== (1) catalog consistency: every P0 name registered + block present. =====
  {
    for (const t of P0_TOOLS) {
      ok(toolNames.includes(t.name), `catalog: ${t.name} is listed in CHROME_TOOL_NAMES`);
      ok(blocksByName.has(t.name), `catalog: ${t.name} has a pi.registerTool block`);
    }
    // A tool in CHROME_TOOL_NAMES must never be registered under a different name (typo guard).
    const registeredNames = new Set(toolBlocks.map((b) => b.name));
    for (const name of toolNames) {
      ok(registeredNames.has(name), `catalog: every CHROME_TOOL_NAMES entry has a matching registerTool block (${name})`);
    }
    // P0 activation: the shipped initiator-chain tool was already wired in Phase 1 — must not regress.
    ok(toolNames.includes("chrome_network_initiator_chain"), "catalog: Phase-1 P0 tool chrome_network_initiator_chain stays in CHROME_TOOL_NAMES");
  }

  // ===== (2) schema surface: contract-distinguishing params present. =====
  {
    for (const t of P0_TOOLS) {
      const block = blocksByName.get(t.name);
      if (!block) continue; // catalog failure already reported above
      const paramsSection = extractParameters(block);
      for (const marker of t.params) {
        ok(paramsSection.includes(marker), `schema: ${t.name} parameters list '${marker}'`);
      }
    }
    // Extended-kind surfaces (TOOL_CONTRACTS §4): the emulation/media + IDB extensions share
    // their existing kinds, so their NEW input surface is the contract signal.
    ok(extractParameters(blocksByName.get("chrome_emulate_media") ?? "").includes("action") || extractParameters(blocksByName.get("chrome_emulate_media") ?? "").includes("set"), "schema: chrome_emulate_media carries an action surface (set/clear)");
    ok(/x:\s*Type\./.test(extractParameters(blocksByName.get("chrome_dom_at_point") ?? "")), "schema: chrome_dom_at_point x is a typed number");
    ok(/y:\s*Type\./.test(extractParameters(blocksByName.get("chrome_dom_at_point") ?? "")), "schema: chrome_dom_at_point y is a typed number");
    // Shared tab-resolution params stay on every P0 tool (contract §2.3). Exception: the
    // browser-global tools (chrome_targets lists ALL CDP targets and never attaches; no tab is
    // resolved) — their schema carries only host/port.
    const TAB_GLOBAL = new Set(["chrome_targets"]);
    for (const t of P0_TOOLS) {
      if (TAB_GLOBAL.has(t.name)) continue;
      const block = blocksByName.get(t.name);
      if (!block) continue;
      const paramsSection = extractParameters(block);
      ok(paramsSection.includes("targetId"), `schema: ${t.name} keeps targetId tab-resolution param`);
      ok(paramsSection.includes("background"), `schema: ${t.name} keeps background tab-resolution param`);
      ok(paramsSection.includes("urlIncludes"), `schema: ${t.name} keeps urlIncludes tab-resolution param`);
    }
    // chrome_full_page_screenshot is the fullPage capture by construction — the execute forces
    // fullPage:true on the wire instead of taking it as a param (the tool IS the full-page shot).
    const fpsBlock = blocksByName.get("chrome_full_page_screenshot");
    if (fpsBlock) {
      ok(fpsBlock.includes("fullPage: true"), "schema: chrome_full_page_screenshot forces fullPage:true on the wire");
      ok(fpsBlock.includes("captureBeyondViewport"), "schema: chrome_full_page_screenshot exposes captureBeyondViewport");
    }
  }

  // ===== (3) wire routing: authorizedBridgeSend + SW dispatch cases. =====
  {
    for (const t of P0_TOOLS) {
      const block = blocksByName.get(t.name);
      if (!block) continue;
      ok(block.includes(`authorizedBridgeSend("${t.kind}"`), `routing: ${t.name} sends kind '${t.kind}' via authorizedBridgeSend`);
      ok(!block.includes("bridge.send("), `routing: ${t.name} never bypasses authorization with a raw bridge.send`);
    }
    // Every P0 kind has a `case` in the SW dispatch switch — new kinds get a case, extended
    // kinds reuse the existing one (no wire-protocol change).
    for (const t of P0_TOOLS) {
      ok(workerSrc.includes(`case "${t.kind}":`), `routing: SW dispatch has a case for '${t.kind}' (${t.name})`);
    }
    // The extended kinds existed before P0 — their case must still be present (non-regression).
    for (const kind of ["page.emulate", "page.screenshot", "storage.op", "network.initiatorChain"]) {
      ok(workerSrc.includes(`case "${kind}":`), `routing: extended kind '${kind}' keeps its dispatch case`);
    }
  }

  // ===== (4) CDP mapping: contract methods implemented in the SW. =====
  {
    for (const t of P0_TOOLS) {
      for (const re of t.sw) {
        ok(re.test(workerSrc), `cdp: SW implements ${re} for ${t.name}`);
      }
    }
  }

  // ===== (5) payload-cap degrade-with-marker (file-export tools). =====
  {
    ok(/const MAX_COMMAND_BODY_BYTES\s*=\s*1024\s*\*\s*1024/.test(indexSrc), "caps: MAX_COMMAND_BODY_BYTES is 1MB");
    ok(/const MAX_RESULT_BODY_BYTES\s*=\s*8\s*\*\s*1024\s*\*\s*1024/.test(indexSrc), "caps: MAX_RESULT_BODY_BYTES is 8MB");
    ok(/const MAX_WIRE_TIMEOUT_MS\s*=\s*5\s*\*\s*60_?000/.test(indexSrc), "caps: MAX_WIRE_TIMEOUT_MS is 5 minutes");
    // The /result endpoint degrades oversized bodies with a structured marker instead of
    // buffering them (index.ts "endpoint-limits" path).
    ok(indexSrc.includes("resultTooLarge"), "caps: /result degrade marker (resultTooLarge) is implemented in index.ts");
    ok(/accepted:\s*false,\s*resultTooLarge:\s*true/.test(indexSrc), "caps: oversized /result answers accepted:false + resultTooLarge:true");
    ok(indexSrc.includes("bodyExceedsLimit"), "caps: the readRequestBody limit marker (bodyExceedsLimit) is plumbed");

    // File-export P0 tools write artifacts under .pi via the network_export writer pattern —
    // they never inline the payload into the tool text content.
    const screenshotBlock = blocksByName.get("chrome_full_page_screenshot");
    const exportBlock = blocksByName.get("chrome_network_export");
    for (const [label, block] of [["chrome_full_page_screenshot", screenshotBlock], ["chrome_network_export", exportBlock]]) {
      if (!block) continue;
      ok(block.includes("mkdir(dirname("), `caps: ${label} creates the output directory (mkdir(dirname(...)))`);
      ok(block.includes("writeFile("), `caps: ${label} writes the artifact to disk with writeFile`);
      ok(block.includes(".pi"), `caps: ${label} defaults the output under .pi`);
      ok(block.includes("path"), `caps: ${label} returns a path in its result`);
      ok(!/text:.*\$\{.*dataUrl/.test(block), `caps: ${label} never inlines the raw dataUrl into the tool text`);
    }
    // The pre-existing chrome_network_export stays a file writer (pattern anchor, non-regression).
    ok(exportBlock !== undefined, "caps: chrome_network_export (pattern anchor) still registered");
  }

  // ===== (6) protocol round-trip: new kinds need no bridge-protocol change. =====
  {
    const p = new BridgeProtocol();
    const s = makeSettle();
    const command = { id: "p0-1", action: "css.computedStyle", params: { selector: "#btn", properties: ["color", "display"] } };
    p.track(command, s.resolve, s.reject, s.timer);
    p.enqueue(command);
    const poll = p.poll();
    ok(poll.type === "command" && poll.claim.command.action === "css.computedStyle", "protocol: a P0 kind command is served like any command");
    poll.claim.markFlushed(p, 1_000);
    ok(p.ack("p0-1", 1_100) === true, "protocol: the P0 kind command acks normally");
    const outcome = p.settle("p0-1");
    ok(outcome.accepted === true, "protocol: the P0 kind result settles normally");
    outcome.entry.resolve({ node: { tag: "BUTTON" }, computedStyle: { color: "rgb(0, 0, 0)" } });
    s.cleanup();
    p.stop();

    // Same for a long-lived P0 kind with keepalive semantics — still an ordinary command.
    const p2 = new BridgeProtocol();
    const s2 = makeSettle();
    const throttle = { id: "p0-2", action: "network.throttle", params: { offline: true, latencyMs: 200 } };
    p2.track(throttle, s2.resolve, s2.reject, s2.timer);
    p2.enqueue(throttle);
    const poll2 = p2.poll();
    ok(poll2.type === "command" && poll2.claim.command.action === "network.throttle", "protocol: network.throttle (long-lived) needs no protocol extension");
    s2.cleanup();
    p2.stop();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run();
