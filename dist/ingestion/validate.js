import { Env } from "../config.js";
import { isLevel, premitives } from "../types/log.js";
const DAY_MS = 24 * 60 * 60 * 1000;
export function isStale(timestamp) {
    return new Date(timestamp).getTime() < Date.now() - Env.RETENTION_DAYS * DAY_MS;
}
export function validateEntry(entry, opts = {}) {
    if (typeof entry != "object" || entry === null)
        return { valid: false, reason: "entry must be an object" };
    const { timestamp, level, service, message, attributes } = entry;
    // check timestamp is parsable
    const parsedTime = new Date(timestamp);
    if (typeof timestamp !== 'string' || isNaN(parsedTime.getTime()))
        return { valid: false, reason: "invalid timestamp" };
    if (parsedTime.getTime() > Date.now() + 5 * 60 * 1000)
        return { valid: false, reason: "timestamp is more than 5 minutes in the future" };
    // Inlined rather than calling isStale(timestamp): isStale takes a string
    // and re-parses it with its own `new Date(...)`, which would be a second
    // Date construction for a value already parsed two lines up as parsedTime.
    // Redundant Date parsing across the ingestion path was a real, measured
    // contributor to GC pressure under load (see insertLogs in db/logs.ts).
    // isStale itself is kept as-is for its other caller (admin.ts's backfill
    // route), which doesn't have a pre-parsed Date lying around.
    if (!opts.allowStale && parsedTime.getTime() < Date.now() - Env.RETENTION_DAYS * DAY_MS)
        return { valid: false, reason: `timestamp is older than the retention window (${Env.RETENTION_DAYS} days)` };
    if (!isLevel(level))
        return { valid: false, reason: `Invalid level: ${level}` };
    if (typeof service !== 'string' || service.trim().length == 0)
        return { valid: false, reason: "service should be a notNull string" };
    if (typeof message !== 'string' || message.trim().length == 0)
        return { valid: false, reason: "message should be a notNull string" };
    const normalized_attr = {};
    if (attributes != undefined) {
        if (typeof attributes != 'object' || attributes == null || Array.isArray(attributes))
            return { valid: false, reason: "attributes must be a flat object" };
        for (const [key, val] of Object.entries(attributes)) {
            if (!premitives.includes((typeof val)))
                return { valid: false, reason: "attributes must be a flat object" };
            normalized_attr[key] = String(val);
        }
    }
    return {
        valid: true,
        data: {
            timestamp,
            level,
            service,
            message,
            attributes: normalized_attr
        }
    };
}
export function validateBatch(logs, opts = {}) {
    const accepted = [];
    const rejected = [];
    logs.forEach((log, index) => {
        const res = validateEntry(log, opts);
        if (res.valid)
            accepted.push(res.data);
        else
            rejected.push({ index, reason: res.reason });
    });
    return { accepted, rejected };
}
