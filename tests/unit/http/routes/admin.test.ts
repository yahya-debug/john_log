import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import http from "node:http";
import { EventEmitter } from "node:events";

vi.mock("../../../../src/db/logs.js", () => ({
    insertLogs: vi.fn(),
    upsertHourlyCounts: vi.fn(),
    listDeadLetters: vi.fn(),
    deleteDeadLetter: vi.fn(),
}));
vi.mock("../../../../src/retention/partitions.js", () => ({ backfillPartitionForDate: vi.fn() }));
vi.mock("../../../../src/db/stats.js", () => ({ getStats: vi.fn() }));
vi.mock("../../../../src/db/db.js", () => ({ db: { $client: { begin: vi.fn() } } }));
vi.mock("../../../../src/ingestion/writeBuffer.js", () => ({ tailEmitter: new EventEmitter() }));

import { insertLogs, upsertHourlyCounts, listDeadLetters, deleteDeadLetter } from "../../../../src/db/logs.js";
import { backfillPartitionForDate } from "../../../../src/retention/partitions.js";
import { getStats } from "../../../../src/db/stats.js";
import { db } from "../../../../src/db/db.js";
import { tailEmitter } from "../../../../src/ingestion/writeBuffer.js";
import adminRouter from "../../../../src/http/routes/admin.js";
import { malformedJSON } from "../../../../src/http/middleware/errorHandlers.js";
import { Env } from "../../../../src/config.js";

const mockedInsertLogs = vi.mocked(insertLogs);
const mockedUpsertHourlyCounts = vi.mocked(upsertHourlyCounts);
const mockedBackfill = vi.mocked(backfillPartitionForDate);
const mockedGetStats = vi.mocked(getStats);
const mockedListDeadLetters = vi.mocked(listDeadLetters);
const mockedDeleteDeadLetter = vi.mocked(deleteDeadLetter);
const mockedBegin = vi.mocked(db.$client.begin);

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
    mockedUpsertHourlyCounts.mockReset();
    mockedBackfill.mockReset();
    mockedBackfill.mockResolvedValue({ partition: "logs_x", moved: 0 });
    mockedGetStats.mockReset();
    mockedListDeadLetters.mockReset();
    mockedDeleteDeadLetter.mockReset().mockResolvedValue(undefined);
    mockedBegin.mockReset().mockImplementation((cb: any) => cb({}));
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
        expect(mockedUpsertHourlyCounts).toHaveBeenCalledOnce();
    });

    it("discards (doesn't insert) an entry older than the retention window, without calling backfill for it", async () => {
        const res = await request(buildApp())
            .post("/admin/logs/backfill")
            .send({ logs: [{ timestamp: staleTimestamp(), level: "info", service: "checkout", message: "too old" }] });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ accepted: 0, discarded: 1, rejected: [] });
        expect(mockedBackfill).not.toHaveBeenCalled();
        expect(mockedInsertLogs).not.toHaveBeenCalled();
        expect(mockedUpsertHourlyCounts).not.toHaveBeenCalled();
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

describe("GET /admin/dead-letter", () => {
    it("200s with whatever listDeadLetters produces", async () => {
        const rows = [{ id: "1", failedAt: new Date().toISOString(), reason: "boom", entries: [] }];
        mockedListDeadLetters.mockResolvedValue(rows as any);

        const res = await request(buildApp()).get("/admin/dead-letter");

        expect(res.status).toBe(200);
        expect(res.body).toEqual(rows);
    });
});

describe("POST /admin/dead-letter/replay", () => {
    const row = (id: string) => ({
        id,
        failedAt: new Date().toISOString(),
        reason: "boom",
        entries: [{ timestamp: new Date().toISOString(), level: "info", service: "a", message: "m", attributes: {} }],
    });

    it("replays every queued row, deleting each on success", async () => {
        mockedListDeadLetters.mockResolvedValue([row("1"), row("2")] as any);
        mockedInsertLogs.mockResolvedValue(undefined as any);
        mockedUpsertHourlyCounts.mockResolvedValue(undefined as any);

        const res = await request(buildApp()).post("/admin/dead-letter/replay");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ replayed: 2, stillFailed: 0 });
        expect(mockedDeleteDeadLetter).toHaveBeenCalledWith("1");
        expect(mockedDeleteDeadLetter).toHaveBeenCalledWith("2");
        expect(mockedInsertLogs).toHaveBeenCalledTimes(2);
        expect(mockedUpsertHourlyCounts).toHaveBeenCalledTimes(2);
    });

    it("leaves a row queued (doesn't delete it) if replay fails again, and keeps processing the rest", async () => {
        mockedListDeadLetters.mockResolvedValue([row("fails"), row("succeeds")] as any);
        mockedInsertLogs
            .mockRejectedValueOnce(new Error("still broken"))
            .mockResolvedValueOnce(undefined as any);
        mockedUpsertHourlyCounts.mockResolvedValue(undefined as any);

        const res = await request(buildApp()).post("/admin/dead-letter/replay");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ replayed: 1, stillFailed: 1 });
        expect(mockedDeleteDeadLetter).not.toHaveBeenCalledWith("fails");
        expect(mockedDeleteDeadLetter).toHaveBeenCalledWith("succeeds");
    });

    it("200s with all-zero counts when the queue is empty", async () => {
        mockedListDeadLetters.mockResolvedValue([]);

        const res = await request(buildApp()).post("/admin/dead-letter/replay");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ replayed: 0, stillFailed: 0 });
        expect(mockedInsertLogs).not.toHaveBeenCalled();
    });
});

describe("GET /admin/logs/tail", () => {
    it("400s on an invalid level filter, without touching tailEmitter", async () => {
        const listenersBefore = tailEmitter.listenerCount("flushed");

        const res = await request(buildApp()).get("/admin/logs/tail").query({ level: "bogus" });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/level/i);
        expect(tailEmitter.listenerCount("flushed")).toBe(listenersBefore);
    });

    // supertest buffers the whole response and only resolves once it ends, which
    // an SSE stream never does on its own — so this opens a real listening server
    // and reads the response as it streams, the same way an actual EventSource
    // client would.
    function openTailStream(path: string): Promise<{ req: http.ClientRequest; server: http.Server; lines: () => string }> {
        return new Promise((resolve, reject) => {
            const server = buildApp().listen(0, () => {
                const port = (server.address() as any).port;
                let body = "";
                const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
                    res.on("data", (chunk) => { body += chunk.toString(); });
                    res.on("error", reject);
                });
                req.on("error", reject);
                // give the connection a beat to actually reach the route handler
                setTimeout(() => resolve({ req, server, lines: () => body }), 50);
            });
        });
    }

    it("streams a matching flushed entry as an SSE data line, filtered by service", async () => {
        const { req, server, lines } = await openTailStream("/admin/logs/tail?service=svc-a");

        tailEmitter.emit("flushed", [
            { timestamp: "2026-01-01T00:00:00.000Z", level: "info", service: "svc-a", message: "matches", attributes: {} },
            { timestamp: "2026-01-01T00:00:00.000Z", level: "info", service: "svc-b", message: "should not appear", attributes: {} },
        ]);
        await new Promise((r) => setTimeout(r, 50));

        req.destroy();
        server.close();
        await new Promise((r) => setTimeout(r, 50)); // let the "close" cleanup (tailEmitter.off) settle before the next test

        expect(lines()).toContain('data: {"timestamp":"2026-01-01T00:00:00.000Z","level":"info","service":"svc-a","message":"matches","attributes":{}}');
        expect(lines()).not.toContain("should not appear");
    });

    it("removes its tailEmitter listener once the client disconnects", async () => {
        const before = tailEmitter.listenerCount("flushed");
        const { req, server } = await openTailStream("/admin/logs/tail");

        expect(tailEmitter.listenerCount("flushed")).toBe(before + 1);

        req.destroy();
        server.close();
        await new Promise((r) => setTimeout(r, 50));

        expect(tailEmitter.listenerCount("flushed")).toBe(before);
    });
});
