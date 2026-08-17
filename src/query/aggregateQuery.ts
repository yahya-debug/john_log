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

// Every shape gets cached now, not just q=/attr.* filtered queries — see
// aggregateCache.ts's header comment for why the original "only cache what's
// individually expensive" reasoning stopped holding once reads moved to a
// dedicated replica (README's Schema and index design). Measured directly:
// with only the filtered shape cached, the *unfiltered* live-window shape
// (bucket=1m, no filter — the one this used to skip caching for specifically
// because it was "already cheap and index-backed") had a *worse* p95 (21.94s)
// than the genuinely expensive q=-filtered scan (21.54s), and even the
// rollup-served historical shape — reading a handful of rows from a small
// table — sat at 12.38s. None of those are individually expensive queries;
// they were all queuing behind each other on the replica's one CPU core.
// Caching every shape cuts how often *any* of them actually reaches Postgres,
// which is the lever that matters when the bottleneck is concurrent volume
// on a single core, not any one query's own cost.
export async function runAggregate(query: any) {
    if (canUseRollup(query)) {
        const compute = async () => {
            const buckets = await aggregateFromRollup(
                { service: query.service, level: query.level, since: new Date(query.since), until: new Date(query.until) },
                query.bucket,
                query.group_by
            );
            return { buckets };
        };
        return withAggregateCache(query, compute);
    }

    const compute = async () => {
        const conditions = commandCondition(query);
        const buckets = await aggregateLogs(combineConditions(conditions), BUCKET_INTERVALS[query.bucket], query.group_by);
        return { buckets };
    };

    return withAggregateCache(query, compute);
}
