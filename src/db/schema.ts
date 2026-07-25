import { sql } from "drizzle-orm";
import { check, jsonb, PgTable, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const logs = pgTable('logs', {
    id: uuid('id').notNull().defaultRandom(),
    timestamp: timestamp('timestamp', {  withTimezone: true }).notNull(),
    level: text('level').notNull(),
    service: text('service').notNull(),
    message: text('message').notNull(),
    attr: jsonb('attributes').notNull().default({})
}, (table) => [check('level_check', sql`${table.level} IN ('debug', 'info', 'warn', 'error')`)]);

