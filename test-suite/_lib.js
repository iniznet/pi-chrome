// Tiny shared harness for challenge pages.
// Each page calls Challenge.init({id, instructions}) then Challenge.pass()/fail()
// based on its own listeners.
(function () {
  const events = [];
  const state = {
    id: null,
    verdict: "PENDING",
    reason: [],
    events,
    details: [],
    thresholds: {},
  };

  function render() {
    const el = document.getElementById("__verdict");
    if (!el) return;
    el.textContent = state.verdict;
    el.dataset.verdict = state.verdict;
    el.style.background =
      state.verdict === "PASS" ? "#1f7a1f" :
      state.verdict === "FAIL" ? "#a11" :
      state.verdict === "SKIP" ? "#76520b" :
      state.verdict === "WARN" ? "#6b5d00" : "#444";
    el.style.color = "#fff";
    const r = document.getElementById("__reason");
    if (r) r.textContent = state.reason.join("\n");
  }

  function log(name, detail) {
    events.push({ t: performance.now(), name, ...detail });
    if (events.length > 500) events.shift();
  }

  const Challenge = {
    init({ id, instructions, thresholds = {} }) {
      state.id = id;
      state.thresholds = parseThresholds(thresholds);
      document.title = `[${state.verdict}] ${id}`;
      const root = document.body;
      const bar = document.createElement("div");
      bar.style.cssText =
        "position:sticky;top:0;background:#111;color:#eee;padding:8px 12px;font:13px monospace;border-bottom:1px solid #333;z-index:9999";
      bar.innerHTML = `
        <b>${id}</b>
        <span id="__verdict" style="margin-left:8px;padding:2px 8px;border-radius:4px;background:#444">PENDING</span>
        <span style="margin-left:12px;opacity:.7">${instructions}</span>
        <pre id="__reason" style="white-space:pre-wrap;margin:6px 0 0;color:#bbb;font:12px monospace"></pre>
      `;
      root.insertBefore(bar, root.firstChild);
      window.__challenge = id;
      window.__verdict = state.verdict;
      window.__reason = state.reason;
      window.__events = state.events;
      render();
    },
    pass(...reasons) {
      if (state.verdict === "FAIL") return; // sticky
      state.verdict = "PASS";
      state.reason.push(...reasons.map((r) => "✓ " + r));
      window.__verdict = state.verdict;
      document.title = `[PASS] ${state.id}`;
      persist(); render();
    },
    fail(...reasons) {
      state.verdict = "FAIL";
      state.reason.push(...reasons.map((r) => "✗ " + r));
      window.__verdict = state.verdict;
      document.title = `[FAIL] ${state.id}`;
      persist(); render();
    },
    skip(...reasons) {
      if (state.verdict === "FAIL" || state.verdict === "PASS") return;
      state.verdict = "SKIP";
      state.reason.push(...reasons.map((r) => "↷ " + r));
      window.__verdict = state.verdict;
      document.title = `[SKIP] ${state.id}`;
      persist(); render();
    },
    warn(...reasons) {
      if (state.verdict === "FAIL" || state.verdict === "PASS") return;
      state.verdict = "WARN";
      state.reason.push(...reasons.map((r) => "! " + r));
      window.__verdict = state.verdict;
      document.title = `[WARN] ${state.id}`;
      persist(); render();
    },
    partial({ name, pass, reason, data }) {
      state.details.push({ name, pass: !!pass, reason: reason || "", data });
      log("partial", { name, pass: !!pass, reason, data });
      persist(); render();
      return !!pass;
    },
    finishPartials() {
      const failed = state.details.filter(d => !d.pass);
      if (failed.length) Challenge.fail(...failed.map(d => `${d.name}: ${d.reason || "failed"}`));
      else Challenge.pass(...state.details.map(d => `${d.name}: ok`));
    },
    getThreshold(name, fallback) {
      return Object.prototype.hasOwnProperty.call(state.thresholds, name) ? state.thresholds[name] : fallback;
    },
    log,
    state,
  };

  function persist() {
    const key = "pi-chrome-suite:" + state.id;
    const payload = {
      id: state.id,
      verdict: state.verdict,
      reason: state.reason,
      details: state.details,
      thresholds: state.thresholds,
      events: state.events.slice(-50),
      ts: Date.now(),
      persisted: true,
    };
    try {
      localStorage.setItem(key, JSON.stringify(payload));
      delete window.__verdictLost;
    } catch (err) {
      // A lost verdict must never masquerade as "challenge not run": surface a
      // sentinel record so readers can tell PENDING (no record) from a run whose
      // result could not be persisted (persisted:false / WARN verdict).
      const message = err && err.message ? err.message : String(err);
      console.warn("[pi-chrome-suite] verdict write failed for " + state.id + ": " + message);
      window.__verdictLost = { id: state.id, verdict: state.verdict, reason: state.reason, ts: Date.now(), error: message };
      try {
        // Minimal sentinel (retry usually succeeds when the full payload hit a quota edge).
        localStorage.setItem(
          key,
          JSON.stringify({
            id: state.id,
            verdict: "WARN",
            reason: ["verdict write failed; " + state.verdict + " result not persisted"],
            persisted: false,
            ts: Date.now(),
          })
        );
      } catch (err2) {
        console.warn("[pi-chrome-suite] sentinel write also failed for " + state.id + "; verdict " + state.verdict + " is lost");
      }
    }
  }

  function parseThresholds(defaults) {
    const out = { ...defaults };
    try {
      const qs = new URLSearchParams(location.search);
      for (const [k, v] of qs) {
        if (!k.startsWith("threshold.")) continue;
        const key = k.slice("threshold.".length);
        const num = Number(v);
        out[key] = Number.isFinite(num) ? num : v;
      }
    } catch {}
    return out;
  }

  window.Challenge = Challenge;
})();
