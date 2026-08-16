import { describe, expect, it, vi } from "vitest";
import { validateQueryParams, validateAggregateParams } from "../../../src/query/validate.js";
import { encodeCursor } from "../../../src/query/cursor.js";
import type { Request, Response } from "express";

function mockReq(query: Record<string, unknown>): Request {
    return { query } as unknown as Request;
}

function mockRes(): Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
    const res: any = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
}

describe("validateQueryParams", () => {
    it("calls next() with no query params at all", () => {
        const next = vi.fn();
        validateQueryParams(mockReq({}), mockRes(), next);
        expect(next).toHaveBeenCalledOnce();
    });

    it("calls next() when since/until/level/limit are all valid", () => {
        const next = vi.fn();
        const res = mockRes();
        validateQueryParams(
            mockReq({ since: "2026-07-20T14:00:00Z", until: "2026-07-20T15:00:00Z", level: "error", limit: "50" }),
            res,
            next
        );
        expect(next).toHaveBeenCalledOnce();
        expect(res.status).not.toHaveBeenCalled();
    });

    it("400s on an unparseable since timestamp", () => {
        const res = mockRes();
        const next = vi.fn();
        validateQueryParams(mockReq({ since: "not-a-date" }), res, next);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "invalid since timestamp" });
        expect(next).not.toHaveBeenCalled();
    });

    it("400s on an unparseable until timestamp given alone", () => {
        const res = mockRes();
        validateQueryParams(mockReq({ until: "not-a-date" }), res, vi.fn());
        expect(res.json).toHaveBeenCalledWith({ error: "invalid until timestamp" });
    });

    it("400s when until is before since", () => {
        const res = mockRes();
        validateQueryParams(
            mockReq({ since: "2026-07-20T15:00:00Z", until: "2026-07-20T14:00:00Z" }),
            res,
            vi.fn()
        );
        expect(res.json).toHaveBeenCalledWith({ error: "until must not be before since" });
    });

    it("400s on an unknown level", () => {
        const res = mockRes();
        validateQueryParams(mockReq({ level: "critical" }), res, vi.fn());
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "unknown level" });
    });

    it.each(["0", "-1", "abc", "1.5"])("400s on a non-positive-integer limit (%s)", (limit) => {
        const res = mockRes();
        validateQueryParams(mockReq({ limit }), res, vi.fn());
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "limit must be a positive integer" });
    });

    it("400s on a limit above the 1000 max", () => {
        const res = mockRes();
        validateQueryParams(mockReq({ limit: "5000" }), res, vi.fn());
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "limit must not exceed 1000" });
    });

    it("accepts a limit of exactly 1000", () => {
        const next = vi.fn();
        validateQueryParams(mockReq({ limit: "1000" }), mockRes(), next);
        expect(next).toHaveBeenCalledOnce();
    });

    it("calls next() when cursor is a validly-encoded cursor", () => {
        const next = vi.fn();
        const cursor = encodeCursor({ timestamp: "2026-07-20T14:00:00Z", id: "abc-123" });
        validateQueryParams(mockReq({ cursor }), mockRes(), next);
        expect(next).toHaveBeenCalledOnce();
    });

    it.each([
        "not-valid-base64!!!",
        Buffer.from("not json", "utf-8").toString("base64"),
        Buffer.from(JSON.stringify({ timestamp: "2026-07-20T14:00:00Z" }), "utf-8").toString("base64"), // missing id
        Buffer.from(JSON.stringify({ id: "abc" }), "utf-8").toString("base64"), // missing timestamp
        Buffer.from(JSON.stringify({ timestamp: "not-a-date", id: "abc" }), "utf-8").toString("base64"),
        Buffer.from(JSON.stringify(null), "utf-8").toString("base64"),
    ])("400s on an invalid or malformed cursor (%s)", (cursor) => {
        const res = mockRes();
        validateQueryParams(mockReq({ cursor }), res, vi.fn());
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "invalid or malformed cursor" });
    });

    // A repeated query param (?q=a&q=b) parses via qs into an array, not a string —
    // commandCondition (filters.ts) would otherwise call .toLowerCase() on it and
    // throw an unhandled 500. Catch it here instead.
    it("400s when q is repeated (parses to an array)", () => {
        const res = mockRes();
        validateQueryParams(mockReq({ q: ["a", "b"] }), res, vi.fn());
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "q must be a single string value" });
    });

    it("400s when service is repeated (parses to an array)", () => {
        const res = mockRes();
        validateQueryParams(mockReq({ service: ["a", "b"] }), res, vi.fn());
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "service must be a single string value" });
    });

    it("400s when an attr.<key> value is repeated (parses to an array)", () => {
        const res = mockRes();
        validateQueryParams(mockReq({ attr: { user_id: ["1", "2"] } }), res, vi.fn());
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "attr.<key> filters must each be a single string value" });
    });

    it("calls next() when q/service/attr are normal single strings", () => {
        const next = vi.fn();
        validateQueryParams(mockReq({ q: "declined", service: "checkout", attr: { user_id: "42" } }), mockRes(), next);
        expect(next).toHaveBeenCalledOnce();
    });
});

describe("validateAggregateParams", () => {
    const validBase = {
        since: "2026-07-20T14:00:00Z",
        until: "2026-07-20T15:00:00Z",
        bucket: "1m",
    };

    it("calls next() when since/until/bucket are valid and level/group_by are omitted", () => {
        const next = vi.fn();
        validateAggregateParams(mockReq(validBase), mockRes(), next);
        expect(next).toHaveBeenCalledOnce();
    });

    it.each(["service", "level"])("accepts group_by=%s", (group_by) => {
        const next = vi.fn();
        validateAggregateParams(mockReq({ ...validBase, group_by }), mockRes(), next);
        expect(next).toHaveBeenCalledOnce();
    });

    it("400s on an invalid bucket size", () => {
        const res = mockRes();
        validateAggregateParams(mockReq({ ...validBase, bucket: "30s" }), res, vi.fn());
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "invalid bucket size" });
    });

    it("400s when since is missing", () => {
        const res = mockRes();
        validateAggregateParams(mockReq({ until: validBase.until, bucket: "1m" }), res, vi.fn());
        expect(res.json).toHaveBeenCalledWith({ error: "for logs/aggregate, since & until timestamps are required " });
    });

    it("400s when until is missing", () => {
        const res = mockRes();
        validateAggregateParams(mockReq({ since: validBase.since, bucket: "1m" }), res, vi.fn());
        expect(res.json).toHaveBeenCalledWith({ error: "for logs/aggregate, since & until timestamps are required " });
    });

    it("400s on an invalid group_by", () => {
        const res = mockRes();
        validateAggregateParams(mockReq({ ...validBase, group_by: "message" }), res, vi.fn());
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "group_by must be 'service' or 'level'" });
    });

    it("400s on an unknown level", () => {
        const res = mockRes();
        validateAggregateParams(mockReq({ ...validBase, level: "critical" }), res, vi.fn());
        expect(res.json).toHaveBeenCalledWith({ error: "unknown level" });
    });

    it("checks bucket size before requiring since/until", () => {
        // bucket is checked first in the implementation; pin that ordering down
        // since it changes which error message a caller sees for a doubly-invalid request
        const res = mockRes();
        validateAggregateParams(mockReq({ bucket: "30s" }), res, vi.fn());
        expect(res.json).toHaveBeenCalledWith({ error: "invalid bucket size" });
    });

    it("400s when q is repeated (parses to an array)", () => {
        const res = mockRes();
        validateAggregateParams(mockReq({ ...validBase, q: ["a", "b"] }), res, vi.fn());
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: "q must be a single string value" });
    });
});
