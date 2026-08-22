import { aggregateFromMinuteRollup, aggregateFromRollup, aggregateLogs } from "../db/logs.js";
import { BUCKET_INTERVALS } from "../types/QueryParams.js";
import { combineConditions, commandCondition } from "./filters.js";
import { withAggregateCache } from "./aggregateCache.js";
import { queryLive } from "./liveAggregate.js";
// bucket=1m, no q=/attr.* filter — the one shape liveAggregate.ts actually
// tracks (see its header comment: q=/attr.* have an unbounded value space
// and are never counted there, only service/level/since/until are).
function canUseLive(query) {
    return (query.bucket === "1m"
        && !query.q
        && !(query.attr && Object.keys(query.attr).length > 0));
}
// bucket=1h/1d, with no q=/attr.* filter, served from the pre-aggregated
// logs_hourly_counts rollup (see src/db/schema.ts and src/db/logs.ts's
// aggregateFromRollup for why q=/attr.* specifically can't be pre-aggregated —
// their value space is unbounded, unlike service/level).
function canUseHourlyRollup(query) {
    return ((query.bucket === "1h" || query.bucket === "1d")
        && !query.q
        && !(query.attr && Object.keys(query.attr).length > 0));
}
// Same idea, one level finer — bucket=1m/5m with no q=/attr.* filter, served
// from logs_minute_counts (see schema.ts's logsMinuteCounts and
// aggregateFromMinuteRollup). Any q=/attr.<key> filter still falls all the
// way back to the live scan over `logs`, same as the hourly path.
function canUseMinuteRollup(query) {
    return ((query.bucket === "1m" || query.bucket === "5m")
        && !query.q
        && !(query.attr && Object.keys(query.attr).length > 0));
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
export async function runAggregate(query) {
    if (canUseLive(query)) {
        const liveBuckets = queryLive({
            since: new Date(query.since),
            until: new Date(query.until),
            service: query.service,
            level: query.level,
            groupBy: query.group_by,
        });
        // null means "outside what's retained/known" (see liveAggregate.ts's
        // queryLive) — not "no results". A real [] (an eligible, in-window
        // query that just matched nothing) short-circuits here same as any
        // other result. Deliberately skips withAggregateCache: this is
        // already faster and fresher than caching could make the DB path.
        if (liveBuckets !== null)
            return { buckets: liveBuckets };
    }
    if (canUseHourlyRollup(query)) {
        const compute = async () => {
            const buckets = await aggregateFromRollup({ service: query.service, level: query.level, since: new Date(query.since), until: new Date(query.until) }, query.bucket, query.group_by);
            return { buckets };
        };
        return withAggregateCache(query, compute);
    }
    if (canUseMinuteRollup(query)) {
        const compute = async () => {
            const buckets = await aggregateFromMinuteRollup({ service: query.service, level: query.level, since: new Date(query.since), until: new Date(query.until) }, query.bucket, query.group_by);
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
