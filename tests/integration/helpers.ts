// Shared setup for integration tests, which run against the real Postgres
// instance (DB_CONNECTION from .env / docker-compose) rather than mocks.
// Every test scopes itself to a unique `service` tag so it can run safely
// against a database that already holds real/seeded data, and cleans up
// after itself rather than requiring a dedicated empty test database.
import { eq } from "drizzle-orm";
import { db } from "../../src/db/db.js";
import { logs, logsHourlyCounts } from "../../src/db/schema.js";

let counter = 0;

export function uniqueService(prefix: string): string {
    counter += 1;
    return `__itest_${prefix}_${Date.now()}_${counter}__`;
}

// Cleans up both `logs` and its rollup (logs_hourly_counts) — every integration test
// service tag is unique, so both deletes are always scoped to that one test's own data.
export async function deleteService(service: string): Promise<void> {
    await db.delete(logs).where(eq(logs.service, service));
    await db.delete(logsHourlyCounts).where(eq(logsHourlyCounts.service, service));
}

// Runs a real EXPLAIN against the exact query object production would run (built via
// e.g. buildQueryLogsQuery/buildAggregateLogsQuery in src/db/logs.ts) and returns the
// plan as one string. Used by index-regression tests
// (tests/integration/db/queryPlans.test.ts) to assert on plan *shape* (which index, or
// Seq Scan vs Index Scan) — not on timing, which is too environment-dependent to assert
// on in a test.
export async function explainPlan(query: { toSQL(): { sql: string; params: unknown[] } }): Promise<string> {
    const { sql: text, params } = query.toSQL();
    const rows = await db.$client.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${text}`, params as any[]);
    return rows.map((r) => r["QUERY PLAN"]).join("\n");
}
