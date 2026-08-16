// "Spike Test" — staged burst matching the real grader's reports:
// 7,500 logs/s (30s) -> 30,000 logs/s (10s) -> 7,500 logs/s (60s), 1.67min total.
// Tests recovery after a sudden burst well past the documented throughput
// ceiling, not sustained throughput — degradation during the 10s spike is
// expected, this script reports what happens rather than pass/failing it. See
// loadtest/k6/lib.js for shared ingest/probe/consistency logic.
//
// Usage:
//   npm run loadtest:seed   # first, so aggregate probes hit a realistic table
//   npm run loadtest:k6:spike
import {
    BATCH_SIZE, AGG_INTERVAL_SEC,
    ingestOnce, aggLive, aggHistorical, aggQFiltered,
    sharedSetup, sharedTeardown,
    buildIngestPhases, buildAggProbeScenarios,
} from "./lib.js";

const PHASES = [
    { rate: 7500, durationSec: 30 },
    { rate: 30000, durationSec: 10 },
    { rate: 7500, durationSec: 60 },
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
    console.log(`Spike: ${PHASES.map((p) => `${p.rate}/s for ${p.durationSec}s`).join(" -> ")}`);
    return sharedSetup();
}

export function ingest(data) {
    ingestOnce(data.runId);
}

export { aggLive, aggHistorical, aggQFiltered };

export function teardown(data) {
    sharedTeardown(data);
}
