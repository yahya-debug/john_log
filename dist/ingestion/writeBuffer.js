import { EventEmitter } from "node:events";
import { deadLetterEntries, insertLogs, upsertHourlyCounts } from "../db/logs.js";
import { db } from "../db/db.js";
// creating event emitter object to emit flushed event once entries are successfully flushed
// we disabled maximum listeners here by setting it to 0, default = 10
export const tailEmitter = new EventEmitter();
tailEmitter.setMaxListeners(0);
// Tried raising these to 2_000/500ms on the theory that a flush touching many
// partitions at once (see docs/ingestion-bottleneck.md) needed a bigger batch to
// amortize its now-higher fixed per-transaction cost. Measured result: roughly a
// wash at a flat sustained rate, but a large regression under any ramping/bursty
// scenario (Stress/Spike/Breakpoint) — flushing was single-flight at the time (one
// flush in progress at a time), so a bigger flush took longer to run, which meant
// the buffer kept accumulating for longer before the next flush could even start;
// under a ramping arrival rate that compounded into a runaway backlog faster than
// the smaller size did. Reverted back to the original values; bounded concurrent
// flushing (MAX_CONCURRENT_FLUSHES, below) is a separate lever aimed at the same
// underlying problem without that specific failure mode.
const FLUSH_SIZE = Number(process.env.WRITE_BUFFER_FLUSH_SIZE) || 10;
const FLUSH_INTERVAL_MS = Number(process.env.WRITE_BUFFER_FLUSH_INTERVAL_MS) || 100;
const MAX_BUFFER_SIZE = Number(process.env.WRITE_BUFFER_MAX_SIZE) || 50_000;
// How long a caller should wait before retrying a batch rejected for lack of
// buffer room (src/http/routes/logs.ts sets this as the 503's Retry-After).
const RETRY_AFTER_SEC = Number(process.env.WRITE_BUFFER_RETRY_AFTER_SEC) || 1;
// Retested at 2 (up from the old hardcoded 1) on the theory that concurrent
// flushes landing on different partitions (writes now spread across the
// retention window, not concentrated on one "hot" day) would contend with each
// other far less than the earlier single-hot-partition experiment that first
// ruled concurrency out (see docs/ingestion-bottleneck.md). Measured result:
// worse, not better — accepted throughput barely moved, but p95 latency and
// timeout counts got dramatically worse everywhere (e.g. Breakpoint timeouts
// 9,361 -> 39,115, p95 10.0s -> 55.9s). No OOM this time, but the same root
// cause as before: Postgres has exactly 1 real CPU, so "concurrent" flushes
// don't add parallelism, they add lock/scheduling contention for the same
// core — the write-side counterpart to why max_parallel_workers_per_gather is
// 0 in docker-compose.yml. Back to 1 (single-flight); left configurable rather
// than hardcoded since the mechanism itself is sound, just not a win here.
const MAX_CONCURRENT_FLUSHES = Number(process.env.WRITE_BUFFER_MAX_CONCURRENT_FLUSHES) || 1;
let buffer = [];
const inFlight = new Set();
// Admission control, not silent loss. A batch only ever enters the buffer (and
// thus only ever earns the 200 the route is about to send — see
// src/http/routes/logs.ts) if there's room for the WHOLE batch. This used to
// push unconditionally and silently trim the *oldest* entries back down to
// MAX_BUFFER_SIZE afterward — which meant POST /logs could 200 with
// { accepted: N } for entries that got quietly dropped moments later, before
// ever reaching Postgres. That's a direct violation of the brief's "never
// respond 200 to a batch you have not durably accepted"; rejecting up front
// with 503 + Retry-After is exactly the backpressure the brief itself
// sanctions instead. `buffer.length > 0 &&` lets a single legitimate batch
// bigger than MAX_BUFFER_SIZE through when the buffer is currently empty, so
// one large request can't become permanently unadmittable on its own.
export async function pushLogs(entries) {
    if (buffer.length > 0 && buffer.length + entries.length > MAX_BUFFER_SIZE) {
        return { admitted: false, retryAfterSec: RETRY_AFTER_SEC };
    }
    buffer.push(...entries);
    if (buffer.length >= FLUSH_SIZE)
        scheduleFlush();
    return { admitted: true };
}
function scheduleFlush() {
    if (inFlight.size >= MAX_CONCURRENT_FLUSHES)
        return;
    if (buffer.length === 0)
        return;
    // Declared before assignment so the closure below can remove this exact
    // promise from the set — `p` refers to itself once flush() settles.
    let p;
    p = flush().finally(() => {
        inFlight.delete(p);
        if (buffer.length >= FLUSH_SIZE)
            scheduleFlush(); // re-check when done — may start another concurrent flush
    });
    inFlight.add(p);
}
async function flush() {
    if (buffer.length == 0)
        return;
    // swap
    // nothing can interleave between "grab the array" and "replace it" —
    // but if you instead flushed the live array in place, entries pushed
    // during the (async) insertLogs call would either get lost or
    // double-sent depending on how you slice it
    const tmp = buffer;
    buffer = [];
    // RUN in one transaction for atomicity (all or none)
    try {
        await db.$client.begin(async (tx) => {
            await insertLogs(tmp, tx);
            await upsertHourlyCounts(tmp, tx);
        });
        tailEmitter.emit("flushed", tmp);
    }
    catch (error) {
        // Dead-letter does not mean postgres is unreachable only, it could be a transient issue
        // specific to this transaction (lock contention, a deadlock, a timeout). Try a
        // separate, much simpler insert before giving up. If Postgres genuinely is
        // down, this fails too and the batch is still lost — logged loudly, not silently.
        try {
            await deadLetterEntries(tmp, String(error?.message ?? error));
            console.error(`write buffer: flush failed, dead-lettered ${tmp.length} entries:`, error);
        }
        catch (deadLetterError) {
            console.error(`write buffer: flush AND dead-letter both failed, dropping ${tmp.length} entries:`, error, deadLetterError);
        }
    }
}
// .unref() so this timer alone doesn't keep the process alive — shutdown
setInterval(scheduleFlush, FLUSH_INTERVAL_MS).unref();
export async function flushNow() {
    if (inFlight.size > 0)
        await Promise.all(inFlight);
    await flush();
}
