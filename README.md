# pi-chrome

> Let [Pi](https://pi.dev) use your existing signed-in Chrome profile after explicit authorization.

**MIT · 0 runtime deps · loopback-only bridge (`127.0.0.1:17318`) · inspectable unpacked Chrome extension.** Review [`extensions/chrome-profile-bridge/browser-extension/`](./extensions/chrome-profile-bridge/browser-extension) before loading. Verify setup with `/chrome doctor`.

```text
You:    "Find my open GitHub PR tab, summarize review state, and screenshot failing CI."
Agent:  chrome_tab(list) → chrome_snapshot(uid:…) → chrome_screenshot(...)
        ✓ 3 reviewers, 1 change requested, CI red on iOS. Saved → .pi/chrome-screenshots/ci.png
You:    [keeps coding — agent never asked you to log in]
```

`pi-chrome` runs through a small Chrome extension inside the Chrome profile **you already use** — including sites where you're already signed in. Agents can inspect or control Chrome only after you run `/chrome authorize` in current Pi session.

---

## Install

```bash
pi install npm:pi-chrome
```

In Pi:

```text
/chrome onboard
```

This opens `chrome://extensions` and copies bundled extension path. In Chrome Extensions:

1. Turn on **Developer mode**.
2. Click **Load unpacked**.
3. Open path field with **Cmd+Shift+G** on macOS or **Ctrl+L** on Windows/Linux.
4. Paste copied path.
5. Press Enter.

Reload Pi so installed package loads:

```text
/reload
```

Check bridge:

```text
/chrome doctor
```

You should see:

```text
✓ Chrome is connected (...)
```

Authorize current session:

```text
/chrome authorize
/chrome doctor
```

Second doctor run should show all checks passing.

---

## What it can do

- Read and summarize pages you're already signed into.
- Click, type, fill forms, scroll, drag, tap, and upload files.
- Capture screenshots for bugs, PRs, and demos.
- Inspect console logs and captured `fetch`/`XMLHttpRequest` responses.
- Manage tabs without taking over your active window.
- Debug like DevTools: computed styles, box models, real hit-tests, event listeners, object expansion, live-expression watching, request-initiator chains, network throttling/caching, GC + memory counters, media/environment emulation, and IndexedDB queries.

Tool parameters and gotchas are documented inline in Pi.

---

## DevTools toolset (75 tools)

pi-chrome is an agent-driven DevTools surface. On top of the existing input /
screenshot / network / storage core, agents get **75 DevTools-grade
primitives** across four batches (P0/P1A/P1B/P2) — no new Chrome permissions
required (they all ride the existing `debugger` permission). Beyond the P0
table below, the P1A batch adds a live debugger (breakpoints, pause/step,
call-stack, in-frame evaluation), console/exception capture, and network
interception/causality; P1B adds CSS cascade / a11y trees, mutation waits,
service-worker + storage control, layout metrics, animations, PDF export and
CPU/coverage profiling; P2 adds DOM/CSS/a11y audits, tracing and heap
snapshots (file exports), session recording, background-service + storage
watch, event/DOM breakpoints, virtual time, device matrices, MHTML and TLS
surfaces. The P0 primitives:

| Tool | Purpose |
| --- | --- |
| `chrome_computed_style` | Full or filtered computed-style map for a uid/selector — *why is this hidden / offset / transparent*.
| `chrome_box_model` | Content / padding / border / margin quads + dimensions for a node.
| `chrome_dom_at_point` | Renderer-truth hit-test at x,y (shadow-DOM and `pointer-events` aware) — no in-page heuristic.
| `chrome_node_html` | `outerHTML` + full attribute list for a uid/selector.
| `chrome_emulate_media` | Emulate `prefers-color-scheme`, `reduced-motion`, `forced-colors`, print, `prefers-contrast`, vision deficiency, focus, auto-dark, and CPU throttle.
| `chrome_emulate` (extended) | Locale, timezone, geolocation, and idle overrides on top of device metrics/UA/touch.
| `chrome_get_properties` | DevTools-style object expansion via `Runtime.getProperties` — previews, own/inherited, getter descriptors.
| `chrome_watch_expression` | Live-expression polling — a value time-series over a duration (DevTools live-expression semantics).
| `chrome_network_summary` | Waterfall + aggregate analytics from captured traffic: slowest, failed, status distribution, bytes by type, cache hits.
| `chrome_network_cache` | Enable / disable the HTTP cache.
| `chrome_network_throttle` | Offline / latency / throughput emulation.
| `chrome_collect_garbage` | Forced GC for a clean baseline before memory metrics.
| `chrome_memory_counters` | DevTools "DOM Counters" trio (nodes / JS listeners / documents) + heap sizes + leak-prep hook.
| `chrome_indexeddb_query` | IndexedDB index/range queries, counts, clear store, delete entries, metadata (extended `chrome_storage` actions).
| `chrome_event_listeners` | Event-listener inventory: type, source, `useCapture`, `passive`, `once`.
| `chrome_drop` | Real HTML5 drag-and-drop with `DataTransfer` items/files.
| `chrome_full_page_screenshot` | Single-shot full-page capture via `captureBeyondViewport:true` (scale / jpeg / clip variants; tile path stays as fallback).
| `chrome_scroll_to` | Deterministic scroll-into-view + post-scroll rect / visibility verdict.
| `chrome_browser_info` | Browser / OS / UA / command-line fingerprint.
| `chrome_targets` | Full CDP target intelligence (pages, workers, service workers, extensions) — no attach needed.
| `chrome_network_initiator_chain` | DevTools-style **request-initiator chain** for any captured request: who triggered it (document → loader → script → call-frame) and, optionally, what it triggered in turn.

Most of these tools resolve elements by snapshot uid or CSS selector, and all of
them honor the usual tab-resolution params (`targetId` / `urlIncludes` /
`titleIncludes`). Full usage is documented inline in Pi.

---

## Safety model

Chrome control is locked by default. Authorize per Pi session:

```text
/chrome authorize          # 15 minutes
/chrome authorize 30m      # custom duration
/chrome authorize indefinite
/chrome revoke             # lock again
/chrome status
```

Safety properties:

- Extension runs in your real Chrome profile and has broad tab/scripting permissions. Install only from trusted package source.
- Pi side binds to `127.0.0.1:17318` only; no default network exposure.
- Bridge rejects browser-origin command requests, so ordinary web pages cannot drive it through CORS.
- Each Pi session gets its own automation target; user tabs/windows are not closed by cleanup.
- `/chrome revoke` closes only calling session's automation target.

### Trust model

The loopback bridge on `127.0.0.1:17318` is **unauthenticated by design** — no
shared secret, no pinning of the extension id. Any process on this machine, or
any installed browser extension, can:

- issue Chrome-control commands (navigate, click, type, evaluate JS) against
your signed-in profile once a session is authorized, and
- read console logs and captured `fetch`/`XMLHttpRequest` traffic from
instrumented tabs.

This is acceptable for a single-user local workstation. Do **not** run
`pi-chrome` on shared or multi-user machines, alongside untrusted local
processes, or with untrusted browser extensions installed — `pi-chrome` treats
"local access to this machine" as equivalent to "local access to your
browser."

### Instrumentation scope (privacy)

While a session is authorized, the extension instruments pages at
`document_start` to capture console messages and `fetch`/`XMLHttpRequest`
traffic. This instrumentation applies to **every tab in the profile — not just
the tab the agent drives** — and the network capture retains **full response
bodies** (hundreds of MB per tab on long sessions) that agent tools
(`chrome_list_network_requests` / `chrome_get_network_request`) can read. Do
not browse sites you want kept out of the agent's log while the bridge is
active, and expect memory growth on long sessions. Full bodies are intended to
be trimmed to URL/status/headers in a future release.

Security details: [`SECURITY.md`](./SECURITY.md). Architecture details: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## Commands

```text
/chrome onboard             # guided setup
/chrome doctor              # connectivity + version + eval checks
/chrome status              # connection + auth + background state
/chrome authorize [duration]
/chrome revoke
/chrome history [n|replay <idx>]   # per-session action log (default 10, max 50) + replay
/chrome background on       # default: don't steal focus
/chrome background off      # foreground/watch mode
/chrome background status
```

If loaded extension is older than installed `pi-chrome`, `/chrome doctor` tells you to reload it from `chrome://extensions`.

---

## Limits

`pi-chrome` works best on web-page workflows exposed through DOM, screenshots, tabs, network, console, and Chrome input. It is not full OS automation.

Current limits include native Chrome/OS surfaces, print/save dialogs, permission bubbles, password-manager prompts, cross-origin iframe DOM access, CAPTCHA/bot challenges, passkeys/security keys/biometrics, rich multitouch/pinch/stylus gestures, and arbitrary desktop apps.

For strict-CSP pages, `chrome_snapshot`/`chrome_evaluate`/`chrome_wait_for` and Chrome input run through CDP `Runtime.evaluate`, a DevTools protocol command that is **not** subject to the page's Content-Security-Policy — they keep working even on pages that block `'unsafe-eval'`. Screenshot + coordinate input remains a fallback only for exotic locked-down pages where even the CDP path is unusable.

---

## Docs

- Examples: [`docs/EXAMPLES.md`](./docs/EXAMPLES.md)
- FAQ: [`docs/FAQ.md`](./docs/FAQ.md)
- Comparison: [`docs/COMPARISON.md`](./docs/COMPARISON.md)
- Security: [`SECURITY.md`](./SECURITY.md)
- Benchmark suite: [`test-suite/README.md`](./test-suite/README.md)
- Architecture: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

---

## License

MIT. See [LICENSE](./LICENSE).
