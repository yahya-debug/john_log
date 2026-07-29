import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import qs from "qs";
import request from "supertest";

vi.mock("../../../../src/query/aggregateQuery.js", () => ({ runAggregate: vi.fn() }));

import { runAggregate } from "../../../../src/query/aggregateQuery.js";
import aggregateRouter from "../../../../src/http/routes/aggregate.js";

const mockedRunAggregate = vi.mocked(runAggregate);

function buildApp() {
    const app = express();
    app.set("query parser", (str: string) => qs.parse(str, { allowDots: true }));
    app.use("/logs/aggregate", aggregateRouter);
    return app;
}

const validQuery = { since: "2026-07-20T14:00:00Z", until: "2026-07-20T15:00:00Z", bucket: "1m" };

beforeEach(() => {
    mockedRunAggregate.mockReset();
});

describe("GET /logs/aggregate", () => {
    it("200s and returns whatever runAggregate produces", async () => {
        mockedRunAggregate.mockResolvedValue({ buckets: [{ start: "2026-07-20T14:00:00Z", group: null, count: 5 }] });
        const res = await request(buildApp()).get("/logs/aggregate").query(validQuery);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ buckets: [{ start: "2026-07-20T14:00:00Z", group: null, count: 5 }] });
    });

    it("400s before reaching runAggregate when bucket is missing", async () => {
        const res = await request(buildApp())
            .get("/logs/aggregate")
            .query({ since: validQuery.since, until: validQuery.until });

        expect(res.status).toBe(400);
        expect(mockedRunAggregate).not.toHaveBeenCalled();
    });

    it("400s when since/until are missing", async () => {
        const res = await request(buildApp()).get("/logs/aggregate").query({ bucket: "1m" });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: "for logs/aggregate, since & until timestamps are required " });
    });

    it("400s on an invalid group_by", async () => {
        const res = await request(buildApp())
            .get("/logs/aggregate")
            .query({ ...validQuery, group_by: "message" });

        expect(res.status).toBe(400);
        expect(mockedRunAggregate).not.toHaveBeenCalled();
    });

    it("passes group_by and filters straight through to runAggregate", async () => {
        mockedRunAggregate.mockResolvedValue({ buckets: [] });
        await request(buildApp())
            .get("/logs/aggregate")
            .query({ ...validQuery, group_by: "service", service: "checkout" });

        const [query] = mockedRunAggregate.mock.calls[0]!;
        expect(query).toMatchObject({ group_by: "service", service: "checkout", bucket: "1m" });
    });
});
