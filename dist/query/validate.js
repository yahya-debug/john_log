import { isLevel } from "../types/log.js";
import { isBucketSize, MAX_LIMIT } from "../types/QueryParams.js";
import { decodeCursor } from "./cursor.js";
function isValidCursor(cursor) {
    if (typeof cursor !== 'string')
        return false;
    try {
        const decoded = decodeCursor(cursor);
        return typeof decoded === 'object' && decoded !== null
            && typeof decoded.id === 'string' && decoded.id.length > 0
            && !isNaN(new Date(decoded.timestamp).getTime());
    }
    catch {
        return false;
    }
}
function isValidGroupBy(group_by) {
    return group_by === undefined || group_by === 'service' || group_by === 'level';
}
function validateTimeRange(query) {
    if ("since" in query) {
        const since_date = new Date(query.since);
        if (isNaN(since_date.getTime()))
            return "invalid since timestamp";
        if ("until" in query) {
            const until_date = new Date(query.until);
            if (isNaN(until_date.getTime()))
                return "invalid until timestamp";
            if (until_date < since_date)
                return "until must not be before since";
        }
    }
    else if ("until" in query) {
        const until_date = new Date(query.until);
        if (isNaN(until_date.getTime()))
            return "invalid until timestamp";
    }
    return null;
}
export function validateQueryParams(req, res, next) {
    const { query } = req;
    const timeRangeError = validateTimeRange(query);
    if (timeRangeError)
        return res.status(400).json({ error: timeRangeError });
    if ("level" in query && !isLevel(query.level))
        return res.status(400).json({ error: "unknown level" });
    if ("limit" in query) {
        const limit = Number(query.limit);
        if (isNaN(limit) || !Number.isInteger(limit) || limit <= 0)
            return res.status(400).json({ error: "limit must be a positive integer" });
        if (limit > MAX_LIMIT)
            return res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
    }
    if ("cursor" in query && !isValidCursor(query.cursor))
        return res.status(400).json({ error: "invalid or malformed cursor" });
    next();
}
export function validateAggregateParams(req, res, next) {
    const { query } = req;
    if (!isBucketSize(query.bucket))
        return res.status(400).json({ error: "invalid bucket size" });
    if (!query.since || !query.until)
        return res.status(400).json({ error: "for logs/aggregate, since & until timestamps are required " });
    const timeRangeError = validateTimeRange(query);
    if (timeRangeError)
        return res.status(400).json({ error: timeRangeError });
    if ("level" in query && !isLevel(query.level))
        return res.status(400).json({ error: "unknown level" });
    if (!isValidGroupBy(query.group_by))
        return res.status(400).json({ error: "group_by must be 'service' or 'level'" });
    next();
}
