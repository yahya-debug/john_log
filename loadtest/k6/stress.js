// "Stress Test" — staged ramp-up matching the real grader's reports:
// 15,000 logs/s (30s) -> 22,500 logs/s (60s) -> 30,000 logs/s (60s), 2.5min total.
// Deliberately pushes past the ~22,500/sec ceiling documented in the README's
// Measured performance results, so degradation here is expected, not a bug —
// this script reports what happens, it doesn't pass/fail it. See
// loadtest/k6/lib.js for shared ingest/probe/consistency logic.
//
// Usage:
//   npm run loadtest:seed   # first, so aggregate probes hit a realistic table
//   npm run loadtest:k6:stress
//   BATCH_SIZE=500 npm run loadtest:k6:stress
import {
    BATCH_SIZE, AGG_INTERVAL_SEC,
    ingestOnce, aggLive, aggHistorical, aggQFiltered,
    sharedSetup, sharedTeardown,
    buildIngestPhases, buildAggProbeScenarios,
} from "./lib.js";

const PHASES = [
    { rate: 15000, durationSec: 30 },
    { rate: 22500, durationSec: 60 },
    { rate: 30000, durationSec: 60 },
];

const { scenarios: ingestScenarios, totalDurationSec } = buildIngestPhases(PHASES, BATCH_SIZE);

export const options = {
    teardownTimeout: "45s",
    scenarios: {
        ...ingestScenarios,
        ...buildAggProbeScenarios(totalDurationSec, AGG_INTERVAL_SEC),
    },
};

export function setup() {
    console.log(`Stress: ${PHASES.map((p) => `${p.rate}/s for ${p.durationSec}s`).join(" -> ")}`);
    return sharedSetup();
}

export function ingest(data) {
    ingestOnce(data.runId);
}

export { aggLive, aggHistorical, aggQFiltered };

export function teardown(data) {
    sharedTeardown(data);
}
