// Unit harness for pi-chrome's exactly-once bridge protocol — the host-free state machine in
// extensions/chrome-profile-bridge/commands.ts (BridgeProtocol / CommandClaim / BridgeJournal).
//
// index.ts registers with the pi host on import, so it cannot be loaded standalone; the pure
// protocol was extracted into commands.ts precisely so these tests can drive the REAL shipped
// state machine without any host, network, or node:http. We strip types with node's own
// type-stripping (the file is deliberately erasable-syntax-only) and load it as a data: URL —
// the executed code is byte-for-byte the module index.ts imports.
//
// Coverage (test-protocol / test-host):
//   (1) /next serves a queued command once and never re-serves it after /ack
//   (2) duplicate / unknown /ack is an idempotent no-op
//   (3) acked-but-never-resolved commands time out -> orphan push -> the next /next returns an
//       orphan with a may-have-executed warning and no re-execution
//   (4) a late /result after timeout returns accepted:false and never resolves the pending promise
//   (5) TOCTOU abort handling: an unflushed (aborted) claim is requeued; a flushed claim is not
//   (6) byte-budget journal eviction drops the oldest entry first

import { stripTypeScriptTypes } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/commands.ts");
const src = fs.readFileSync(commandsPath, "utf8");
const js = stripTypeScriptTypes(src, { mode: "strip" });
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const { BridgeProtocol, BridgeJournal, CommandClaim, ORPHAN_NOTE } = mod;

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; }
  else { failures++; console.error(`  ✗ ${msg}`); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Settle stubs: a real promise + real timer the protocol can clear, exactly like index.ts's
// sendLocal builds them (minus the abort-listener wiring, which is host-side).
function makeSettle() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  // Always attach a handler so protocol-driven rejections (stop(), drop() paths that the host
  // surfaces) can never crash the run as unhandled rejections; tests that need the value still
  // await the ORIGINAL promise.
  promise.catch(() => {});
  const timer = setTimeout(() => {}, 60_000);
  const settled = { resolve: false, reject: false };
  return {
    promise,
    timer,
    resolve: (v) => { settled.resolve = true; resolve(v); },
    reject: (e) => { settled.reject = true; reject(e); },
    settled,
    cleanup: () => clearTimeout(timer),
  };
}

function makeCommand(id, action = "page.click") {
  return { id, action, params: { uid: "el-1" } };
}

// Track + enqueue a command the way sendLocal does (track first, then enqueue).
function enqueue(p, s, id) {
  const command = makeCommand(id);
  p.track(command, s.resolve, s.reject, s.timer);
  p.enqueue(command);
  return command;
}

// Serve + flush + ack a queued command (the happy path a real extension follows).
function serveFlushAck(p, id, at = 1_000) {
  const poll = p.poll();
  if (poll.type !== "command" || poll.claim.command.id !== id) return poll;
  poll.claim.markFlushed(p, at);
  const acked = p.ack(id, at + 1);
  return { poll, acked };
}

async function run() {
  // ===== (1) /next serves a queued command once; never re-serves after /ack. =====
  {
    const p = new BridgeProtocol();
    const s = makeSettle();
    enqueue(p, s, "c1");

    const first = p.poll();
    ok(first.type === "command", "serve-once: first /next returns the queued command");
    ok(first.type === "command" && first.claim.command.id === "c1", "serve-once: claim carries the command id");
    ok(p.queue.length === 0, "serve-once: the claim spliced the command out of the queue");

    // Abort BEFORE flush (extension never saw the payload): the command is requeued and the
    // next live /next serves it again — it was never executed, so re-serving is safe.
    first.claim.requeue(p);
    ok(p.queue.length === 1 && p.queue[0].id === "c1", "serve-once: aborted-before-flush requeues the command");
    const second = p.poll();
    ok(second.type === "command" && second.claim.command.id === "c1", "serve-once: requeued command is served to the next poll");

    // This time the extension sees it (flush) and acks it.
    second.claim.markFlushed(p, 2_000);
    ok(p.ack("c1", 2_100) === true, "serve-once: ack transitions pending -> received");
    const third = p.poll();
    ok(third.type === "none", "serve-once: an acked command is never re-served (no re-execution)");
    ok(p.queue.length === 0, "serve-once: nothing left to serve");

    s.cleanup();
    p.stop();
  }

  // ===== (2) Duplicate / unknown /ack is an idempotent no-op. =====
  {
    const p = new BridgeProtocol();
    const s = makeSettle();
    enqueue(p, s, "c1");
    serveFlushAck(p, "c1", 1_000);

    ok(p.ack("c1", 2_000) === false, "ack-idempotent: duplicate ack is a no-op (false)");
    ok(p.pending.get("c1")?.state === "received", "ack-idempotent: duplicate ack does not clobber state");
    ok(p.ack("ghost-id", 2_000) === false, "ack-idempotent: unknown id is a no-op (false)");
    ok(p.ack("ghost-id", 2_000) === false, "ack-idempotent: repeated unknown ack stays a no-op");

    // A late ack for an id that has already been dropped (timed out) is also a no-op.
    p.drop("c1");
    ok(p.ack("c1", 3_000) === false, "ack-idempotent: late ack after timeout is a no-op");

    s.cleanup();
    p.stop();
  }

  // ===== (3) Acked-but-never-resolved: timeout -> orphan push -> orphan notice, no re-execution. =====
  {
    const p = new BridgeProtocol();
    const s = makeSettle();
    const command = enqueue(p, s, "c1");
    serveFlushAck(p, "c1", 1_000);

    const outcome = p.drop("c1"); // the host timeout timer / abort path
    ok(outcome.entry !== undefined, "timeout-orphan: drop() returned the pending entry");
    ok(outcome.entry?.state === "received", "timeout-orphan: entry was in received (acked) state");
    ok(p.pending.size === 0, "timeout-orphan: entry removed from pending");
    ok(p.queue.length === 0, "timeout-orphan: no queued copy remains");

    const notice = p.poll();
    ok(notice.type === "orphan", "timeout-orphan: the next /next returns an orphan notice");
    ok(notice.type === "orphan" && notice.orphan.id === "c1", "timeout-orphan: orphan carries the command id");
    ok(notice.type === "orphan" && notice.orphan.action === command.action, "timeout-orphan: orphan carries the action");
    ok(notice.type === "orphan" && notice.orphan.ackedAt === 1_001, "timeout-orphan: orphan carries ackedAt");
    ok(notice.type === "orphan" && /MAY have executed/.test(notice.orphan.note), "timeout-orphan: orphan warns the action MAY have executed");
    ok(notice.type === "orphan" && notice.orphan.note === ORPHAN_NOTE, "timeout-orphan: orphan note matches the wire contract");

    const after = p.poll();
    ok(after.type === "none", "timeout-orphan: orphan served exactly once; the command is never re-served");
    ok(s.settled.resolve === false && s.settled.reject === false, "timeout-orphan: the protocol itself never settled the promise (host does that)");

    s.cleanup();
    p.stop();
  }

  // ===== (3b) User abort of an acked command also pushes an orphan (orphan-abort). =====
  {
    const p = new BridgeProtocol();
    const s = makeSettle();
    enqueue(p, s, "c1");
    serveFlushAck(p, "c1", 1_000);
    const dropped = p.drop("c1"); // abort path (same drop() the onAbort handler calls)
    ok(dropped.entry?.state === "received", "abort-orphan: abort of a received entry drops it");
    const notice = p.poll();
    ok(notice.type === "orphan" && notice.orphan.id === "c1", "abort-orphan: aborted-but-acked command surfaces as an orphan");
    ok(p.poll().type === "none", "abort-orphan: orphan consumed once");

    // An abort BEFORE ack (state still pending) must NOT push an orphan — nothing executed.
    const p2 = new BridgeProtocol();
    const s2 = makeSettle();
    enqueue(p2, s2, "c2");
    p2.poll().claim.markFlushed(p2, 1_000); // delivered but never acked
    const early = p2.drop("c2");
    ok(early.entry?.state === "pending", "abort-orphan: never-acked entry stays pending at drop");
    ok(p2.poll().type === "none", "abort-orphan: never-acked abort produces no orphan notice");

    s.cleanup(); s2.cleanup();
    p.stop(); p2.stop();
  }

  // ===== (4) Late /result after timeout: accepted:false, never resolves the pending promise. =====
  {
    const p = new BridgeProtocol();
    const s = makeSettle();
    enqueue(p, s, "c1");
    serveFlushAck(p, "c1", 1_000);
    p.drop("c1"); // timed out before the result arrived

    const late = p.settle("c1"); // the /result handler for the SAME id arriving late
    ok(late.accepted === false, "late-result: /result after timeout returns accepted:false");
    ok(s.settled.resolve === false && s.settled.reject === false, "late-result: the late /result never resolved or rejected the promise");
    await tick(); await tick();
    ok(s.settled.resolve === false && s.settled.reject === false, "late-result: pending promise still unsettled after a few turns");
    ok(p.pending.size === 0, "late-result: no ghost pending entry is left behind");

    // Sanity: a /result for a still-pending id IS accepted and resolves the promise.
    const p2 = new BridgeProtocol();
    const s2 = makeSettle();
    enqueue(p2, s2, "c2");
    p2.poll().claim.markFlushed(p2, 1_000);
    const outcome = p2.settle("c2");
    ok(outcome.accepted === true, "late-result: /result for a live id is accepted");
    outcome.entry.resolve({ ok: "done" });
    const value = await s2.promise;
    ok(value.ok === "done", "late-result: accepted result resolves the pending promise");

    // A failing result rejects the promise.
    const p3 = new BridgeProtocol();
    const s3 = makeSettle();
    enqueue(p3, s3, "c3");
    p3.poll().claim.markFlushed(p3, 1_000);
    const failing = p3.settle("c3");
    failing.entry.reject(new Error("boom"));
    let caught = null;
    try { await s3.promise; } catch (e) { caught = e; }
    ok(caught instanceof Error && caught.message === "boom", "late-result: failing result rejects the pending promise");

    s.cleanup(); s2.cleanup(); s3.cleanup();
    p.stop(); p2.stop(); p3.stop();
  }

  // ===== (5) TOCTOU abort handling: unflushed claim requeued, flushed claim never requeued. =====
  {
    // Case A — client aborted AFTER the claim but BEFORE the bytes reached the kernel:
    // response.writableFinished is false -> the close handler requeues. The command is not
    // lost and is served to the next live poll.
    const p = new BridgeProtocol();
    const s = makeSettle();
    enqueue(p, s, "c1");
    const pollA = p.poll();
    ok(pollA.type === "command", "toctou: command claimed for the dying poll");
    ok(pollA.claim.isSettled === false, "toctou: claim is unsettled before flush/requeue");
    pollA.claim.requeue(p); // close handler: `claim !== undefined && !response.writableFinished`
    ok(p.queue.length === 1 && p.queue[0].id === "c1", "toctou: unflushed claim requeued");
    const next = p.poll();
    ok(next.type === "command" && next.claim.command.id === "c1", "toctou: requeued command served to the next live poll");

    // Case B — response DID flush before the reset: the SW saw the payload. The claim is
    // settled via markFlushed (the finish handler), so a late close must NOT requeue it.
    next.claim.markFlushed(p, 2_000);
    ok(next.claim.isSettled === true, "toctou: flushed claim is settled");
    next.claim.requeue(p); // late close handler — must be a no-op
    ok(p.queue.length === 0, "toctou: flushed claim is never requeued");
    ok(p.pending.get("c1")?.deliveredAt === 2_000, "toctou: deliveredAt is set only after flush");
    ok(p.ack("c1", 2_100) === true, "toctou: the flushed command can still be acked");

    // Case C — requeue is idempotent: two requeue calls never double-enqueue.
    const p2 = new BridgeProtocol();
    const s2 = makeSettle();
    enqueue(p2, s2, "c2");
    const pollC = p2.poll();
    pollC.claim.requeue(p2);
    pollC.claim.requeue(p2);
    pollC.claim.requeue(p2);
    ok(p2.queue.length === 1, "toctou: requeue is idempotent (exactly one copy in the queue)");

    s.cleanup(); s2.cleanup();
    p.stop(); p2.stop();
  }

  // ===== (5b) Enqueue delivers straight to a waiting /next long-poll (waiter path). =====
  {
    const p = new BridgeProtocol();
    let received;
    const waiter = (command) => { received = command; };
    p.addWaiter(waiter);
    const s = makeSettle();
    const command = makeCommand("c1");
    p.track(command, s.resolve, s.reject, s.timer);
    p.enqueue(command);
    ok(received !== undefined && received.id === "c1", "waiter: enqueue delivers to a waiting /next long-poll");
    ok(p.waiters.length === 0, "waiter: the waiter is consumed");
    ok(p.queue.length === 0, "waiter: the command did not also queue");

    const p2 = new BridgeProtocol();
    const s2 = makeSettle();
    const w2 = () => {};
    p2.addWaiter(w2);
    p2.removeWaiter(w2);
    ok(p2.waiters.length === 0, "waiter: removeWaiter drops the waiter");

    s.cleanup(); s2.cleanup();
    p.stop(); p2.stop();
  }

  // ===== (5c) stop() rejects pending commands, clears queue/orphans, wakes waiters. =====
  {
    const p = new BridgeProtocol();
    const s = makeSettle();
    enqueue(p, s, "c1");
    const s2 = makeSettle();
    enqueue(p, s2, "c2");
    let waiterWoken = false;
    p.addWaiter(() => { waiterWoken = true; });
    p.stop();
    ok(waiterWoken === true, "stop: waiters are woken with undefined");
    ok(p.pending.size === 0 && p.queue.length === 0 && p.orphaned.length === 0, "stop: protocol state cleared");
    ok(s.settled.reject === true && s2.settled.reject === true, "stop: every pending command is rejected");
    let message;
    try { await s.promise; } catch (e) { message = e.message; }
    ok(message === "Chrome profile bridge stopped", "stop: rejection carries the stop reason");
    s.cleanup(); s2.cleanup();
  }

  // ===== (6) Byte-budget journal eviction drops the oldest entry first. =====
  {
    // TTL + byte budget + entry cap, all oldest-first (journal-quota policy).
    const j = new BridgeJournal(/* maxEntries */ 100, /* maxBytes */ 600, /* ttlMs */ 60_000);
    const entry = (id, completedAt) => ({ id, action: "page.type".padEnd(120, "x"), ok: true, completedAt });
    // Each entry costs ~176 budget bytes, so 3 fit (528 < 600) but 4 overflow (704 > 600).
    j.record(entry("a", 1_000)); // oldest
    j.record(entry("b", 2_000));
    j.record(entry("c", 3_000));
    ok(j.has("a") && j.has("b") && j.has("c"), "journal: three entries recorded");
    j.record(entry("d", 4_000)); // blows the byte budget -> oldest dropped
    ok(!j.has("a"), "journal: byte budget dropped the OLDEST entry first (a)");
    ok(j.has("b") && j.has("c") && j.has("d"), "journal: newer entries survive the byte eviction");
    ok(j.byteCount() <= 600, "journal: byteCount respects the byte budget");

    // Record enough to keep pushing out the oldest each time.
    j.record(entry("e", 5_000));
    j.record(entry("f", 6_000));
    ok(!j.has("a") && !j.has("b") && !j.has("c") && j.has("d") && j.has("e") && j.has("f"), "journal: eviction stays oldest-first as more entries arrive");

    // Entry-count cap: a tiny cap drops oldest by completedAt.
    const jc = new BridgeJournal(2, 1_000_000, 60_000);
    jc.record(entry("a", 1_000));
    jc.record(entry("b", 2_000));
    jc.record(entry("c", 3_000));
    ok(jc.size === 2 && !jc.has("a") && jc.has("b") && jc.has("c"), "journal: entry-count cap keeps the newest two");

    // TTL: entries older than ttlMs are swept.
    const jt = new BridgeJournal(100, 1_000_000, 1_000);
    jt.record({ id: "old", action: "tab.version", ok: true, completedAt: 500 });
    jt.record({ id: "new", action: "tab.version", ok: true, completedAt: 5_000 });
    jt.sweep(2_000);
    ok(!jt.has("old") && jt.has("new"), "journal: TTL sweep drops entries older than the window");

    // get/has/delete round-trip.
    const jg = new BridgeJournal();
    jg.record({ id: "g1", action: "page.click", ok: true, completedAt: 1_000 });
    ok(jg.get("g1")?.action === "page.click", "journal: get returns the recorded digest");
    jg.delete("g1");
    ok(!jg.has("g1"), "journal: delete removes the entry");
    jg.clear();
    ok(jg.size === 0, "journal: clear empties the journal");
  }

  // ===== Protocol/queue helpers used by the host's status() and /next cap. =====
  {
    const p = new BridgeProtocol();
    const s = makeSettle();
    ok(p.pending.size === 0 && p.queue.length === 0, "status: empty protocol reports zero counts");
    enqueue(p, s, "c1");
    ok(p.pending.size === 1 && p.queue.length === 1, "status: tracked+queued command counted");

    // Heartbeat liveness (S5.1): newest age, prune cutoff, per-session keys.
    p.heartbeat("session:alpha", 1_000);
    p.heartbeat("session:beta", 2_000);
    const age = p.newestHeartbeatAt(5_000);
    ok(age === 3_000, "heartbeat: age is relative to the newest heartbeat");
    const pruned = p.pruneHeartbeats(5_000, 3_000); // ttl 3s: alpha (age 4s) pruned, beta (age 3s) kept
    ok(pruned === undefined, "heartbeat: pruneHeartbeats is a void sweep");
    ok(p.heartbeats.has("session:beta") && !p.heartbeats.has("session:alpha"), "heartbeat: stale keys pruned, fresh key kept");

    s.cleanup();
    p.stop();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
