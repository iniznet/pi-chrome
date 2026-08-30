# pi-chrome vs. the rest of the browser-automation landscape

This is the honest "which tool when" page. The browser-automation space has three different layers and people often compare across them — let's not do that.

We benchmark in public — see [`../test-suite/`](../test-suite). Where exact scores matter (WebVoyager, WorkArena++, BrowseComp, Mind2Web 2), check the live leaderboards; they shift monthly.

---

## TL;DR

| You are…                                                       | Use…                            |
| -------------------------------------------------------------- | ------------------------------- |
| A Pi agent operator who wants the agent to use **your real Chrome** (logged-in tabs, cookies, extensions) | **pi-chrome**                   |
| Building a Pi/LLM agent and want low-level browser primitives  | **pi-chrome**                   |
| Writing deterministic end-to-end tests in CI                   | Playwright / Cypress            |
| Building a hosted scraping/agent fleet on isolated profiles    | Playwright / Puppeteer + Browserbase / Steel |
| Want a turnkey "natural-language agent" with built-in loop     | Browser Use / Stagehand / Skyvern |
| Want a hosted, vendor-managed agent                            | OpenAI Operator / Project Mariner / Surfer |
| Debugging your own app from your editor without leaving your real session | **pi-chrome**                   |

`pi-chrome` is **primitives**, not an opinionated agent loop. Think of it as **"Playwright for the Chrome you're already signed into"** — and pluggable under any agent framework above the line.

---

## The three axes you should compare on

| Axis                              | Examples                                                              | What it gives you             |
| --------------------------------- | --------------------------------------------------------------------- | ----------------------------- |
| **1. Driver / transport**         | Playwright, Puppeteer, Selenium, CDP raw, `puppeteer-stealth`, **pi-chrome** | low-level tools (click, type, navigate) |
| **2. Agent framework**            | Browser Use, Stagehand, Skyvern, Magnitude, Alumnium, LangGraph-with-Playwright, Operator, Mariner, Surfer | LLM loop, planning, NL API    |
| **3. Cloud browser provider**     | Browserbase, Steel.dev, Hyperbrowser, Anchor, Browserless             | managed Chromes, sessions, quotas |

`pi-chrome` is **axis 1**. You can wrap it with any axis-2 agent framework, or run it directly from a Pi agent's `chrome_*` tool calls. It explicitly does NOT compete with axis 3 — it runs locally inside *your* Chrome.

---

## Axis 1 — drivers (where pi-chrome lives)

| Tool                              | Transport                                  | Profile                            | Browser input        | Banner when controlling            | Default detectable as bot |
| --------------------------------- | ------------------------------------------ | ---------------------------------- | -------------------- | ----------------------------------- | ------------------------- |
| Playwright                        | CDP (own driver)                           | throwaway by default               | always               | always ("controlled by test software") | yes (webdriver flag, automation flags) |
| Puppeteer                         | CDP                                        | throwaway by default               | always               | always                              | yes                       |
| Selenium                          | WebDriver / BiDi                           | throwaway                          | partial (BiDi improves) | always                          | most detectable           |
| puppeteer-stealth / playwright-extra | CDP + patches                           | throwaway                          | always               | always                              | medium (patches flags)    |
| Raw CDP                           | direct devtools protocol                   | either (needs `--remote-debugging-port`) | always           | always                              | yes                       |
| **pi-chrome**                     | **Chrome extension bridge → local loopback** | **your real Chrome profile, signed-in cookies, extensions, history** | **always for input tools** | **while Chrome input is attached** | **low (real profile + Chrome input)¹** |

¹ pi-chrome uses `chrome.debugger` for browser input and shows Chrome's banner like other CDP-based tools. The [`test-suite/`](../test-suite) grades browser-control behavior against common detection signals.

### What makes pi-chrome different on this axis

1. **Profile attach, not driver launch.** Every other driver fights cookie persistence, login walls, MFA, and extension state. pi-chrome inherits all of it because it *is* your Chrome.
2. **Chrome input against your real profile.** Interactive tools use CDP input for reliability while still controlling the Chrome profile you already use.
3. **Extension bridge transport.** No `--remote-debugging-port`, no throwaway Chromium. Survives Chrome auto-updates. Works alongside your normal Chrome usage.
4. **Structured action results.** Input tools return target coordinates/tags and can include a fresh snapshot (`includeSnapshot`) so agents can verify state instead of blindly retrying.
5. **Multi-session shared bridge.** Planner + worker + audit Pi sessions all drive the same Chrome concurrently.
6. **Stable element uids.** `chrome_snapshot` returns deterministic uids you can pass to subsequent actions — similar to BrowserGym's `bid`, but built into the snapshot tool itself.

### The P0 DevTools toolset: a debugger, not a clicker

The P0 batch adds a 21-tool DevTools surface on the same extension bridge — no new permissions. These positioning bullets are grounded in tools that ship in the P0 batch, not roadmap:

1. **Causality, not logs.** `chrome_network_initiator_chain` rebuilds the DevTools request-initiator tree (document → loader → script → call-frame) for any captured request, and `chrome_network_summary` turns the same capture into waterfall analytics — the agent gets *why* a request fired and *who* fired it.
2. **Renderer truth instead of heuristics.** `chrome_computed_style`, `chrome_box_model`, and `chrome_dom_at_point` answer "why is this hidden / offset / intercepting" with engine-computed styles, box-model quads, and a real `DOM.getNodeForLocation` hit-test (shadow-DOM and `pointer-events` aware) — the in-page `occluderAt` heuristic is no longer the only answer.
3. **A live runtime, not a snapshot.** `chrome_get_properties` expands objects DevTools-style (previews, own/inherited, getter descriptors) and `chrome_watch_expression` polls live expressions — watch a value change instead of re-snapshotting the page.
4. **Reproducible style contexts.** `chrome_emulate_media` (dark mode, reduced-motion, forced-colors, print, contrast, vision deficiency, focus, CPU throttle) plus `chrome_emulate`'s locale / timezone / geolocation / idle overrides make "dark + reduced-motion at 375px" one command away — and the overrides survive re-attach via the keepalive registry.
5. **A network control plane.** `chrome_network_throttle` (offline / latency / throughput) and `chrome_network_cache` flip connection conditions without touching DevTools.
6. **Memory hygiene.** `chrome_collect_garbage` + `chrome_memory_counters` (the DevTools DOM-counters trio + heap sizes) give leak runs a clean baseline and evidence to report.
7. **Deterministic visual QA.** `chrome_full_page_screenshot` (one-shot `captureBeyondViewport`) removes the tile-stitch focus churn, and `chrome_scroll_to` returns a post-scroll rect + visibility verdict instead of a blind scroll.
8. **Storage triage.** `chrome_indexeddb_query` opens the IndexedDB surface (index/range queries, counts, metadata, store clearing) that the storage tools previously only listed.
9. **Event forensics.** `chrome_event_listeners` inventories every listener on a node (type, source, `useCapture`, `passive`, `once`) — the first step in "why does this never fire".
10. **Environment fingerprint.** `chrome_browser_info` (version / OS / UA / command line) and `chrome_targets` (every CDP target: pages, workers, service workers, extensions) give the agent — and your bug report — full context in one call.
11. **Real HTML5 drop.** `chrome_drop` dispatches `Input.dispatchDragEvent` with a real `DataTransfer` payload (string and file items), so drop handlers actually fire — synthetic mouse moves never did.

Combined with the shared M0 plumbing underneath (uid/selector → CDP nodeId resolver, keepalive mode registry, non-destructive domain enable, paused-page auto-resume rail), this is the foundation of the roadmap's P1/P2 batches: full Debugger breakpoints/stepping, WebSocket frames, Fetch interception, tracing, heap snapshots, and session replay.

---

## Axis 2 — agent frameworks (built on top of axis 1)

These wrap a driver with an LLM loop. They are **higher-level than pi-chrome** and **complementary**, not competitors.

| Framework                | Driver underneath              | Approach                                                                                      | Open source     |
| ------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------- | --------------- |
| **Browser Use**          | Playwright                     | DOM + a11y tree → LLM → action JSON. Open-source leader; widely cited on WebVoyager.          | MIT (Python)    |
| **Stagehand** (Browserbase) | Playwright                  | Natural-language `.act()` / `.observe()` / `.extract()`; deterministic + AI mix.              | MIT (TypeScript)|
| **Skyvern**              | Playwright + own DOM model     | Vision-first + DOM; YAML workflows for form/workflow automation.                              | AGPL (Python)   |
| **Magnitude**            | Playwright                     | NL test authoring; QA-focused.                                                                | open            |
| **Alumnium**             | Selenium / Playwright          | Test-author NL → agent. QA-focused.                                                           | open            |
| **LangGraph / AutoGen + Playwright** | Playwright             | Generic agent graph + browser tools.                                                          | open            |
| **OpenAI Operator**      | proprietary                    | OpenAI's own VLM + browser; ChatGPT-integrated.                                               | closed, hosted  |
| **Project Mariner** (Google) | proprietary Chrome integration | Google's own VLM Chrome experiment.                                                       | closed          |
| **Surfer 2 / Surfer-H** (H Company) | proprietary             | Hosted proprietary agent stack.                                                               | closed, hosted  |
| **Anthropic Computer Use** | OS-level screenshots + mouse/keyboard | Broader than browser; OS-level events.                                                 | closed (API)    |

**Why pi-chrome is not on this list:** it's intentionally **not an agent**. There's no LLM loop, no `.act("click the blue button")`. Pi handles the loop; pi-chrome provides the primitives. This means:

- You can use pi-chrome under Browser Use, Stagehand, LangGraph, or any other agent framework (see [Interop](#interop)).
- You don't pay for an opinion you don't want.
- Agent improvements compound across all your workflows because the primitives stay stable.

---

## Axis 3 — cloud browser providers (orthogonal)

| Provider          | What it sells                                            |
| ----------------- | -------------------------------------------------------- |
| **Browserbase**   | Managed browsers; pairs with Stagehand.                  |
| **Steel.dev**     | Managed browsers + public agent leaderboards.            |
| **Hyperbrowser**  | Managed browsers, session APIs.                          |
| **Anchor Browser**| Managed browsers.                                        |
| **Browserless**   | Managed Chrome, scraping focus.                          |

**pi-chrome doesn't compete here.** It runs locally in *your* Chrome. The right framing if someone asks: *"no cloud cost, no session-handoff, no rate limits — and the agent runs against your real logged-in state."* If you need fleets of isolated Chromes in CI, you want one of these.

---

## Interop

`pi-chrome` exposes tools that any Pi agent can call. If you want to use it from outside Pi:

1. The local bridge speaks HTTP JSON over `127.0.0.1:17318` (default). The API is internal; use the Pi tool surface unless you are building an adapter.
2. Tool surface mirrors Playwright closely (click/type/navigate/snapshot/screenshot/evaluate/wait_for) so adapter code is short.
3. `includeSnapshot` on input tools lets agent harnesses verify state after actions.

If you want a first-class pi-chrome adapter for Browser Use / Stagehand / LangGraph, file an issue with your use case.

---

## "But Playwright has `storageState` / Puppeteer has user-data-dir"

Yes — you can export cookies and replay them, or point Playwright at your existing profile directory. In practice for agent workflows that breaks down fast:

1. **OAuth + SSO** providers (Okta, Google, GitHub) often pin sessions to TLS fingerprints, device IDs, and browser-extension state that doesn't survive replay or a parallel Chrome instance.
2. **MFA** tokens expire mid-run.
3. **Internal admin tools** hard-pin to your real device.
4. **Pointing Playwright at your real `user-data-dir`** requires closing your normal Chrome (Chrome won't share the profile lock). pi-chrome doesn't fight you for the profile because it lives *inside* it.
5. **Watching the agent work** in your real window is a different UX than a hidden parallel Chrome. Demos, pair-driving, and confidence-building all want axis-1-with-attach.

---

## "Is this safer than CDP?"

Different security boundary, not strictly safer.

- **CDP-based tools** require `chrome --remote-debugging-port=...`. That port is unauthenticated and exposes the whole browser to any local process. Easy to misconfigure.
- **pi-chrome** runs through an extension you install yourself with broad permissions (tabs, scripting, debugger, webNavigation). The bridge listens on `127.0.0.1:17318` loopback only, rejects browser-origin command requests, and keeps chrome_* tools locked until `/chrome authorize` is run in the current Pi session. **Only install the bundled extension if you trust the source you got the npm package from.**

If your threat model excludes extensions with broad permissions, neither approach is a fit — you want a sandboxed CI runner.

---

## Public benchmarks worth knowing (for axis 2 / axis 3 comparison)

Pi-chrome itself ships a benchmark suite ([`../test-suite/`](../test-suite)) of **42 primitive challenges** plus **4 hermetic BrowserGym-style long-horizon tasks** covering trusted input, pointer humanization, keyboard fidelity, drag/drop, Shadow DOM, iframes, file uploads, strict-CSP screenshot fallback and CDP eval/snapshot bypass, dynamic waits, tab lifecycle, network observability, fingerprint leaks, and agent-safety honeypots. Scoring tracks expected outcomes per challenge instead of raw PASS count, with `core`, `conditional`, and `quality` gate buckets. That's **driver-level** grading.

For **agent-level** comparison (axis 2), the public benchmarks worth citing:

| Benchmark        | What it measures                                  | Notes                                            |
| ---------------- | ------------------------------------------------- | ------------------------------------------------ |
| **WebArena** (CMU) | Hermetic, programmatic graders                  | Gold standard for reproducibility.               |
| **WorkArena++** (ServiceNow) | Enterprise SaaS workflows             | Hardest realistic benchmark; <5% frontier.        |
| **BrowseComp** (OpenAI) | Hard info-retrieval                        | Not saturated.                                    |
| **Mind2Web 2** (NeurIPS '25) | Long-horizon, rubric-tree judge       | New, well-designed.                              |
| **WebChoreArena** | Tedious cross-page workflows                     | Reflects real ops work.                          |
| **WebVoyager**   | Live web tasks                                    | **Saturated** — 90%+ scores common; cite only as smoke test. |
| **VisualWebArena** | Multimodal                                      |                                                  |
| **MiniWoB++**    | Classic unit-task suite                           |                                                  |
| **BrowserGym + AgentLab** | Research harness covering the above     | The de-facto research API; pi-chrome's snapshot uid is comparable to BrowserGym's `bid`. |

Cite live leaderboards rather than hard-coded numbers; agent scores shift monthly.

---

## Reproducing pi-chrome's driver-level claims

Run [`../test-suite/`](../test-suite) against any browser-control tool. Each challenge exposes `window.__verdict` / `window.__reason` / `window.__events`, so any tool (Playwright, Puppeteer, Selenium, Stagehand, pi-chrome) can grade itself deterministically. Headline release scoring should use the `core` gate; `conditional` depends on declared environment capabilities, and `quality` tracks adversarial/humanization regressions.

```bash
cd test-suite && python3 -m http.server 8765
# open http://127.0.0.1:8765/ in the Chrome window the tool controls
```

If you build a competing tool, please open a PR with your scores.
