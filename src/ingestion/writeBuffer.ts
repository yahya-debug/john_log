import { EventEmitter } from "node:events";
import { deadLetterEntries, insertLogs, upsertHourlyCounts } from "../db/logs.js";
import { db } from "../db/db.js";
import { ValidatedLog } from "../types/log.js";

// creating event emitter object to emit flushed event once entries are successfully flushed
// we disabled maximum listeners here by setting it to 0, default = 10
export const tailEmitter = new EventEmitter();
tailEmitter.setMaxListeners(0);
const FLUSH_SIZE = Number(process.env.WRITE_BUFFER_FLUSH_SIZE) || 10;
const FLUSH_INTERVAL_MS = Number(process.env.WRITE_BUFFER_FLUSH_INTERVAL_MS) || 100;
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
        tailEmitter.emit("flushed", tmp);
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
