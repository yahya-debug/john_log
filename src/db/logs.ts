import { ValidatedLog } from "../types/log.js";
import { db } from "./db.js";
import { logs } from "./schema.js";

export async function insertLogs(entries: ValidatedLog[]) {
    await db.insert(logs).values(entries.map((entry) => ({
        timestamp: new Date(entry.timestamp),
        level: entry.level,
        service: entry.service,
        message: entry.message,
        attributes: entry.attributes
    })));
}