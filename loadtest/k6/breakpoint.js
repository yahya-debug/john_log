// "Breakpoint Test" — staged climb matching the real grader's reports:
// 15,000 -> 22,500 -> 30,000 -> 45,000 logs/s, 30s per phase, 2min total.
// Exists to find where the system actually falls over, not to pass a
// threshold — the README's own measured ceiling is ~22,500-23,500/sec, so
// the 30,000/45,000 phases are expected to degrade hard. This script reports
// what happens rather than pass/failing it. See loadtest/k6/lib.js for shared
// ingest/probe/consistency logic.
//
// Usage:
//   npm run loadtest:seed   # first, so aggregate probes hit a realistic table
//   npm run loadtest:k6:breakpoint
import {
    BATCH_SIZE, AGG_INTERVAL_SEC,
    ingestOnce, aggLive, aggHistorical, aggQFiltered,
    sharedSetup, sharedTeardown,
    buildIngestPhases, buildAggProbeScenarios,
} from "./lib.js";

const PHASES = [
    { rate: 15000, durationSec: 30 },
    { rate: 22500, durationSec: 30 },
    { rate: 30000, durationSec: 30 },
    { rate: 45000, durationSec: 30 },
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
    console.log(`Breakpoint: ${PHASES.map((p) => `${p.rate}/s for ${p.durationSec}s`).join(" -> ")}`);
    return sharedSetup();
}

export function ingest(data) {
    ingestOnce(data.runId);
}

export { aggLive, aggHistorical, aggQFiltered };

export function teardown(data) {
    sharedTeardown(data);
}
