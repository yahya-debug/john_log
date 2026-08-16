// Shared helpers for loadtest/k6/{load,stress,spike,breakpoint}.js — kept in one
// place so the four scenario scripts don't each reimplement batch generation,
// aggregate probing, and the post-run consistency check.
//
// This models the same four scenarios (Load/Stress/Spike/Breakpoint) and the same
// metric shapes (throughput, latency, error rate, resource usage, read-after-write,
// eventual consistency) as the real grading reports pulled from
// https://loadgen.foothilltech.net/ — for comparing a local run against those
// reports, not for reproducing their score. The grader's actual scoring rubric
// (why Performance lands at 15-34/50, Queries at 0-6/15, etc.) isn't observable
// from the outside — only inputs/outputs across a handful of runs are — so nothing
// here computes a fabricated score or rank. It reports the same raw numbers the
// grader shows and lets you compare by eye.
//
// Every ingested log carries attributes.load_run_id = a value unique to this k6
// run (generated once in sharedSetup(), threaded to every VU via the exec
// function's `data` argument). That's what sharedTeardown() uses to find exactly
// this run's own rows via one aggregate query, without needing a shared in-memory
// counter across VUs — k6 VUs are isolated JS runtimes; there's no way to
// accumulate a running total across them except through the server itself.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";

export const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
export const BATCH_SIZE = Number(__ENV.BATCH_SIZE) || 500; // logs per POST
export const HISTORY_DAYS = Number(__ENV.HISTORY_DAYS) || 30;
export const Q_TERM = __ENV.Q_TERM || "declined";
export const AGG_INTERVAL_SEC = Number(__ENV.AGG_INTERVAL_SEC) || 1;
// matches the ~30s drain cap consistently seen in the real grader's reports
export const DRAIN_TIMEOUT_SEC = Number(__ENV.DRAIN_TIMEOUT_SEC) || 30;
// fraction of ingest iterations that also do an immediate read-after-write check
export const RAW_SAMPLE_RATE = Number(__ENV.RAW_SAMPLE_RATE) || 0.02;

const SERVICES = ["checkout", "auth", "catalog", "payments", "shipping", "search"];
const LEVELS = ["debug", "info", "warn", "error"];
const REGIONS = ["us-east", "us-west", "eu-west", "eu-central", "ap-south"];

export const acceptedLogs = new Counter("accepted_logs");
export const rejectedLogs = new Counter("rejected_logs");
export const ingestErrors = new Counter("ingest_errors");
// a Trend of the numeric status code doubles as a cheap way to see the
// min/max status range (200-429, etc.) in k6's own summary output.
export const ingestStatusCode = new Trend("ingest_status_code", false);
export const rawSuccess = new Rate("raw_success");
export const aggLiveDuration = new Trend("agg_live_duration", true);
export const aggHistoricalDuration = new Trend("agg_historical_duration", true);
export const aggQFilteredDuration = new Trend("agg_q_filtered_duration", true);

export function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// runId is stamped onto every log's attributes so sharedTeardown() can find
// exactly this run's rows via attr.load_run_id; probeId (only set on the
// sampled subset) lets the immediate read-after-write check target one
// specific row instead of a whole batch.
function makeBatch(size, runId, probeId) {
    const now = Date.now();
    const logs = [];
    for (let i = 0; i < size; i++) {
        const attributes = {
            user_id: String(Math.floor(Math.random() * 100_000)),
            region: pick(REGIONS),
            retries: Math.floor(Math.random() * 5),
            load_run_id: runId,
        };
        if (probeId && i === 0) attributes.probe_id = probeId;
        logs.push({
            timestamp: new Date(now - Math.floor(Math.random() * 1000)).toISOString(),
            level: pick(LEVELS),
            service: pick(SERVICES),
            message: Math.random() < 0.1
                ? "payment declined"
                : `synthetic load-test event ${Math.random().toString(36).slice(2)}`,
            attributes,
        });
    }
    return JSON.stringify({ logs });
}

// Shared ingest iteration, called from every scenario's exec function with the
// runId sharedSetup() generated. Occasionally (RAW_SAMPLE_RATE) also verifies
// the batch is queryable immediately after being accepted — the "read-after-
// write success rate" the real grader reports separately from eventual
// consistency (which sharedTeardown() below measures over the whole run).
export function ingestOnce(runId) {
    const doProbe = Math.random() < RAW_SAMPLE_RATE;
    const probeId = doProbe ? `${runId}-${__VU}-${__ITER}` : null;
    const res = http.post(`${BASE_URL}/logs`, makeBatch(BATCH_SIZE, runId, probeId), {
        headers: { "Content-Type": "application/json" },
    });
    ingestStatusCode.add(res.status);
    const ok = check(res, { "ingest 2xx": (r) => r.status >= 200 && r.status < 300 });
    if (!ok) {
        ingestErrors.add(1);
        return;
    }
    const body = res.json();
    acceptedLogs.add(body.accepted || 0);
    rejectedLogs.add((body.rejected || []).length);

    if (doProbe) {
        const url = `${BASE_URL}/logs?attr.probe_id=${encodeURIComponent(probeId)}&limit=1`;
        const probeRes = http.get(url);
        const found = probeRes.status === 200 && (probeRes.json("logs") || []).length > 0;
        rawSuccess.add(found);
    }
}

function liveWindowUrl() {
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const until = new Date().toISOString();
    return `${BASE_URL}/logs/aggregate?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1m&group_by=service`;
}

function historicalUrl() {
    const since = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60_000).toISOString();
    const until = new Date().toISOString();
    return `${BASE_URL}/logs/aggregate?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1h&group_by=service`;
}

function qFilteredUrl() {
    const since = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60_000).toISOString();
    const until = new Date().toISOString();
    return `${BASE_URL}/logs/aggregate?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1h&q=${encodeURIComponent(Q_TERM)}`;
}

function probe(url, trend) {
    const res = http.get(url);
    check(res, { "aggregate 2xx": (r) => r.status >= 200 && r.status < 300 });
    trend.add(res.timings.duration);
}

export function aggLive() {
    probe(liveWindowUrl(), aggLiveDuration);
}

export function aggHistorical() {
    probe(historicalUrl(), aggHistoricalDuration);
}

export function aggQFiltered() {
    probe(qFilteredUrl(), aggQFilteredDuration);
}

// Builds one constant-arrival-rate scenario per phase, chained via startTime
// so each phase holds its target rate flat for its own duration before the
// next one takes over — a step function, not a ramp, matching how the real
// grader's reports describe phases ("15,000 logs/s (30s) -> 22,500 logs/s
// (60s) -> ..."). Every phase shares the same `exec: "ingest"` entry point.
export function buildIngestPhases(phases, batchSize) {
    const scenarios = {};
    let startTime = 0;
    for (let i = 0; i < phases.length; i++) {
        const { rate, durationSec } = phases[i];
        const batchRate = Math.max(1, Math.round(rate / batchSize));
        scenarios[`ingest_phase${i}_${rate}`] = {
            executor: "constant-arrival-rate",
            rate: batchRate,
            timeUnit: "1s",
            duration: `${durationSec}s`,
            startTime: `${startTime}s`,
            preAllocatedVUs: Math.min(batchRate * 5, 500),
            maxVUs: Math.min(batchRate * 30, 3000),
            exec: "ingest",
        };
        startTime += durationSec;
    }
    return { scenarios, totalDurationSec: startTime };
}

export function buildAggProbeScenarios(totalDurationSec, aggIntervalSec) {
    return {
        agg_live: {
            executor: "constant-arrival-rate",
            rate: 1,
            timeUnit: `${aggIntervalSec}s`,
            duration: `${totalDurationSec}s`,
            preAllocatedVUs: 2,
            maxVUs: 5,
            exec: "aggLive",
        },
        agg_historical: {
            executor: "constant-arrival-rate",
            rate: 1,
            timeUnit: `${aggIntervalSec}s`,
            duration: `${totalDurationSec}s`,
            preAllocatedVUs: 2,
            maxVUs: 5,
            exec: "aggHistorical",
        },
        agg_q_filtered: {
            executor: "constant-arrival-rate",
            rate: 1,
            timeUnit: `${aggIntervalSec}s`,
            duration: `${totalDurationSec}s`,
            preAllocatedVUs: 2,
            maxVUs: 5,
            exec: "aggQFiltered",
        },
    };
}

export function sharedSetup() {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();
    console.log(`load_run_id=${runId} started_at=${startedAt}`);
    return { runId, startedAt };
}

// Polls GET /logs/aggregate?attr.load_run_id=<runId>&bucket=1d (one query
// summing bucket counts, not a per-row scan) until the visible count stops
// growing between two consecutive polls, or DRAIN_TIMEOUT_SEC elapses. This
// is the "eventual consistency" measurement the grader reports (accepted vs.
// visible, drain time) — it doesn't need the accepted total as ground truth:
// convergence (visible count stable across two 1s-apart polls, matching the
// aggregate cache's own 1s TTL/rounding — see src/query/aggregateCache.ts)
// is itself evidence the write path has caught up. Compare the printed
// visible count against `accepted_logs` in k6's own end-of-run summary to
// see how many (if any) never showed up.
export function sharedTeardown(data) {
    const pollIntervalSec = 1;
    const start = Date.now();
    const deadline = start + DRAIN_TIMEOUT_SEC * 1000;
    let previous = -1;
    let visible = 0;
    let converged = false;

    while (Date.now() < deadline) {
        const until = new Date().toISOString();
        const url = `${BASE_URL}/logs/aggregate?since=${encodeURIComponent(data.startedAt)}`
            + `&until=${encodeURIComponent(until)}&bucket=1d&attr.load_run_id=${encodeURIComponent(data.runId)}`;
        const res = http.get(url);
        if (res.status === 200) {
            visible = (res.json("buckets") || []).reduce((sum, b) => sum + (b.count || 0), 0);
        }

        if (visible === previous && visible > 0) {
            converged = true;
            break;
        }
        previous = visible;
        sleep(pollIntervalSec);
    }

    const drainSec = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
        `eventual consistency: visible=${visible} converged=${converged} drain=${drainSec}s `
        + `(cap ${DRAIN_TIMEOUT_SEC}s) — compare against accepted_logs in the summary above`
    );
}
