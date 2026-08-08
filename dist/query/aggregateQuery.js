import { aggregateFromRollup, aggregateLogs } from "../db/logs.js";
import { BUCKET_INTERVALS } from "../types/QueryParams.js";
import { combineConditions, commandCondition } from "./filters.js";
// Only bucket=1h/1d, with no q=/attr.* filter, can be served from the pre-aggregated
// logs_hourly_counts rollup (see src/db/schema.ts and src/db/logs.ts's
// aggregateFromRollup for why those two filters specifically can't be pre-aggregated —
// their value space is unbounded, unlike service/level). Everything else — finer
// buckets (1m/5m), or any q=/attr.<key> filter — falls back to the live scan over
// `logs`, unchanged from before this rollup existed.
function canUseRollup(query) {
    return ((query.bucket === "1h" || query.bucket === "1d")
        && !query.q
        && !(query.attr && Object.keys(query.attr).length > 0));
}
export async function runAggregate(query) {
    if (canUseRollup(query)) {
        const buckets = await aggregateFromRollup({ service: query.service, level: query.level, since: new Date(query.since), until: new Date(query.until) }, query.bucket, query.group_by);
        return { buckets };
    }
    const conditions = commandCondition(query);
    const buckets = await aggregateLogs(combineConditions(conditions), BUCKET_INTERVALS[query.bucket], query.group_by);
    return { buckets };
}
