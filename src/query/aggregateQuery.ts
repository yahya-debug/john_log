import { aggregateLogs } from "../db/logs.js";
import { AggQueryPar, BUCKET_INTERVALS } from "../types/QueryParams.js";
import { combineConditions, commandCondition } from "./filters.js";


export async function runAggregate(query: any) {
    let buckets = [];
    const conditions = commandCondition(query);

    buckets = await aggregateLogs(combineConditions(conditions), BUCKET_INTERVALS[query.bucket], query.group_by)

    return {
        buckets
    }
}