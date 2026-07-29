import { describe, expect, it, vi } from "vitest";
import { validateQueryParams, validateAggregateParams } from "../../../src/query/validate.js";
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

    it("accepts a limit above 1000 here — capping is runQuery's job, not validation's", () => {
        const next = vi.fn();
        validateQueryParams(mockReq({ limit: "5000" }), mockRes(), next);
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
});
