// Separate process (its own container — see docker-compose.yml's worker service) that
// consumes batches published by src/ingestion/writeBuffer.ts and does the actual Postgres
// insert. Exists so the app container's 0.5 CPU budget is spent entirely on HTTP request
// handling — see writeBuffer.ts's header comment for why that split matters now in a way
// it didn't the first time RabbitMQ was tried here.
//
// Deliberately does NOT import db/migrate.js or trigger runMigration() — only the app
// process does that (src/http/app.ts), so two processes never race to apply the same
// migration. Also doesn't create the database if missing (unlike db/db.ts's own
// initialization dance) — the app process (or the postgres image's own POSTGRES_DB
// bootstrap) is expected to have it ready first.
import { fileURLToPath } from "node:url";
import amqp from "amqplib";
import { Env } from "./config.js";
import { db } from "./db/db.js";
import { deadLetterEntries, insertLogs, upsertHourlyCounts } from "./db/logs.js";
import { ValidatedLog } from "./types/log.js";

// Larger than the old in-process FLUSH_SIZE (10): each queue message is already a whole
// POST /logs batch (tens to hundreds of entries), not a single log, so reaching a given
// entry count takes far fewer messages. Sized to amortize the insert transaction's fixed
// cost over more rows, same reasoning as the old code's now-removed "raise FLUSH_SIZE"
// experiment — except that experiment failed specifically because bigger batches meant
// longer single-flight flushes, which let the buffer run away under a ramping arrival
// rate (see git history). That risk doesn't apply the same way here: the buffer that
// could "run away" is now RabbitMQ's own bounded queue (x-max-length + reject-publish),
// not unbounded JS heap, so a slower individual flush degrades into backpressure
// (429s from writeBuffer.ts) instead of an OOM.
const FLUSH_SIZE = Number(process.env.WORKER_FLUSH_SIZE) || 1000;
const FLUSH_INTERVAL_MS = Number(process.env.WORKER_FLUSH_INTERVAL_MS) || 100;

// Module-level so flush()/onMessage() share state without threading it through every
// call — same shape as the old in-process writeBuffer.ts. Exported setter below is for
// tests only (no live amqp connection there); production code only ever sets it once,
// from main().
let channel: amqp.Channel;
export function _setChannelForTests(ch: amqp.Channel): void {
    channel = ch;
}

// Parallel arrays: pending[i] is the raw message whose entries were merged into
// pendingEntries; delivery tags are cumulative in RabbitMQ, so acking/nacking the last
// message in `pending` with `allUpTo=true` settles every message before it in one call.
let pending: amqp.ConsumeMessage[] = [];
let pendingEntries: ValidatedLog[] = [];
let flushing = false;

export async function flush(): Promise<void> {
    if (flushing || pending.length === 0) return;
    flushing = true;

    // swap — same reasoning as the old writeBuffer.ts's flush(): grab-then-replace so
    // messages that arrive during the (async) insert land in a fresh batch instead of
    // being lost or double-counted.
    const msgs = pending;
    const entries = pendingEntries;
    pending = [];
    pendingEntries = [];

    const last = msgs[msgs.length - 1]!;

    try {
        await db.$client.begin(async (tx) => {
            await insertLogs(entries, tx);
            await upsertHourlyCounts(entries, tx);
        });
        safeSettle(() => channel.ack(last, true));
    } catch (error) {
        console.error(`worker: flush failed, dead-lettering ${entries.length} entries:`, error);
        try {
            await deadLetterEntries(entries, String((error as Error)?.message ?? error));
            safeSettle(() => channel.ack(last, true));
        } catch (deadLetterError) {
            console.error(`worker: flush AND dead-letter both failed, requeueing ${entries.length} entries:`, error, deadLetterError);
            // requeue=true, unlike the old in-process version's final "drop it, log
            // loudly" fallback: Postgres being transiently unreachable doesn't cost
            // anything to wait out now that the batch lives in a durable queue instead
            // of process memory. If entries are individually poisoned (not a Postgres
            // outage), this does mean a retry loop — accepted for now given the time
            // budget; a dead-letter-exchange-after-N-redeliveries policy would be the
            // next step if that turns out to matter in practice.
            safeSettle(() => channel.nack(last, true, true));
        }
    } finally {
        flushing = false;
        if (pending.length >= FLUSH_SIZE) void flush();
    }
}

// ack/nack throw synchronously (not reject) if the channel is already closed — observed
// for real under sustained load (loadtest/scenarios.ts Stress+Breakpoint): RabbitMQ's own
// container OOM'd (see docker-compose.yml's rabbitmq comment), the connection dropped
// mid-flush, and the resulting synchronous throw from channel.nack() went unhandled and
// crashed the whole worker process. A channel that's already gone doesn't need settling —
// the entries just get redelivered once the connection recovers — so this only needs to
// not crash the process; the actual recovery is exitOnConnectionClose below, which lets
// docker's restart: on-failure give the worker a fresh connection instead of continuing
// to run against a channel that can never ack/nack again.
function safeSettle(fn: () => void): void {
    try {
        fn();
    } catch (error) {
        console.error("worker: ack/nack failed (channel likely already closed):", error);
    }
}

export function onMessage(msg: amqp.ConsumeMessage | null): void {
    if (!msg) return; // consumer cancelled by the broker (e.g. queue deleted)

    let entries: ValidatedLog[];
    try {
        entries = JSON.parse(msg.content.toString());
    } catch (error) {
        console.error("worker: dropping unparseable message:", error);
        safeSettle(() => channel.ack(msg));
        return;
    }

    pending.push(msg);
    pendingEntries.push(...entries);
    if (pendingEntries.length >= FLUSH_SIZE) void flush();
}

async function main() {
    const conn = await amqp.connect(Env.RABBITMQ_URL);
    conn.on("error", (err) => console.error("worker: rabbitmq connection error:", err));
    // amqplib always follows an 'error' with 'close' on the same connection — this is the
    // one place that actually recovers from a dropped connection. Deliberately exits
    // (rather than trying to reconnect in-process) so docker-compose's restart: on-failure
    // gives the worker a genuinely fresh amqp.connect() + channel instead of continuing to
    // run against connection/channel objects that can never be used again.
    conn.on("close", () => {
        console.error("worker: rabbitmq connection closed, exiting so docker restarts with a fresh connection");
        process.exit(1);
    });

    channel = await conn.createChannel();
    await channel.assertQueue(Env.RABBITMQ_QUEUE, {
        durable: true,
        arguments: {
            "x-max-length": Number(process.env.RABBITMQ_MAX_QUEUE_LENGTH) || 20_000,
            "x-overflow": "reject-publish",
        },
    });
    // Bounds unacked messages in flight to this consumer — the exact lesson from the
    // first time this was tried (see git history/docs/ingestion-bottleneck.md): an
    // unbounded prefetch let unacked messages pile up in the worker's own JS heap under
    // sustained load and OOM'd it. WORKER_PREFETCH defaults to 200 (src/config.ts).
    await channel.prefetch(Env.WORKER_PREFETCH);

    channel.consume(Env.RABBITMQ_QUEUE, onMessage, { noAck: false });

    // .unref() so this timer alone doesn't keep the process alive on shutdown.
    setInterval(() => void flush(), FLUSH_INTERVAL_MS).unref();

    console.log(`worker: consuming from '${Env.RABBITMQ_QUEUE}' (prefetch=${Env.WORKER_PREFETCH})`);
}

const SHUTDOWN_FLUSH_TIMEOUT_MS = 5000;

async function shutdown(signal: string) {
    console.log(`${signal} received, shutting down`);
    try {
        await Promise.race([
            flush(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("flush timed out")), SHUTDOWN_FLUSH_TIMEOUT_MS)),
        ]);
        console.log("worker: final flush complete");
    } catch (err) {
        console.error("worker: shutdown flush did not complete in time, exiting anyway:", err);
    }
    process.exit(0);
}

// Only run as a side effect when this file is the actual entrypoint (`node dist/worker.js`)
// — not when imported by tests, which supply their own mock channel via
// _setChannelForTests and call flush()/onMessage() directly instead.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((error) => {
        console.error("worker: fatal startup error:", error);
        process.exit(1);
    });
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}
