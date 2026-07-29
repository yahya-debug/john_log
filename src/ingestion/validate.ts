import { Env } from "../config.js";
import { isLevel, Log, premitives, RejectedLog, ValidatedLog } from "../types/log.js";

// types of validateEntry outputs
type ValidationRes = {
    valid: boolean;
    data: ValidatedLog;
}
type RejectionRes = {
    valid: boolean;
    reason: string;
}
type ValidateOpts = {
    // lets the admin backfill endpoint accept timestamps older than the
    // retention window — normal ingestion never does
    allowStale?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function isStale(timestamp: string | Date): boolean {
    return new Date(timestamp).getTime() < Date.now() - Env.RETENTION_DAYS * DAY_MS;
}

export function validateEntry(entry: any, opts: ValidateOpts = {}): ValidationRes | RejectionRes {
    if (typeof entry != "object" || entry === null)
        return { valid: false, reason: "entry must be an object" }

    const { timestamp, level, service, message, attributes } = entry;

    // check timestamp is parsable
    const parsedTime: Date = new Date(timestamp);
    if (typeof timestamp !== 'string' || isNaN(parsedTime.getTime()))
        return { valid: false, reason: "invalid timestamp" };
    if (parsedTime.getTime() > Date.now() + 5*60*1000)
        return { valid: false, reason: "timestamp is more than 5 minutes in the future" };
    if (!opts.allowStale && isStale(timestamp))
        return { valid: false, reason: `timestamp is older than the retention window (${Env.RETENTION_DAYS} days)` };

    if (!isLevel(level))
        return { valid: false, reason: `Invalid level: ${level}` };

    if (typeof service !== 'string' || service.trim().length == 0)
        return { valid: false, reason: "service should be a notNull string" }
    if (typeof message !== 'string' || message.trim().length == 0)
        return { valid: false, reason: "message should be a notNull string" }


    
    const normalized_attr: Record<string, string> = {};
    if (attributes != undefined) {
        if (typeof attributes != 'object' || attributes == null || Array.isArray(attributes))
            return { valid: false, reason: "attributes must be a flat object" }

        for (const [key, val] of Object.entries(attributes)) {
            if (!premitives.includes((typeof val) as string))
                return { valid: false, reason: "attributes must be a flat object" }
            
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
    }
}

export function validateBatch(logs: unknown[], opts: ValidateOpts = {}): {
    accepted: ValidatedLog[];
    rejected: RejectedLog[];
} {
    const accepted: ValidatedLog[] = [];
    const rejected: RejectedLog[] = [];

    logs.forEach((log, index) => {
        const res = validateEntry(log, opts);

        if (res.valid)
            accepted.push((res as ValidationRes).data);
        else
            rejected.push({ index, reason: (res as RejectionRes).reason });
    })

    return { accepted, rejected };
}