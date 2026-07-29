import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../../../src/db/logs.js", () => ({ insertLogs: vi.fn() }));
vi.mock("../../../../src/retention/partitions.js", () => ({ backfillPartitionForDate: vi.fn() }));
vi.mock("../../../../src/db/stats.js", () => ({ getStats: vi.fn() }));

import { insertLogs } from "../../../../src/db/logs.js";
import { backfillPartitionForDate } from "../../../../src/retention/partitions.js";
import { getStats } from "../../../../src/db/stats.js";
import adminRouter from "../../../../src/http/routes/admin.js";
import { malformedJSON } from "../../../../src/http/middleware/errorHandlers.js";
import { Env } from "../../../../src/config.js";

const mockedInsertLogs = vi.mocked(insertLogs);
const mockedBackfill = vi.mocked(backfillPartitionForDate);
const mockedGetStats = vi.mocked(getStats);

const DAY_MS = 24 * 60 * 60 * 1000;
const staleTimestamp = () => new Date(Date.now() - (Env.RETENTION_DAYS + 5) * DAY_MS).toISOString();
const freshOldTimestamp = () => new Date(Date.now() - (Env.RETENTION_DAYS - 5) * DAY_MS).toISOString(); // old, but within window

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/admin", adminRouter);
    app.use(malformedJSON);
    return app;
}

beforeEach(() => {
    mockedInsertLogs.mockReset();
    mockedBackfill.mockReset();
    mockedBackfill.mockResolvedValue({ partition: "logs_x", moved: 0 });
    mockedGetStats.mockReset();
});

describe("GET /admin/stats", () => {
    it("200s with whatever getStats produces", async () => {
        const stats = {
            totals: { rows: 5, by_level: { info: 5 }, by_service: { checkout: 5 } },
            partitions: [{ name: "logs_default", bound: "DEFAULT", rows_estimate: 0, size_bytes: 0 }],
            time_range: { oldest: "2026-07-20T00:00:00.000Z", newest: "2026-07-21T00:00:00.000Z" },
            ingestion_rate: { last_1m: 0, last_5m: 0, per_second_1m: 0 },
            retention_config: { retention_days: 30, partition_lookahead_days: 7, retention_cron: "10 0 * * *" },
            database_size_bytes: 0,
        };
        mockedGetStats.mockResolvedValue(stats as any);

        const res = await request(buildApp()).get("/admin/stats");

        expect(res.status).toBe(200);
        expect(res.body).toEqual(stats);
    });
});

describe("POST /admin/logs/backfill", () => {
    it("backfills a partition and inserts an entry that's old but still within the retention window", async () => {
        mockedInsertLogs.mockResolvedValue([]);
        const timestamp = freshOldTimestamp();

        const res = await request(buildApp())
            .post("/admin/logs/backfill")
            .send({ logs: [{ timestamp, level: "info", service: "checkout", message: "backfilled" }] });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ accepted: 1, discarded: 0, rejected: [] });
        expect(mockedBackfill).toHaveBeenCalledWith(new Date(timestamp.slice(0, 10)));
        expect(mockedInsertLogs).toHaveBeenCalledOnce();
    });

    it("discards (doesn't insert) an entry older than the retention window, without calling backfill for it", async () => {
        const res = await request(buildApp())
            .post("/admin/logs/backfill")
            .send({ logs: [{ timestamp: staleTimestamp(), level: "info", service: "checkout", message: "too old" }] });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ accepted: 0, discarded: 1, rejected: [] });
        expect(mockedBackfill).not.toHaveBeenCalled();
        expect(mockedInsertLogs).not.toHaveBeenCalled();
    });

    it("still rejects entries that fail basic validation (e.g. bad level), even though allowStale is set", async () => {
        const res = await request(buildApp())
            .post("/admin/logs/backfill")
            .send({ logs: [{ timestamp: staleTimestamp(), level: "critical", service: "checkout", message: "m" }] });

        expect(res.status).toBe(400);
        expect(res.body.rejected).toEqual([{ index: 0, reason: expect.stringMatching(/level/i) }]);
        expect(mockedInsertLogs).not.toHaveBeenCalled();
    });

    it("still rejects a future timestamp", async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const res = await request(buildApp())
            .post("/admin/logs/backfill")
            .send({ logs: [{ timestamp: future, level: "info", service: "checkout", message: "m" }] });

        expect(res.status).toBe(400);
        expect(res.body.rejected).toEqual([{ index: 0, reason: expect.stringMatching(/future/i) }]);
    });

    it("calls backfillPartitionForDate once per distinct date, not once per entry", async () => {
        mockedInsertLogs.mockResolvedValue([]);
        const day1 = freshOldTimestamp();
        const day2 = new Date(new Date(day1).getTime() - 2 * DAY_MS).toISOString();

        const res = await request(buildApp())
            .post("/admin/logs/backfill")
            .send({
                logs: [
                    { timestamp: day1, level: "info", service: "a", message: "1" },
                    { timestamp: day1, level: "info", service: "a", message: "2" }, // same day as entry 1
                    { timestamp: day2, level: "info", service: "a", message: "3" },
                ],
            });

        expect(res.status).toBe(200);
        expect(res.body.accepted).toBe(3);
        expect(mockedBackfill).toHaveBeenCalledTimes(2);
    });

    it("400s on malformed JSON", async () => {
        const res = await request(buildApp())
            .post("/admin/logs/backfill")
            .set("content-type", "application/json")
            .send("{not valid json");

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Malformed JSON");
    });
});
