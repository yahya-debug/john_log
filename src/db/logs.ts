import { desc, SQL } from "drizzle-orm";
import { ValidatedLog } from "../types/log.js";
import { db } from "./db.js";
import { logs } from "./schema.js";

export async function insertLogs(entries: ValidatedLog[]) {
    return await db.insert(logs).values(entries.map((entry) => ({
        timestamp: new Date(entry.timestamp),
        level: entry.level,
        service: entry.service,
        message: entry.message,
        attributes: entry.attributes
    }))).returning();
}

export async function queryLogs(conditions: SQL | undefined, limit: number) {
    return await db.select().from(logs).where(conditions).orderBy(desc(logs.timestamp), desc(logs.id)).limit(limit);
}