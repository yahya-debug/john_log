import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { App } from "../../../src/http/app.js";
import { _isReady } from "../../../src/db/migrate.js";
import { flushNow } from "../../../src/ingestion/writeBuffer.js";
import { deadLetterEntries, deleteDeadLetter } from "../../../src/db/logs.js";
import type { ValidatedLog } from "../../../src/types/log.js";
import { uniqueService, deleteService } from "../helpers.js";

const service = uniqueService("http-app");
let app: ReturnType<typeof App>;

beforeAll(async () => {
    app = App();
    // /health itself is registered in src/index.ts, not App() — mirror it
    // here rather than importing index.ts, which app.listen()s as a side
    // effect of being imported.
    app.get("/health", async (_req, res) => {
        if (await _isReady()) return res.status(200).send("healthy");
        res.status(503).json({ status: "not ready" });
    });
    await _isReady(); // App() kicks off migrations async; make sure they've settled before we hit routes
});

afterAll(() => deleteService(service));

describe("GET /health", () => {
    it("200s once migrations have run", async () => {
        const res = await request(app).get("/health");
        expect(res.status).toBe(200);
    });
});

describe("POST /logs -> GET /logs round trip", () => {
    const now = Date.now();

    it("ingests a mixed batch, accepting good entries and reporting bad ones by index", async () => {
        const res = await request(app)
            .post("/logs")
            .send({
                logs: [
                    { timestamp: new Date(now).toISOString(), level: "error", service, message: "payment declined", attributes: { user_id: "42", region: "eu-west" } },
                    { timestamp: new Date(now - 1000).toISOString(), level: "warn", service, message: "retrying upstream" },
                    { timestamp: new Date(now).toISOString(), level: "critical", service, message: "bad level" },
                    { timestamp: "not-a-date", level: "info", service, message: "bad timestamp" },
                ],
            });

        expect(res.status).toBe(200);
        expect(res.body.accepted).toBe(2);
        expect(res.body.rejected).toEqual([
            { index: 2, reason: expect.stringMatching(/level/i) },
            { index: 3, reason: expect.stringMatching(/timestamp/i) },
        ]);

        // POST /logs now only buffers accepted entries (src/ingestion/writeBuffer.ts)
        // rather than inserting synchronously, so later tests in this describe
        // block that query for this data need it flushed first.
        await flushNow();
    });

    it("400s a batch that's entirely invalid, without inserting anything", async () => {
        const res = await request(app)
            .post("/logs")
            .send({ logs: [{ timestamp: new Date().toISOString(), level: "nope", service, message: "m" }] });

        expect(res.status).toBe(400);
        expect(res.body.accepted).toBe(0);
    });

    it("finds the ingested entry via an exact service+level match", async () => {
        const res = await request(app).get("/logs").query({ service, level: "error" });

        expect(res.status).toBe(200);
        expect(res.body.logs).toHaveLength(1);
        expect(res.body.logs[0].message).toBe("payment declined");
    });

    it("finds the ingested entry via case-insensitive substring search on message", async () => {
        const res = await request(app).get("/logs").query({ service, q: "DECLINED" });
        expect(res.body.logs.map((l: any) => l.message)).toEqual(["payment declined"]);
    });

    it("finds the ingested entry via attr.<key> containment", async () => {
        const res = await request(app).get("/logs").query({ "attr.user_id": "42" });
        const forThisService = res.body.logs.filter((l: any) => l.service === service);
        expect(forThisService).toHaveLength(1);
        expect(forThisService[0].attributes.user_id).toBe("42");
    });

    it("orders results by timestamp descending", async () => {
        const res = await request(app).get("/logs").query({ service });
        const timestamps = res.body.logs.map((l: any) => l.timestamp);
        const sorted = [...timestamps].sort((a, b) => (a < b ? 1 : -1));
        expect(timestamps).toEqual(sorted);
    });

    it("400s on an unknown level filter", async () => {
        const res = await request(app).get("/logs").query({ level: "critical" });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: "unknown level" });
    });

    it("400s when until is before since", async () => {
        const res = await request(app)
            .get("/logs")
            .query({ since: "2026-07-20T15:00:00Z", until: "2026-07-20T14:00:00Z" });
        expect(res.status).toBe(400);
    });
});

describe("cursor pagination", () => {
    const service2 = uniqueService("http-cursor");
    afterAll(() => deleteService(service2));

    beforeAll(async () => {
        const base = Date.now();
        const logs = Array.from({ length: 5 }, (_, i) => ({
            timestamp: new Date(base - i * 1000).toISOString(),
            level: "info",
            service: service2,
            message: `page-entry-${i}`,
        }));
        const res = await request(app).post("/logs").send({ logs });
        expect(res.body.accepted).toBe(5);
        await flushNow();
    });

    it("walks every page via next_cursor and eventually terminates with null, seeing every row exactly once", async () => {
        const seen = new Set<string>();
        let cursor: string | undefined;

        for (let page = 0; page < 10; page++) {
            const res = await request(app)
                .get("/logs")
                .query({ service: service2, limit: 2, ...(cursor ? { cursor } : {}) });

            expect(res.status).toBe(200);
            for (const row of res.body.logs) {
                expect(seen.has(row.id)).toBe(false); // no duplicates across pages
                seen.add(row.id);
            }

            if (res.body.next_cursor === null) {
                expect(seen.size).toBe(5);
                return;
            }
            cursor = res.body.next_cursor;
        }

        throw new Error("pagination did not terminate within 10 pages");
    });
});

describe("GET /logs/aggregate", () => {
    const service3 = uniqueService("http-aggregate");
    afterAll(() => deleteService(service3));

    const bucketMinute = new Date();
    bucketMinute.setUTCSeconds(0, 0);

    beforeAll(async () => {
        await request(app)
            .post("/logs")
            .send({
                logs: [
                    { timestamp: bucketMinute.toISOString(), level: "error", service: service3, message: "a" },
                    { timestamp: new Date(bucketMinute.getTime() + 5000).toISOString(), level: "error", service: service3, message: "b" },
                    { timestamp: new Date(bucketMinute.getTime() + 10000).toISOString(), level: "warn", service: service3, message: "c" },
                ],
            });
        await flushNow();
    });

    it("returns bucketed counts over the requested range", async () => {
        const res = await request(app).get("/logs/aggregate").query({
            service: service3,
            since: bucketMinute.toISOString(),
            until: new Date(bucketMinute.getTime() + 60_000).toISOString(),
            bucket: "1m",
        });

        expect(res.status).toBe(200);
        expect(res.body.buckets).toHaveLength(1);
        expect(res.body.buckets[0]).toMatchObject({ group: null, count: 3 });
    });

    it("groups by level when group_by=level is given", async () => {
        const res = await request(app).get("/logs/aggregate").query({
            service: service3,
            since: bucketMinute.toISOString(),
            until: new Date(bucketMinute.getTime() + 60_000).toISOString(),
            bucket: "1m",
            group_by: "level",
        });

        const byGroup = Object.fromEntries(res.body.buckets.map((b: any) => [b.group, b.count]));
        expect(byGroup).toEqual({ error: 2, warn: 1 });
    });

    it("400s when bucket is missing", async () => {
        const res = await request(app)
            .get("/logs/aggregate")
            .query({ since: bucketMinute.toISOString(), until: new Date().toISOString() });
        expect(res.status).toBe(400);
    });

    it("400s when since/until are missing", async () => {
        const res = await request(app).get("/logs/aggregate").query({ bucket: "1m" });
        expect(res.status).toBe(400);
    });
});

describe("GET /admin/stats", () => {
    it("200s with totals, partitions, time range, ingestion rate and retention config all present", async () => {
        const res = await request(app).get("/admin/stats");

        expect(res.status).toBe(200);
        expect(res.body.totals.rows).toBeGreaterThan(0);
        expect(res.body.totals.by_level).toBeTypeOf("object");
        expect(res.body.totals.by_service).toBeTypeOf("object");
        expect(Array.isArray(res.body.partitions)).toBe(true);
        expect(res.body.partitions.map((p: any) => p.name)).toContain("logs_default");
        expect(res.body.time_range.oldest).toBeTruthy();
        expect(res.body.ingestion_rate.last_5m).toBeGreaterThanOrEqual(0);
        expect(res.body.retention_config.retention_days).toBeGreaterThan(0);
        expect(typeof res.body.database_size_bytes).toBe("number");
    });
});

describe("GET/POST /admin/dead-letter", () => {
    it("lists a dead-lettered batch and replays it successfully, removing it from the queue", async () => {
        const svc = uniqueService("dead-letter-replay");
        const entry: ValidatedLog = { timestamp: new Date().toISOString(), level: "error", service: svc, message: "m", attributes: {} };
        await deadLetterEntries([entry], "simulated failure for test");

        const listed = await request(app).get("/admin/dead-letter");
        expect(listed.status).toBe(200);
        const row = listed.body.find((r: any) => r.entries.some((e: any) => e.service === svc));
        expect(row).toBeTruthy();

        const replayed = await request(app).post("/admin/dead-letter/replay");
        expect(replayed.status).toBe(200);
        expect(replayed.body.replayed).toBeGreaterThanOrEqual(1);

        const listedAfter = await request(app).get("/admin/dead-letter");
        expect(listedAfter.body.find((r: any) => r.id === row.id)).toBeUndefined();

        const queried = await request(app).get("/logs").query({ service: svc });
        expect(queried.body.logs).toHaveLength(1);

        await deleteService(svc);
    });

    it("leaves a batch queued (not deleted) if replay fails again", async () => {
        const svc = uniqueService("dead-letter-stillfail");
        // level violates the `logs` table's CHECK constraint, so re-insertion via
        // replay genuinely fails, the same way the original failure would have.
        const badEntry = { timestamp: new Date().toISOString(), level: "not-a-real-level", service: svc, message: "m", attributes: {} } as unknown as ValidatedLog;
        await deadLetterEntries([badEntry], "simulated failure for test");

        const replayed = await request(app).post("/admin/dead-letter/replay");
        expect(replayed.status).toBe(200);
        expect(replayed.body.stillFailed).toBeGreaterThanOrEqual(1);

        const listedAfter = await request(app).get("/admin/dead-letter");
        const row = listedAfter.body.find((r: any) => r.entries.some((e: any) => e.service === svc));
        expect(row).toBeTruthy();

        await deleteDeadLetter(row.id);
    });
});
