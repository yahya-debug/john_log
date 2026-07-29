// The test that answers "do I need RabbitMQ (or any queue/worker) in front
// of the DB write?" — it reproduces exactly the condition the brief grades
// on: sustained ingestion at the target rate while aggregate queries run
// concurrently. Read the verdict at the end.
//
// Usage:
//   npx tsx loadtest/mixed.ts
//   TARGET_RATE=500 DURATION_SEC=60 BATCH_SIZE=50 BASE_URL=http://localhost:8080 npx tsx loadtest/mixed.ts
//
// Run loadtest/seed.ts first so the aggregate query runs against a
// realistic ~1M row table, not an empty one.
//
// Probes two different aggregate shapes concurrently with ingestion:
//  - "live": a 5-minute rolling window (bucket=1m) — what a live dashboard
//    tailing recent activity would run. Partition pruning limits this to
//    ~today's partition regardless of total table size.
//  - "historical": a HISTORY_DAYS-wide range (bucket=1h) — a report/backfill
//    style query that can't rely on pruning down to one small partition, so
//    it's the more honest test of "does this hold up at ~1M+ rows".
import * as dotenv from 'dotenv'
import { percentile, summarize, pick } from "./util.js";

const BASE_URL = process.env.BASE_URL || "http://localhost:8080";
const DURATION_SEC = Number(process.env.DURATION_SEC) || 60;
const TARGET_RATE = Number(process.env.TARGET_RATE) || 500; // logs/sec
const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 50; // logs per POST
const AGG_INTERVAL_MS = Number(process.env.AGG_INTERVAL_MS) || 1000;
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS) || 7;

const SERVICES = ["checkout", "auth", "catalog", "payments", "shipping", "search"];
const LEVELS = ["debug", "info", "warn", "error"];
const REGIONS = ["us-east", "us-west", "eu-west", "eu-central", "ap-south"];

type Sample = { ms: number; ok: boolean };

function makeBatch(size: number) {
    const now = Date.now();
    return {
        logs: Array.from({ length: size }, () => ({
            timestamp: new Date(now - Math.floor(Math.random() * 1000)).toISOString(),
            level: pick(LEVELS),
            service: pick(SERVICES),
            message: `synthetic load-test event ${Math.random().toString(36).slice(2)}`,
            attributes: {
                user_id: String(Math.floor(Math.random() * 100_000)),
                region: pick(REGIONS),
                retries: Math.floor(Math.random() * 5),
            },
        })),
    };
}

async function postBatch(body: string): Promise<Sample & { accepted: number }> {
    const start = performance.now();
    try {
        const res = await fetch(`${BASE_URL}/logs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        });
        const json = await res.json().catch(() => ({}));
        return { ms: performance.now() - start, ok: res.ok, accepted: json.accepted ?? 0 };
    } catch {
        return { ms: performance.now() - start, ok: false, accepted: 0 };
    }
}

async function getAggregate(url: string): Promise<Sample> {
    const start = performance.now();
    try {
        const res = await fetch(url);
        await res.arrayBuffer();
        return { ms: performance.now() - start, ok: res.ok };
    } catch {
        return { ms: performance.now() - start, ok: false };
    }
}

async function runIngest(): Promise<{ samples: Sample[]; acceptedLogs: number }> {
    const batchesPerSec = TARGET_RATE / BATCH_SIZE;
    const intervalMs = 1000 / batchesPerSec;
    const totalBatches = Math.round((DURATION_SEC * 1000) / intervalMs);

    const samples: Sample[] = [];
    let acceptedLogs = 0;
    const inFlight: Promise<void>[] = [];
    const start = performance.now();

    for (let i = 0; i < totalBatches; i++) {
        const targetTime = i * intervalMs;
        const wait = targetTime - (performance.now() - start);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        const body = JSON.stringify(makeBatch(BATCH_SIZE));
        inFlight.push(
            postBatch(body).then((s) => {
                samples.push({ ms: s.ms, ok: s.ok });
                acceptedLogs += s.accepted;
            })
        );
    }

    await Promise.all(inFlight);
    return { samples, acceptedLogs };
}

function liveWindowUrl(): string {
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const until = new Date().toISOString();
    return `${BASE_URL}/logs/aggregate?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1m&group_by=service`;
}

function historicalUrl(): string {
    const since = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60_000).toISOString();
    const until = new Date().toISOString();
    return `${BASE_URL}/logs/aggregate?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1h&group_by=service`;
}

async function runAggregateProbe(testStart: number, durationMs: number, urlFn: () => string): Promise<Sample[]> {
    const samples: Sample[] = [];

    while (performance.now() - testStart < durationMs) {
        samples.push(await getAggregate(urlFn()));
        await new Promise((r) => setTimeout(r, AGG_INTERVAL_MS));
    }

    return samples;
}

function reportAggregate(label: string, samples: Sample[]): { errors: number; p95: number } {
    const errors = samples.filter((s) => !s.ok).length;
    const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
    const p95 = percentile(latencies, 95);
    summarize(label, latencies, errors, samples.length);
    return { errors, p95 };
}

async function main() {
    console.log(`Target: ${TARGET_RATE} logs/sec for ${DURATION_SEC}s (batch size ${BATCH_SIZE}) against ${BASE_URL}\n`);

    const testStart = performance.now();
    const [{ samples: ingestSamples, acceptedLogs }, liveAggSamples, historicalAggSamples] = await Promise.all([
        runIngest(),
        runAggregateProbe(testStart, DURATION_SEC * 1000, liveWindowUrl),
        runAggregateProbe(testStart, DURATION_SEC * 1000, historicalUrl),
    ]);
    const elapsedSec = (performance.now() - testStart) / 1000;

    const ingestErrors = ingestSamples.filter((s) => !s.ok).length;
    const achievedRate = acceptedLogs / elapsedSec;
    console.log("--- Ingestion (POST /logs) ---");
    summarize("ingest", ingestSamples.map((s) => s.ms), ingestErrors, ingestSamples.length);
    console.log(`achieved rate: ${achievedRate.toFixed(0)} logs/sec (target ${TARGET_RATE})`);

    console.log(`\n--- Aggregate: live 5m window, bucket=1m (GET /logs/aggregate), concurrent with ingestion ---`);
    const live = reportAggregate("aggregate/live", liveAggSamples);

    console.log(`\n--- Aggregate: ${HISTORY_DAYS}d window, bucket=1h (GET /logs/aggregate), concurrent with ingestion ---`);
    const historical = reportAggregate("aggregate/historical", historicalAggSamples);

    const ingestOk = ingestErrors === 0 && achievedRate >= TARGET_RATE * 0.95;
    const liveOk = live.errors === 0 && live.p95 < 1000;
    const historicalOk = historical.errors === 0 && historical.p95 < 1000;

    console.log("\n--- Verdict ---");
    if (ingestOk && liveOk && historicalOk) {
        console.log(
            "Direct synchronous insert keeps up at target load: no dropped/errored requests, "
            + "and both the live-window and wide-range aggregates stay under the 1s p95 target "
            + "while writes are running. No evidence yet that a RabbitMQ pub/sub layer is needed — "
            + "it would add operational complexity without fixing a bottleneck that doesn't exist."
        );
    } else {
        if (!ingestOk) {
            console.log(
                `Ingestion can't cleanly sustain ${TARGET_RATE}/s (errors=${ingestErrors}, `
                + `achieved=${achievedRate.toFixed(0)}/s). Each request currently blocks on a synchronous `
                + "INSERT — a queue would let POST /logs ack immediately and let a worker batch-write, "
                + "absorbing bursts instead of the HTTP layer taking the hit."
            );
        }
        if (!liveOk) {
            console.log(
                `Live-window aggregate p95 (${live.p95.toFixed(0)}ms) misses the 1s target while ingestion `
                + "is active, despite partition pruning limiting it to ~today's data. That points at write "
                + "contention (locks/connection pool) rather than scan volume — a queue-buffered batch "
                + "writer would relieve it by issuing far fewer, larger transactions instead of one per request."
            );
        }
        if (!historicalOk) {
            console.log(
                `Historical (${HISTORY_DAYS}d) aggregate p95 (${historical.p95.toFixed(0)}ms) misses the 1s `
                + "target. Compare against the live-window number above: if historical is much worse, the gap "
                + "is query cost at scale (scanning many partitions), which is an indexing/rollup problem, not "
                + "something a queue in front of ingestion fixes — consider pre-aggregated rollup tables instead."
            );
        }
    }

    process.exit(0);
}

main();
