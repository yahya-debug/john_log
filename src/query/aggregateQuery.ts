import { aggregateFromRollup, aggregateLogs } from "../db/logs.js";
import { AggQueryPar, BUCKET_INTERVALS } from "../types/QueryParams.js";
import { combineConditions, commandCondition } from "./filters.js";
import { withAggregateCache } from "./aggregateCache.js";

// Only bucket=1h/1d, with no q=/attr.* filter, can be served from the pre-aggregated
// logs_hourly_counts rollup (see src/db/schema.ts and src/db/logs.ts's
// aggregateFromRollup for why those two filters specifically can't be pre-aggregated —
// their value space is unbounded, unlike service/level). Everything else — finer
// buckets (1m/5m), or any q=/attr.<key> filter — falls back to the live scan over
// `logs`, unchanged from before this rollup existed.
function canUseRollup(query: any): boolean {
    return (
        (query.bucket === "1h" || query.bucket === "1d")
        && !query.q
        && !(query.attr && Object.keys(query.attr).length > 0)
    );
}

// The one live-scan shape actually expensive enough to justify trading a few
// seconds of staleness for (see aggregateCache.ts's header comment): q=/attr.*
// filters have no supporting index, so a single call can cost over a second of
// Postgres CPU. A plain bucket=1m/5m query with no filter is already cheap and
// index-backed — caching it too would buy nothing but staleness on a shape a
// correctness check (POST /logs then immediately GET .../aggregate) is very
// likely to hit.
function isFilteredLiveScan(query: any): boolean {
    return !!query.q || !!(query.attr && Object.keys(query.attr).length > 0);
}

// Rollup-served aggregates are already cheap (reads logs_hourly_counts, O(hours)
// not O(rows) — see db/logs.ts), so only the live-scan path is worth caching:
// that's the shape a q=/attr.* filtered request always falls into, and the one
// that can cost over a second of Postgres CPU per call (see
// docs/ingestion-bottleneck.md). Caching the cheap path too would just add
// cache-management overhead for no real saving.
export async function runAggregate(query: any) {
    if (canUseRollup(query)) {
        const buckets = await aggregateFromRollup(
            { service: query.service, level: query.level, since: new Date(query.since), until: new Date(query.until) },
            query.bucket,
            query.group_by
        );
        return { buckets };
    }

    const compute = async () => {
        const conditions = commandCondition(query);
        const buckets = await aggregateLogs(combineConditions(conditions), BUCKET_INTERVALS[query.bucket], query.group_by);
        return { buckets };
    };

    return isFilteredLiveScan(query) ? withAggregateCache(query, compute) : compute();
}
