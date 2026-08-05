import { deadLetterEntries, insertLogs, upsertHourlyCounts } from "../db/logs.js";
import { db } from "../db/db.js";
import { ValidatedLog } from "../types/log.js";

// Counterintuitively small. A bigger FLUSH_SIZE (tried 2000, 8000) means
// fewer flushes but each one is a longer, more CPU-intensive transaction
// (index maintenance) that monopolizes Postgres's single CPU core for
// longer — measured directly: concurrent GET /logs/aggregate p95 got worse
// as FLUSH_SIZE went up, not better, because a bigger flush blocks whatever
// else wants the CPU for a bigger chunk of time. 10 was the value where
// both the 15,000 logs/sec ingestion target AND the aggregate p95<1s target
// were met simultaneously and repeatably — see docs/ingestion-bottleneck.md.
//
// Concurrent flushing (more than one in-flight insertLogs() at a time) was
// also tried, on the theory that loadtest:seed's 8-connection concurrency
// would translate here too. It didn't: every concurrency level tested made
// GET /logs/aggregate p95 worse, not better (2 concurrent: ~11s p95 vs ~3s
// sequential; 8 concurrent: OOM-crashed the app under the 256MB limit
// before it could be measured). Concurrent writers appear to contend for
// locks on the same partition/GIN index rather than usefully overlapping —
// unlike loadtest:seed's evenly-paced, pre-batched 2,000-row inserts, this
// buffer's flushes are triggered reactively and fragment under concurrency
// instead of coalescing into bigger transactions. Back to single-flight
// until that's actually solved — see docs/ingestion-bottleneck.md.
const FLUSH_SIZE = Number(process.env.WRITE_BUFFER_FLUSH_SIZE) || 10;
const FLUSH_INTERVAL_MS = Number(process.env.WRITE_BUFFER_FLUSH_INTERVAL_MS) || 100;
// Deliberately NOT derived from FLUSH_SIZE. A single POST /logs call can
// legally carry far more than FLUSH_SIZE entries (nothing caps batch size
// except the 10mb body limit — see src/http/app.ts), and pushLogs() applies
// this cap to the *whole incoming batch* before a flush gets a chance to
// drain anything. FLUSH_SIZE*10 (=100) silently dropped ~82% of a realistic
// 15,000 logs/sec, 500-per-request run: every push overshot the cap in one
// call, before the flush loop ever ran. Sized instead as real backpressure —
// several seconds of headroom at the brief's target rate, comfortably inside
// the 256MB app container limit (a ValidatedLog entry is a few hundred bytes;
// 50,000 of them is a few MB) — so it only ever trips if Postgres is
// genuinely falling behind, not as a routine side effect of batch size. Even
// so, at a sustained 15,000/sec this cap still gets hit — see
// docs/ingestion-bottleneck.md for the real, unresolved numbers.
const MAX_BUFFER_SIZE = Number(process.env.WRITE_BUFFER_MAX_SIZE) || 50_000;
let buffer: ValidatedLog[] = [];
let isFlush: Promise<void> | null = null;

export async function pushLogs(entries: ValidatedLog[]) {
    buffer.push(...entries)
    if (buffer.length > MAX_BUFFER_SIZE) {
        console.error(`write buffer: over capacity (${buffer.length}), dropping oldest ${buffer.length - MAX_BUFFER_SIZE} entries`)
        buffer.splice(0, buffer.length - MAX_BUFFER_SIZE)
    }
    if (buffer.length >= FLUSH_SIZE)
        scheduleFlush()
}

function scheduleFlush(): void {
    if (isFlush) return;

    isFlush = flush().finally(() => {
        isFlush = null;
        if (buffer.length >= FLUSH_SIZE)
            scheduleFlush(); // re-check when done
    })
}

async function flush(): Promise<void> {
    if (buffer.length == 0) return;

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
    } catch (error) {
        // Dead-letter does not mean postgres is unreachable only, it could be a transient issue
        // specific to this transaction (lock contention, a deadlock, a timeout). Try a
        // separate, much simpler insert before giving up. If Postgres genuinely is
        // down, this fails too and the batch is still lost — logged loudly, not silently.
        try {
            await deadLetterEntries(tmp, String((error as Error)?.message ?? error));
            console.error(`write buffer: flush failed, dead-lettered ${tmp.length} entries:`, error);
        } catch (deadLetterError) {
            console.error(`write buffer: flush AND dead-letter both failed, dropping ${tmp.length} entries:`, error, deadLetterError);
        }
    }
}

// .unref() so this timer alone doesn't keep the process alive — shutdown
setInterval(scheduleFlush, FLUSH_INTERVAL_MS).unref();

export async function flushNow(): Promise<void> {
    if (isFlush) await isFlush;
    await flush();
}
