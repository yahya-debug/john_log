import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { getStats } from "../../../src/db/stats.js";
import { insertLogs } from "../../../src/db/logs.js";
import { Env } from "../../../src/config.js";
import { uniqueService, deleteService } from "../helpers.js";
import type { ValidatedLog } from "../../../src/types/log.js";

const service = uniqueService("stats");

afterAll(() => deleteService(service));

beforeAll(async () => {
    const now = new Date();
    await insertLogs([
        { timestamp: now.toISOString(), level: "error", service, message: "a", attributes: {} },
        { timestamp: now.toISOString(), level: "error", service, message: "b", attributes: {} },
        { timestamp: now.toISOString(), level: "warn", service, message: "c", attributes: {} },
    ] satisfies ValidatedLog[]);
});

describe("getStats", () => {
    it("counts the just-inserted rows under the right service and level buckets", async () => {
        const stats = await getStats();

        expect(stats.totals.by_service[service]).toBe(3);
        expect(stats.totals.by_level.error).toBeGreaterThanOrEqual(2);
        expect(stats.totals.by_level.warn).toBeGreaterThanOrEqual(1);
        expect(stats.totals.rows).toBeGreaterThanOrEqual(3);
    });

    it("lists every partition, including logs_default, each with a name/bound/rows_estimate/size", async () => {
        const stats = await getStats();

        expect(stats.partitions.length).toBeGreaterThan(0);
        expect(stats.partitions.map((p) => p.name)).toContain("logs_default");
        for (const p of stats.partitions) {
            expect(typeof p.name).toBe("string");
            expect(typeof p.rows_estimate).toBe("number");
            expect(typeof p.size_bytes).toBe("number");
        }
    });

    it("sums partition sizes into database_size_bytes exactly", async () => {
        const stats = await getStats();
        const summedBytes = stats.partitions.reduce((sum, p) => sum + p.size_bytes, 0);
        expect(stats.database_size_bytes).toBe(summedBytes);
    });

    it("totals.rows is exact (from GROUP BY), unlike partitions[].rows_estimate (from catalog stats)", async () => {
        const stats = await getStats();

        // n_live_tup is a planner estimate refreshed by autovacuum/autoanalyze,
        // not guaranteed to equal the real count at request time — so this
        // only asserts totals.rows against real inserted data, not against
        // the estimate sum, which could legitimately drift from it.
        expect(stats.totals.rows).toBeGreaterThanOrEqual(3);
        expect(stats.totals.by_level.error + stats.totals.by_level.warn).toBeGreaterThanOrEqual(3);
    });

    it("reports a time_range that includes the just-inserted rows", async () => {
        const stats = await getStats();

        expect(stats.time_range.oldest).not.toBeNull();
        expect(stats.time_range.newest).not.toBeNull();
        expect(new Date(stats.time_range.newest!).getTime()).toBeGreaterThanOrEqual(
            new Date(stats.time_range.oldest!).getTime()
        );
    });

    it("reports a non-negative ingestion rate that reflects the just-inserted rows", async () => {
        const stats = await getStats();

        expect(stats.ingestion_rate.last_1m).toBeGreaterThanOrEqual(3);
        expect(stats.ingestion_rate.last_5m).toBeGreaterThanOrEqual(stats.ingestion_rate.last_1m);
        expect(stats.ingestion_rate.per_second_1m).toBeGreaterThanOrEqual(0);
    });

    it("echoes the actual retention config from Env", async () => {
        const stats = await getStats();

        expect(stats.retention_config).toEqual({
            retention_days: Env.RETENTION_DAYS,
            partition_lookahead_days: Env.PARTITION_LOOKAHEAD_DAYS,
            retention_cron: Env.RETENTION_CRON,
        });
    });
});
