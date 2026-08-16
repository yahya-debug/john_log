import { NextFunction, Request, Response } from "express";
import { isLevel } from "../types/log.js";
import { isBucketSize, MAX_LIMIT } from "../types/QueryParams.js";
import { decodeCursor } from "./cursor.js";

function isValidCursor(cursor: unknown): boolean {
    if (typeof cursor !== 'string') return false;

    try {
        const decoded = decodeCursor(cursor);
        return typeof decoded === 'object' && decoded !== null
            && typeof decoded.id === 'string' && decoded.id.length > 0
            && !isNaN(new Date(decoded.timestamp).getTime());
    } catch {
        return false;
    }
}

function isValidGroupBy(group_by: unknown): boolean {
    return group_by === undefined || group_by === 'service' || group_by === 'level';
}

// A repeated query param (e.g. ?q=a&q=b, or ?attr.user_id=1&attr.user_id=2) parses
// via qs into an array instead of a string — level/cursor/bucket/group_by all happen
// to reject that safely already (typeof checks, or Date coercion producing NaN), but
// service/q/attr.<key> went straight into commandCondition (filters.ts) unguarded:
// query.q.toLowerCase() on an array throws (500, unhandled), and an array/object
// value interpolated as a SQL parameter for service silently matches nothing instead
// of filtering or erroring. Reject all three the same way the other params already
// are, rather than let a malformed request 500 or silently return wrong results.
function invalidStringFilterParam(query: Request["query"]): string | null {
    if ("service" in query && typeof query.service !== 'string')
        return "service must be a single string value";
    if ("q" in query && typeof query.q !== 'string')
        return "q must be a single string value";
    if ("attr" in query) {
        const attr = query.attr;
        if (typeof attr !== 'object' || attr === null || Array.isArray(attr))
            return "attr.<key> filters must each be a single string value";
        for (const key in attr as Record<string, unknown>)
            if (typeof (attr as Record<string, unknown>)[key] !== 'string')
                return "attr.<key> filters must each be a single string value";
    }
    return null;
}

function validateTimeRange(query: Request["query"]): string | null {
    if ("since" in query) {
        const since_date = new Date(query.since as string);
        if (isNaN(since_date.getTime()))
            return "invalid since timestamp";

        if ("until" in query) {
            const until_date = new Date(query.until as string);
            if (isNaN(until_date.getTime()))
                return "invalid until timestamp";
            if (until_date < since_date)
                return "until must not be before since";
        }
    } else if ("until" in query) {
        const until_date = new Date(query.until as string);
        if (isNaN(until_date.getTime()))
            return "invalid until timestamp";
    }

    return null;
}

export function validateQueryParams(req: Request, res: Response, next: NextFunction) {
    const { query } = req;

    const timeRangeError = validateTimeRange(query);
    if (timeRangeError)
        return res.status(400).json({ error: timeRangeError })

    if ("level" in query && !isLevel(query.level))
        return res.status(400).json({ error: "unknown level" })

    if ("limit" in query) {
        const limit = Number(query.limit);
        if (isNaN(limit) || !Number.isInteger(limit) || limit <= 0)
            return res.status(400).json({ error: "limit must be a positive integer" })
        if (limit > MAX_LIMIT)
            return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` })
    }

    if ("cursor" in query && !isValidCursor(query.cursor))
        return res.status(400).json({ error: "invalid or malformed cursor" })

    const filterError = invalidStringFilterParam(query);
    if (filterError)
        return res.status(400).json({ error: filterError })

    next();
}

export function validateAggregateParams(req: Request, res: Response, next: NextFunction) {
    const { query } = req;

    if (!isBucketSize(query.bucket as string))
        return res.status(400).json({ error: "invalid bucket size" });

    if (!query.since || !query.until)
        return res.status(400).json({ error: "for logs/aggregate, since & until timestamps are required " });

    const timeRangeError = validateTimeRange(query);
    if (timeRangeError)
        return res.status(400).json({ error: timeRangeError })

    if ("level" in query && !isLevel(query.level))
        return res.status(400).json({ error: "unknown level" });

    if (!isValidGroupBy(query.group_by))
        return res.status(400).json({ error: "group_by must be 'service' or 'level'" });

    const filterError = invalidStringFilterParam(query);
    if (filterError)
        return res.status(400).json({ error: filterError })

    next();
}