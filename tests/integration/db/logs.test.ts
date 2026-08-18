import { describe, expect, it, afterAll, afterEach, beforeAll } from "vitest";
import { aggregateFromMinuteRollup, aggregateFromRollup, aggregateLogs, deadLetterEntries, deleteDeadLetter, insertLogs, listDeadLetters, queryLogs, upsertHourlyCounts, upsertMinuteCounts } from "../../../src/db/logs.js";
import { combineConditions, commandCondition } from "../../../src/query/filters.js";
import type { ValidatedLog } from "../../../src/types/log.js";
import { uniqueService, deleteService } from "../helpers.js";

const now = new Date();

function entry(service: string, overrides: Partial<ValidatedLog> = {}): ValidatedLog {
    return {
        timestamp: now.toISOString(),
        level: "info",
        service,
        message: "hello from integration test",
        attributes: {},
        ...overrides,
    };
}

describe("insertLogs", () => {
    const service = uniqueService("insert");
    afterAll(() => deleteService(service));

    // insertLogs no longer returns the inserted rows (dropped .returning()
    // to keep the hot POST /logs path cheap under the 0.5-CPU app limit),
    // so these assert via queryLogs instead of the call's return value.
    async function fetchByService(svc: string) {
        return queryLogs(combineConditions(commandCondition({ service: svc })), 100);
    }

    it("inserts entries, generating a server-assigned id", async () => {
        await insertLogs([entry(service, { message: "insert-1" })]);

        const rows = await fetchByService(service);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBeTruthy();
        expect(rows[0].service).toBe(service);
        expect(rows[0].message).toBe("insert-1");
    });

    it("inserts a whole batch in one call", async () => {
        const batchService = uniqueService("insert-batch");
        await insertLogs([
            entry(batchService, { message: "batch-1" }),
            entry(batchService, { message: "batch-2" }),
            entry(batchService, { message: "batch-3" }),
        ]);
        const rows = await fetchByService(batchService);
        expect(rows).toHaveLength(3);
        await deleteService(batchService);
    });

    it("stores attributes as provided", async () => {
        const attrsService = uniqueService("insert-attrs");
        await insertLogs([
            entry(attrsService, { message: "attrs", attributes: { user_id: "42", region: "eu-west" } }),
        ]);
        const [row] = await fetchByService(attrsService);
        expect(row.attributes).toEqual({ user_id: "42", region: "eu-west" });
        await deleteService(attrsService);
    });

    it("defaults attributes to {} at the DB level when omitted entirely", async () => {
        const noAttrsService = uniqueService("insert-no-attrs");
        await insertLogs([
            { timestamp: now.toISOString(), level: "info", service: noAttrsService, message: "no-attrs" } as ValidatedLog,
        ]);
        const [row] = await fetchByService(noAttrsService);
        expect(row.attributes).toEqual({});
        await deleteService(noAttrsService);
    });
});

describe("queryLogs", () => {
    const service = uniqueService("query");
    afterAll(() => deleteService(service));

    beforeAll(async () => {
        await insertLogs([
            entry(service, { message: "q-oldest", timestamp: new Date(now.getTime() - 2000).toISOString(), level: "info" }),
            entry(service, { message: "q-middle", timestamp: new Date(now.getTime() - 1000).toISOString(), level: "warn" }),
            entry(service, { message: "q-newest", timestamp: now.toISOString(), level: "error" }),
        ]);
    });

    it("orders results by timestamp descending", async () => {
        const conditions = combineConditions(commandCondition({ service }));
        const rows = await queryLogs(conditions, 100);

        const messages = rows.map((r) => r.message);
        expect(messages.indexOf("q-newest")).toBeLessThan(messages.indexOf("q-middle"));
        expect(messages.indexOf("q-middle")).toBeLessThan(messages.indexOf("q-oldest"));
    });

    it("respects the limit", async () => {
        const conditions = combineConditions(commandCondition({ service }));
        const rows = await queryLogs(conditions, 1);
        expect(rows).toHaveLength(1);
        expect(rows[0].message).toBe("q-newest");
    });

    it("filters by level via commandCondition", async () => {
        const conditions = combineConditions(commandCondition({ service, level: "warn" }));
        const rows = await queryLogs(conditions, 100);
        expect(rows.map((r) => r.message)).toEqual(["q-middle"]);
    });

    it("filters by substring match on message", async () => {
        const conditions = combineConditions(commandCondition({ service, q: "MIDDLE" })); // case-insensitive
        const rows = await queryLogs(conditions, 100);
        expect(rows.map((r) => r.message)).toEqual(["q-middle"]);
    });

    it("filters by since/until range", async () => {
        const conditions = combineConditions(
            commandCondition({ service, since: new Date(now.getTime() - 1500).toISOString() })
        );
        const rows = await queryLogs(conditions, 100);
        expect(rows.map((r) => r.message).sort()).toEqual(["q-middle", "q-newest"].sort());
    });

    it("filters by attribute containment", async () => {
        await insertLogs([entry(service, { message: "q-attr", attributes: { user_id: "999" } })]);
        const conditions = combineConditions(commandCondition({ service, attr: { user_id: "999" } }));
        const rows = await queryLogs(conditions, 100);
        expect(rows.map((r) => r.message)).toEqual(["q-attr"]);
    });

    it("returns nothing for a non-matching filter", async () => {
        const conditions = combineConditions(commandCondition({ service, level: "debug" }));
        const rows = await queryLogs(conditions, 100);
        expect(rows).toHaveLength(0);
    });
});

describe("aggregateLogs", () => {
    const service = uniqueService("aggregate");
    afterAll(() => deleteService(service));

    const bucketMinute = new Date(now.getTime());
    bucketMinute.setUTCSeconds(0, 0);

    beforeAll(async () => {
        await insertLogs([
            entry(service, { message: "agg-1", level: "error", timestamp: bucketMinute.toISOString() }),
            entry(service, { message: "agg-2", level: "error", timestamp: new Date(bucketMinute.getTime() + 5000).toISOString() }),
            entry(service, { message: "agg-3", level: "warn", timestamp: new Date(bucketMinute.getTime() + 10000).toISOString() }),
        ]);
    });

    it("counts rows per bucket with no grouping", async () => {
        const conditions = combineConditions(commandCondition({ service }));
        const rows = await aggregateLogs(conditions, "1 minute", null);

        expect(rows).toHaveLength(1);
        expect(rows[0].group).toBeNull();
        expect(rows[0].count).toBe(3);
    });

    it("groups by level within each bucket", async () => {
        const conditions = combineConditions(commandCondition({ service }));
        const rows = await aggregateLogs(conditions, "1 minute", "level");

        const byGroup = Object.fromEntries(rows.map((r) => [r.group, r.count]));
        expect(byGroup).toEqual({ error: 2, warn: 1 });
    });

    it("returns an ISO timestamp string for the bucket start, floored to the bucket boundary", async () => {
        const conditions = combineConditions(commandCondition({ service }));
        const [row] = await aggregateLogs(conditions, "1 minute", null);
        expect(() => new Date(row.start).toISOString()).not.toThrow();
        expect(new Date(row.start).getUTCSeconds()).toBe(0);
    });

    it("returns nothing for a range with no matching rows", async () => {
        const conditions = combineConditions(
            commandCondition({ service, until: new Date(bucketMinute.getTime() - 60_000).toISOString() })
        );
        const rows = await aggregateLogs(conditions, "1 minute", null);
        expect(rows).toHaveLength(0);
    });
});

describe("upsertHourlyCounts / aggregateFromRollup", () => {
    const service = uniqueService("rollup");
    afterAll(() => deleteService(service));

    const hour = new Date(now.getTime());
    hour.setUTCMinutes(0, 0, 0);
    const since = hour;
    const until = new Date(hour.getTime() + 60 * 60 * 1000);

    it("increments (not overwrites) count across repeated calls for the same hour/service/level", async () => {
        await upsertHourlyCounts([
            { timestamp: hour.toISOString(), level: "error", service, message: "m" },
            { timestamp: hour.toISOString(), level: "error", service, message: "m" },
        ]);
        await upsertHourlyCounts([
            { timestamp: new Date(hour.getTime() + 5000).toISOString(), level: "error", service, message: "m" },
        ]);

        const rows = await aggregateFromRollup({ service, since, until }, "1h", null);
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(3);
    });

    it("matches aggregateLogs's result for the same data, filters, and bucket", async () => {
        const rollupService = uniqueService("rollup-parity");
        const entries: ValidatedLog[] = [
            { timestamp: hour.toISOString(), level: "error", service: rollupService, message: "m1" },
            { timestamp: new Date(hour.getTime() + 1000).toISOString(), level: "error", service: rollupService, message: "m2" },
            { timestamp: new Date(hour.getTime() + 2000).toISOString(), level: "warn", service: rollupService, message: "m3" },
        ];
        await insertLogs(entries);
        await upsertHourlyCounts(entries);

        const liveRows = await aggregateLogs(
            combineConditions(commandCondition({ service: rollupService, since, until })),
            "1 hour",
            "level"
        );
        const rollupRows = await aggregateFromRollup({ service: rollupService, since, until }, "1h", "level");

        const byGroupLive = Object.fromEntries(liveRows.map((r) => [r.group, r.count]));
        const byGroupRollup = Object.fromEntries(rollupRows.map((r) => [r.group, r.count]));
        expect(byGroupRollup).toEqual(byGroupLive);
        expect(byGroupRollup).toEqual({ error: 2, warn: 1 });

        await deleteService(rollupService);
    });

    it("re-buckets to 1d by summing across the day's hours", async () => {
        const dayService = uniqueService("rollup-1d");
        const dayStart = new Date(hour.getTime());
        dayStart.setUTCHours(0, 0, 0, 0);

        await upsertHourlyCounts([
            { timestamp: dayStart.toISOString(), level: "info", service: dayService, message: "m" },
            { timestamp: new Date(dayStart.getTime() + 3 * 60 * 60 * 1000).toISOString(), level: "info", service: dayService, message: "m" },
        ]);

        const rows = await aggregateFromRollup(
            { service: dayService, since: dayStart, until: new Date(dayStart.getTime() + 24 * 60 * 60 * 1000) },
            "1d",
            null
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(2);

        await deleteService(dayService);
    });

    it("filters by level", async () => {
        const rows = await aggregateFromRollup({ service, level: "debug", since, until }, "1h", null);
        expect(rows).toHaveLength(0);
    });
});

describe("upsertMinuteCounts / aggregateFromMinuteRollup", () => {
    const service = uniqueService("minute-rollup");
    afterAll(() => deleteService(service));

    const minute = new Date(now.getTime());
    minute.setUTCSeconds(0, 0);
    const since = minute;
    const until = new Date(minute.getTime() + 60 * 1000);

    it("increments (not overwrites) count across repeated calls for the same minute/service/level", async () => {
        await upsertMinuteCounts([
            { timestamp: minute.toISOString(), level: "error", service, message: "m" },
            { timestamp: minute.toISOString(), level: "error", service, message: "m" },
        ]);
        await upsertMinuteCounts([
            { timestamp: new Date(minute.getTime() + 5000).toISOString(), level: "error", service, message: "m" },
        ]);

        const rows = await aggregateFromMinuteRollup({ service, since, until }, "1m", null);
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(3);
    });

    it("matches aggregateLogs's result for the same data, filters, and bucket", async () => {
        const rollupService = uniqueService("minute-rollup-parity");
        const entries: ValidatedLog[] = [
            { timestamp: minute.toISOString(), level: "error", service: rollupService, message: "m1" },
            { timestamp: new Date(minute.getTime() + 1000).toISOString(), level: "error", service: rollupService, message: "m2" },
            { timestamp: new Date(minute.getTime() + 2000).toISOString(), level: "warn", service: rollupService, message: "m3" },
        ];
        await insertLogs(entries);
        await upsertMinuteCounts(entries);

        const liveRows = await aggregateLogs(
            combineConditions(commandCondition({ service: rollupService, since, until })),
            "1 minute",
            "level"
        );
        const rollupRows = await aggregateFromMinuteRollup({ service: rollupService, since, until }, "1m", "level");

        const byGroupLive = Object.fromEntries(liveRows.map((r) => [r.group, r.count]));
        const byGroupRollup = Object.fromEntries(rollupRows.map((r) => [r.group, r.count]));
        expect(byGroupRollup).toEqual(byGroupLive);
        expect(byGroupRollup).toEqual({ error: 2, warn: 1 });

        await deleteService(rollupService);
    });

    it("re-buckets to 5m by summing across five one-minute buckets", async () => {
        const fiveMinService = uniqueService("minute-rollup-5m");
        const windowStart = new Date(minute.getTime());
        windowStart.setUTCMinutes(Math.floor(windowStart.getUTCMinutes() / 5) * 5, 0, 0);

        await upsertMinuteCounts([
            { timestamp: windowStart.toISOString(), level: "info", service: fiveMinService, message: "m" },
            { timestamp: new Date(windowStart.getTime() + 3 * 60 * 1000).toISOString(), level: "info", service: fiveMinService, message: "m" },
        ]);

        const rows = await aggregateFromMinuteRollup(
            { service: fiveMinService, since: windowStart, until: new Date(windowStart.getTime() + 5 * 60 * 1000) },
            "5m",
            null
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(2);

        await deleteService(fiveMinService);
    });

    it("filters by level", async () => {
        const rows = await aggregateFromMinuteRollup({ service, level: "debug", since, until }, "1m", null);
        expect(rows).toHaveLength(0);
    });
});

describe("deadLetterEntries / listDeadLetters / deleteDeadLetter", () => {
    const createdIds: string[] = [];
    afterEach(async () => {
        for (const id of createdIds.splice(0)) await deleteDeadLetter(id);
    });

    async function findByService(svc: string) {
        const rows = await listDeadLetters(1000);
        return rows.find((r) => r.entries.some((e) => e.service === svc));
    }

    it("stores entries with the given reason, retrievable via listDeadLetters", async () => {
        const service = uniqueService("deadletter");
        await deadLetterEntries([entry(service, { message: "dl-1" })], "simulated failure");

        const row = await findByService(service);
        expect(row).toBeTruthy();
        expect(row!.reason).toBe("simulated failure");
        expect(row!.entries).toEqual([expect.objectContaining({ service, message: "dl-1" })]);
        createdIds.push(row!.id);
    });

    it("stores the whole batch as one row, not one row per entry", async () => {
        const service = uniqueService("deadletter-batch");
        await deadLetterEntries(
            [entry(service, { message: "dl-a" }), entry(service, { message: "dl-b" })],
            "simulated batch failure"
        );

        const row = await findByService(service);
        expect(row!.entries).toHaveLength(2);
        createdIds.push(row!.id);
    });

    it("is a no-op for an empty entries array", async () => {
        const before = (await listDeadLetters(1000)).length;
        await deadLetterEntries([], "should not be stored");
        const after = (await listDeadLetters(1000)).length;
        expect(after).toBe(before);
    });

    it("deleteDeadLetter removes the row", async () => {
        const service = uniqueService("deadletter-delete");
        await deadLetterEntries([entry(service)], "to be deleted");
        const row = await findByService(service);
        expect(row).toBeTruthy();

        await deleteDeadLetter(row!.id);

        expect(await findByService(service)).toBeUndefined();
    });
});
