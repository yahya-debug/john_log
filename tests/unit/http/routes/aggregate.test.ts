import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import qs from "qs";
import request from "supertest";

vi.mock("../../../../src/query/aggregateQuery.js", () => ({ runAggregate: vi.fn() }));
vi.mock("../../../../src/config.js", () => ({ Env: { AGGREGATE_Q_MAX_CONCURRENT: Infinity } }));

import { runAggregate } from "../../../../src/query/aggregateQuery.js";
import { Env } from "../../../../src/config.js";
import aggregateRouter from "../../../../src/http/routes/aggregate.js";

const mockedRunAggregate = vi.mocked(runAggregate);

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

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

// q=-filtered aggregates fall back to a sequential scan on today's un-indexed
// partition (see README's Known limitations) — expensive enough that unbounded
// concurrency degrades every concurrent aggregate query together. This backpressure
// gate is off by default (AGGREGATE_Q_MAX_CONCURRENT === Infinity, see src/config.ts)
// and only sheds load when explicitly configured.
describe("GET /logs/aggregate?q=... backpressure (AGGREGATE_Q_MAX_CONCURRENT)", () => {
    afterEach(() => {
        Env.AGGREGATE_Q_MAX_CONCURRENT = Infinity; // don't leak into other tests/files
    });

    // supertest's request objects are lazy thenables — they don't actually dispatch
    // until something awaits/`.then()`s them. `.then(res => res)` forces dispatch
    // right away while still handing back a normal promise to await later, which is
    // what these tests need to hold a request genuinely "in flight".
    function start(req: request.Test) {
        return req.then((res) => res);
    }

    it("never sheds load when unset (default Infinity), no matter how many q= requests overlap", async () => {
        const a = deferred<{ buckets: [] }>();
        const b = deferred<{ buckets: [] }>();
        mockedRunAggregate.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

        const reqA = start(request(buildApp()).get("/logs/aggregate").query({ ...validQuery, q: "declined" }));
        const reqB = start(request(buildApp()).get("/logs/aggregate").query({ ...validQuery, q: "declined" }));
        await new Promise((r) => setTimeout(r, 20)); // let both handlers actually start

        a.resolve({ buckets: [] });
        b.resolve({ buckets: [] });
        const [resA, resB] = await Promise.all([reqA, reqB]);

        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);
    });

    it("sheds an over-the-limit concurrent q= request with 429 + Retry-After", async () => {
        Env.AGGREGATE_Q_MAX_CONCURRENT = 1;
        const a = deferred<{ buckets: [] }>();
        mockedRunAggregate.mockReturnValueOnce(a.promise);

        const reqA = start(request(buildApp()).get("/logs/aggregate").query({ ...validQuery, q: "declined" }));
        await new Promise((r) => setTimeout(r, 20)); // let reqA's handler start and increment the counter

        const resB = await request(buildApp()).get("/logs/aggregate").query({ ...validQuery, q: "declined" });
        expect(resB.status).toBe(429);
        expect(resB.headers["retry-after"]).toBeDefined();
        expect(resB.body.error).toBeTruthy();
        expect(mockedRunAggregate).toHaveBeenCalledTimes(1); // B never even called runAggregate

        a.resolve({ buckets: [] });
        const resA = await reqA;
        expect(resA.status).toBe(200);
    });

    it("admits a new q= request once an in-flight one completes and frees its slot", async () => {
        Env.AGGREGATE_Q_MAX_CONCURRENT = 1;
        const a = deferred<{ buckets: [] }>();
        mockedRunAggregate.mockReturnValueOnce(a.promise);

        const reqA = start(request(buildApp()).get("/logs/aggregate").query({ ...validQuery, q: "declined" }));
        await new Promise((r) => setTimeout(r, 20));

        a.resolve({ buckets: [] });
        expect((await reqA).status).toBe(200);

        mockedRunAggregate.mockResolvedValueOnce({ buckets: [] });
        const resC = await request(buildApp()).get("/logs/aggregate").query({ ...validQuery, q: "declined" });
        expect(resC.status).toBe(200);
    });

    it("never gates a non-q= aggregate request, even while q= requests are in flight and over the limit", async () => {
        Env.AGGREGATE_Q_MAX_CONCURRENT = 1;
        const a = deferred<{ buckets: [] }>();
        mockedRunAggregate.mockReturnValueOnce(a.promise);

        const reqA = start(request(buildApp()).get("/logs/aggregate").query({ ...validQuery, q: "declined" }));
        await new Promise((r) => setTimeout(r, 20));

        mockedRunAggregate.mockResolvedValueOnce({ buckets: [] });
        const resPlain = await request(buildApp()).get("/logs/aggregate").query(validQuery); // no q=
        expect(resPlain.status).toBe(200);

        a.resolve({ buckets: [] });
        await reqA;
    });

    it("releases its slot even if runAggregate rejects, so the next request isn't stuck shed", async () => {
        Env.AGGREGATE_Q_MAX_CONCURRENT = 1;
        mockedRunAggregate.mockRejectedValueOnce(new Error("db exploded"));

        const resA = await request(buildApp()).get("/logs/aggregate").query({ ...validQuery, q: "declined" });
        expect(resA.status).toBe(500); // no error handler mounted in this test app; the point is it didn't hang the slot

        mockedRunAggregate.mockResolvedValueOnce({ buckets: [] });
        const resB = await request(buildApp()).get("/logs/aggregate").query({ ...validQuery, q: "declined" });
        expect(resB.status).toBe(200);
    });
});
