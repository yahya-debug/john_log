// "Load Test" — matches the confirmed grading spec: k6 ingesting 15,000 logs/sec
// for 120s, flat (no ramping). See loadtest/k6/lib.js for shared ingest/probe/
// consistency logic and what this does (and doesn't) try to reproduce from the
// real grader's reports.
//
// Usage:
//   npm run loadtest:seed   # first, so aggregate probes hit a realistic table
//   npm run loadtest:k6:load
//   TARGET_RATE=15000 DURATION_SEC=120 BATCH_SIZE=500 npm run loadtest:k6:load
import {
    BATCH_SIZE, AGG_INTERVAL_SEC,
    ingestOnce, aggLive, aggHistorical, aggQFiltered,
    sharedSetup, sharedTeardown,
    buildIngestPhases, buildAggProbeScenarios,
} from "./lib.js";

const TARGET_RATE = Number(__ENV.TARGET_RATE) || 15000; // logs/sec
const DURATION_SEC = Number(__ENV.DURATION_SEC) || 120;

const { scenarios: ingestScenarios } = buildIngestPhases(
    [{ rate: TARGET_RATE, durationSec: DURATION_SEC }],
    BATCH_SIZE
);

export const options = {
    teardownTimeout: "45s",
    scenarios: {
        ...ingestScenarios,
        ...buildAggProbeScenarios(DURATION_SEC, AGG_INTERVAL_SEC),
    },
    thresholds: {
        ingest_errors: ["count==0"],
        accepted_logs: [`count>=${Math.floor(TARGET_RATE * DURATION_SEC * 0.95)}`],
        agg_live_duration: ["p(95)<1000"],
        agg_historical_duration: ["p(95)<1000"],
        agg_q_filtered_duration: ["p(95)<1000"],
    },
};

export function setup() {
    console.log(`Load: ${TARGET_RATE} logs/s for ${DURATION_SEC}s, flat`);
    return sharedSetup();
}

export function ingest(data) {
    ingestOnce(data.runId);
}

export { aggLive, aggHistorical, aggQFiltered };

export function teardown(data) {
    sharedTeardown(data);
}
