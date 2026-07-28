import { NextFunction, Request, Response } from "express";
import { isLevel } from "../types/log.js";
import { isBucketSize } from "../types/QueryParams.js";

function isValidGroupBy(group_by: unknown): boolean {
    return group_by === undefined || group_by === 'service' || group_by === 'level';
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
    }

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

    next();
}