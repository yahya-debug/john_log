import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import qs from "qs";
import request from "supertest";

// Route-level tests mock at the DB/query-orchestration boundary so they
// exercise real HTTP wiring (body parsing, validation middleware, response
// shaping) without needing a live Postgres connection.
vi.mock("../../../../src/db/logs.js", () => ({ insertLogs: vi.fn() }));
vi.mock("../../../../src/query/logsQuery.js", () => ({ runQuery: vi.fn() }));

import { insertLogs } from "../../../../src/db/logs.js";
import { runQuery } from "../../../../src/query/logsQuery.js";
import logsRouter from "../../../../src/http/routes/logs.js";
import { malformedJSON } from "../../../../src/http/middleware/errorHandlers.js";

const mockedInsertLogs = vi.mocked(insertLogs);
const mockedRunQuery = vi.mocked(runQuery);

function buildApp() {
    const app = express();
    // mirrors src/http/app.ts's query parser so attr.<key>= actually nests
    app.set("query parser", (str: string) => qs.parse(str, { allowDots: true }));
    app.use(express.json());
    app.use("/logs", logsRouter);
    app.use(malformedJSON);
    return app;
}

const validEntry = {
    timestamp: "2026-07-20T14:32:01.123Z",
    level: "error",
    service: "checkout",
    message: "payment declined",
};

beforeEach(() => {
    mockedInsertLogs.mockReset();
    mockedRunQuery.mockReset();
});

describe("POST /logs", () => {
    it("200s and inserts when every entry is valid", async () => {
        mockedInsertLogs.mockResolvedValue([]);
        const res = await request(buildApp()).post("/logs").send({ logs: [validEntry] });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ accepted: 1, rejected: [] });
        expect(mockedInsertLogs).toHaveBeenCalledWith([
            { ...validEntry, attributes: {} },
        ]);
    });

    it("200s with a mixed batch, reporting rejected entries by index without failing the whole batch", async () => {
        mockedInsertLogs.mockResolvedValue([]);
        const res = await request(buildApp())
            .post("/logs")
            .send({ logs: [validEntry, { ...validEntry, level: "critical" }] });

        expect(res.status).toBe(200);
        expect(res.body.accepted).toBe(1);
        expect(res.body.rejected).toEqual([{ index: 1, reason: expect.any(String) }]);
        expect(mockedInsertLogs).toHaveBeenCalledOnce();
    });

    it("400s and does not touch the DB when every entry is rejected", async () => {
        const res = await request(buildApp())
            .post("/logs")
            .send({ logs: [{ ...validEntry, level: "critical" }] });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ accepted: 0, rejected: [{ index: 0, reason: expect.any(String) }] });
        expect(mockedInsertLogs).not.toHaveBeenCalled();
    });

    it("400s on malformed JSON in the request body", async () => {
        const res = await request(buildApp())
            .post("/logs")
            .set("content-type", "application/json")
            .send("{not valid json");

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Malformed JSON");
        expect(mockedInsertLogs).not.toHaveBeenCalled();
    });
});

describe("GET /logs", () => {
    it("200s and returns whatever runQuery produces", async () => {
        mockedRunQuery.mockResolvedValue({ logs: [], next_cursor: null });
        const res = await request(buildApp()).get("/logs");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ logs: [], next_cursor: null });
    });

    it("400s before reaching runQuery when query params fail validation", async () => {
        const res = await request(buildApp()).get("/logs").query({ level: "critical" });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: "unknown level" });
        expect(mockedRunQuery).not.toHaveBeenCalled();
    });

    it("parses attr.<key> query params into a nested attr object via the qs parser", async () => {
        mockedRunQuery.mockResolvedValue({ logs: [], next_cursor: null });
        await request(buildApp()).get("/logs?attr.user_id=42&attr.region=eu-west");

        const [query] = mockedRunQuery.mock.calls[0]!;
        expect((query as any).attr).toEqual({ user_id: "42", region: "eu-west" });
    });

    it("passes since/until/service/level/q/limit/cursor straight through to runQuery", async () => {
        mockedRunQuery.mockResolvedValue({ logs: [], next_cursor: null });
        await request(buildApp())
            .get("/logs")
            .query({ service: "checkout", level: "error", q: "declined", limit: "10" });

        const [query] = mockedRunQuery.mock.calls[0]!;
        expect(query).toMatchObject({ service: "checkout", level: "error", q: "declined", limit: "10" });
    });
});
