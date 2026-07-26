import { sql } from "drizzle-orm";
import { check, jsonb, PgTable, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { Level } from "../types/log.js";

export const logs = pgTable('logs', {
    id: uuid('id').notNull().defaultRandom(),
    timestamp: timestamp('timestamp', {  withTimezone: true }).notNull(),
    level: text('level').$type<Level>().notNull(),
    service: text('service').notNull(),
    message: text('message').notNull(),
    attributes: jsonb('attributes').$type<Record<string, number | string | boolean>>().notNull().default({})
}, (table) => [check('level_check', sql`${table.level} IN ('debug', 'info', 'warn', 'error')`)]);

