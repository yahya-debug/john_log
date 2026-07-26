import { desc, sql, SQL } from "drizzle-orm";
import { ValidatedLog } from "../types/log.js";
import { db } from "./db.js";
import { logs } from "./schema.js";

export async function insertLogs(entries: ValidatedLog[]) {
    return await db.insert(logs).values(entries.map((entry) => ({
        timestamp: new Date(entry.timestamp),
        level: entry.level,
        service: entry.service,
        message: entry.message,
        attributes: entry.attributes
    }))).returning();
}

export async function queryLogs(conditions: SQL | undefined, limit: number) {
    return await db.select().from(logs).where(conditions).orderBy(desc(logs.timestamp), desc(logs.id)).limit(limit);
}

export async function aggregateLogs(conditions: SQL | undefined, bucket_size: string, group?: "service" | "level" | null | undefined) {
    // Alias `start`/`group` explicitly so GROUP BY / ORDER BY can reference the output names directly (a Postgres
    // extension). Without an alias, drizzle re-serializes an expression differently depending on clause position
    // (e.g. unqualified "timestamp" in SELECT vs. "logs"."timestamp" in GROUP BY), and Postgres then sees the two
    // as textually different expressions and rejects the query.
    const bucketing = sql<string>`date_bin(${bucket_size}::interval, ${logs.timestamp}, TIMESTAMPTZ '2000-01-01')`.as('start');
    // date_bin: rounds down a given timestamp into a specified interval boundary

    const group_by = group ? logs[group] : null; // whatever the group was, it's always a column in logs table
    const groupField = (group_by ? sql`${group_by}` : sql<string | null>`NULL`).as('group');

    const baseQuery = db.select({
        start: bucketing,
        group: groupField,
        count: sql<number>`COUNT(*)::int`
    }).from(logs).where(conditions);

    // Postgres rejects a bare NULL constant in GROUP BY, so only group by it when a real column is selected.
    const rows = await (group_by ? baseQuery.groupBy(sql`start`, sql`"group"`) : baseQuery.groupBy(sql`start`)).orderBy(sql`start`);

    return rows.map((r) => ({
        start: new Date(r.start).toISOString(),
        group: r.group,
        count: r.count,
    }));
}