import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { aggregateLogs, insertLogs, queryLogs } from "../../../src/db/logs.js";
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

    it("inserts entries and returns the generated rows, including server-assigned ids", async () => {
        const rows = await insertLogs([entry(service, { message: "insert-1" })]);

        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBeTruthy();
        expect(rows[0].service).toBe(service);
        expect(rows[0].message).toBe("insert-1");
    });

    it("inserts a whole batch in one call", async () => {
        const rows = await insertLogs([
            entry(service, { message: "batch-1" }),
            entry(service, { message: "batch-2" }),
            entry(service, { message: "batch-3" }),
        ]);
        expect(rows).toHaveLength(3);
    });

    it("stores attributes as provided", async () => {
        const [row] = await insertLogs([
            entry(service, { message: "attrs", attributes: { user_id: "42", region: "eu-west" } }),
        ]);
        expect(row.attributes).toEqual({ user_id: "42", region: "eu-west" });
    });

    it("defaults attributes to {} at the DB level when omitted entirely", async () => {
        const [row] = await insertLogs([
            { timestamp: now.toISOString(), level: "info", service, message: "no-attrs" } as ValidatedLog,
        ]);
        expect(row.attributes).toEqual({});
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
