import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "./db.js";
import { logs, logsDeadLetter, logsHourlyCounts } from "./schema.js";
export async function insertLogs(entries, client = db.$client) {
    if (entries.length === 0)
        return;
    // Use UNNEST function instead of VALUES for bulk inserts
    // VALUES generates dynamic placeholders, that may hit in our case the postgres's parameter limit
    // UNNEST fixed parameters (1 per column)
    //
    // Casting everything to text[] at the array boundary
    // * provides a clean, uniform "transport layer" because elemennts in an array literal should share the same type 
    // * avoids serialization bugs for complex structure like jsonB, uuid, because they may need specific wrappers
    // * avoids driver-level timezone shifting, for date objects, cause they behave depending on the timezone
    await client `
        INSERT INTO logs (timestamp, level, service, message, attributes)
        SELECT t.ts::timestamptz, t.level, t.service, t.message, t.attributes::jsonb
        FROM UNNEST(
            ${entries.map((e) => new Date(e.timestamp).toISOString())}::text[],
            ${entries.map((e) => e.level)}::text[],
            ${entries.map((e) => e.service)}::text[],
            ${entries.map((e) => e.message)}::text[],
            ${entries.map((e) => JSON.stringify(e.attributes ?? {}))}::text[]
        ) AS t(ts, level, service, message, attributes)
    `;
}
// Rolls entries up into logs_hourly_counts, keyed by (hour, service, level). Grouped
// client-side first so a single-batch flush (whose entries are almost always clustered
// within one hour) sends only a handful of UNNEST rows, not one per log entry — the
// upsert cost scales with distinct (hour, service, level) combinations touched, not with
// batch size. See schema.ts for why only service/level are tracked (not message/attributes).
export async function upsertHourlyCounts(entries, client = db.$client) {
    if (entries.length === 0)
        return;
    // no duplication in the same batch
    // we can do it another way by SUM and GROUPBY in our SQL query
    const counts = new Map();
    for (const e of entries) {
        const hour = new Date(Math.floor(new Date(e.timestamp).getTime() / 3_600_000) * 3_600_000).toISOString();
        const key = `${hour}${e.service}${e.level}`;
        const existing = counts.get(key);
        if (existing)
            existing.count++;
        else
            counts.set(key, { hour, service: e.service, level: e.level, count: 1 });
    }
    const rows = [...counts.values()];
    await client `
        INSERT INTO logs_hourly_counts (hour, service, level, count)
        SELECT t.hour::timestamptz, t.service, t.level, t.count::bigint
        FROM UNNEST(
            ${rows.map((r) => r.hour)}::text[],
            ${rows.map((r) => r.service)}::text[],
            ${rows.map((r) => r.level)}::text[],
            ${rows.map((r) => r.count)}::bigint[]
        ) AS t(hour, service, level, count)
        ON CONFLICT (hour, service, level) DO UPDATE
        SET count = logs_hourly_counts.count + excluded.count
    `;
}
// Last-resort persistence for a write-buffer flush that failed (src/ingestion/writeBuffer.ts).
// Raw tagged-template insert, not the drizzle query builder or UNNEST batching — deliberately
// as simple as possible, and independent of anything more elaborate (rollup upserts, array
// encoding) that could itself fail the same way the original flush did. See schema.ts's
// logsDeadLetter for what this can and can't recover from.
export async function deadLetterEntries(entries, reason, client = db.$client) {
    if (entries.length === 0)
        return;
    await client `
        INSERT INTO logs_dead_letter (reason, entries)
        VALUES (${reason}, ${JSON.stringify(entries)}::jsonb)
    `;
}
export async function listDeadLetters(limit = 50) {
    return db.select().from(logsDeadLetter).orderBy(logsDeadLetter.failedAt).limit(limit);
}
export async function deleteDeadLetter(id) {
    await db.delete(logsDeadLetter).where(eq(logsDeadLetter.id, id));
}
// Split out from queryLogs so tests can EXPLAIN the exact query production runs (see
// tests/integration/db/queryPlans.test.ts) instead of hand-duplicating the query shape —
// a duplicated query could silently drift from what's actually executed and assert on
// the wrong thing.
export function buildQueryLogsQuery(conditions, limit) {
    return db.select().from(logs).where(conditions).orderBy(desc(logs.timestamp), desc(logs.id)).limit(limit);
}
export async function queryLogs(conditions, limit) {
    return await buildQueryLogsQuery(conditions, limit);
}
// Same reasoning as buildQueryLogsQuery: kept separate so query-plan tests can reuse
// the exact production query object.
export function buildAggregateLogsQuery(conditions, bucket_size, group) {
    // Alias `start`/`group` explicitly so GROUP BY / ORDER BY can reference the output names directly (a Postgres
    // extension). Without an alias, drizzle re-serializes an expression differently depending on clause position
    // (e.g. unqualified "timestamp" in SELECT vs. "logs"."timestamp" in GROUP BY), and Postgres then sees the two
    // as textually different expressions and rejects the query.
    const bucketing = sql `date_bin(${bucket_size}::interval, ${logs.timestamp}, TIMESTAMPTZ '2000-01-01')`.as('start');
    // date_bin: rounds down a given timestamp into a specified interval boundary
    const group_by = group ? logs[group] : null; // whatever the group was, it's always a column in logs table
    const groupField = (group_by ? sql `${group_by}` : sql `NULL`).as('group');
    const baseQuery = db.select({
        start: bucketing,
        group: groupField,
        count: sql `COUNT(*)::int`
    }).from(logs).where(conditions);
    // Postgres rejects a bare NULL constant in GROUP BY, so only group by it when a real column is selected.
    return (group_by ? baseQuery.groupBy(sql `start`, sql `"group"`) : baseQuery.groupBy(sql `start`)).orderBy(sql `start`);
}
export async function aggregateLogs(conditions, bucket_size, group) {
    const rows = await buildAggregateLogsQuery(conditions, bucket_size, group);
    return rows.map((r) => ({
        start: new Date(r.start).toISOString(),
        group: r.group,
        count: r.count,
    }));
}
// Same output shape as aggregateLogs, but reads logs_hourly_counts instead of `logs` —
// only valid for bucket='1h'|'1d' with no q=/attr.* filter (see aggregateQuery.ts's
// routing, and schema.ts for why). Cost scales with hours-in-range × distinct
// service/level combinations, not with how many raw rows exist in that range.
export async function aggregateFromRollup(filters, bucket, group) {
    const conditions = [
        gte(logsHourlyCounts.hour, filters.since),
        lt(logsHourlyCounts.hour, filters.until),
    ];
    if (filters.service)
        conditions.push(eq(logsHourlyCounts.service, filters.service));
    if (filters.level)
        conditions.push(eq(logsHourlyCounts.level, filters.level));
    // 1h buckets are already the rollup's own granularity (no re-bucketing needed);
    // 1d re-buckets by flooring further, the same way aggregateLogs's date_bin does.
    const bucketing = (bucket === "1d"
        ? sql `date_bin('1 day'::interval, ${logsHourlyCounts.hour}, TIMESTAMPTZ '2000-01-01')`
        : sql `${logsHourlyCounts.hour}`).as('start');
    const group_by = group ? logsHourlyCounts[group] : null;
    const groupField = (group_by ? sql `${group_by}` : sql `NULL`).as('group');
    const baseQuery = db.select({
        start: bucketing,
        group: groupField,
        count: sql `SUM(${logsHourlyCounts.count})::int`,
    }).from(logsHourlyCounts).where(and(...conditions));
    const rows = await (group_by ? baseQuery.groupBy(sql `start`, sql `"group"`) : baseQuery.groupBy(sql `start`)).orderBy(sql `start`);
    return rows.map((r) => ({
        start: new Date(r.start).toISOString(),
        group: r.group,
        count: r.count,
    }));
}
