import { sql } from "drizzle-orm";
import { bigint, check, jsonb, PgTable, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { Level, ValidatedLog } from "../types/log.js";

export const logs = pgTable('logs', {
    id: uuid('id').notNull().defaultRandom(),
    timestamp: timestamp('timestamp', {  withTimezone: true }).notNull(),
    level: text('level').$type<Level>().notNull(),
    service: text('service').notNull(),
    message: text('message').notNull(),
    // GENERATED ALWAYS AS ... STORED: Postgres computes and stores this itself on every
    // insert, so writeBuffer.ts's raw UNNEST insert doesn't need to know it exists. Exists
    // so q=<substring> (still case-insensitive per the API contract) can compare against an
    // already-lowercased column with plain LIKE instead of ILIKE — ILIKE case-folds `message`
    // on every row of every scan, every request; this pays that cost once, at write time,
    // instead of on every read. Doesn't change the query's cost class (still a sequential
    // scan on the un-indexed hot partition — see migration 0001 for why no index is built
    // there), only the per-row constant — measured in README's Measured performance results.
    messageLower: text('message_lower').notNull().generatedAlwaysAs(sql`lower(message)`),
    attributes: jsonb('attributes').$type<Record<string, number | string | boolean>>().notNull().default({})
}, (table) => [check('level_check', sql`${table.level} IN ('debug', 'info', 'warn', 'error')`)]);

// Pre-aggregated counts at hour granularity, keyed by (hour, service, level). Exists so
// GET /logs/aggregate?bucket=1h|1d, when no attr./q filters are present (see
// query/aggregateQuery.ts's routing), reads O(hours in range) rows from here instead of
// O(rows in range) from `logs` — see docs/ingestion-bottleneck.md for the measured
// failure this fixes: a 30-day/1h-bucket query scanning a today-partition swollen by
// sustained ingestion. Maintained incrementally by every write path (writeBuffer.ts,
// the admin backfill route, and a one-time recompute in loadtest/seed.ts, which bypasses
// the write buffer). Deliberately doesn't track message/attributes: those have unbounded
// value spaces that can't be pre-aggregated this way, so `q=`/`attr.*` filtered
// aggregates always fall back to the live scan over `logs`.
export const logsHourlyCounts = pgTable('logs_hourly_counts', {
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    service: text('service').notNull(),
    level: text('level').$type<Level>().notNull(),
    count: bigint('count', { mode: 'number' }).notNull().default(0),
}, (table) => [primaryKey({ columns: [table.hour, table.service, table.level] })]);

// Dead-letter storage for write-buffer flush failures (src/ingestion/writeBuffer.ts) —
// stretch goal, see README's Optional features. Stores the raw entries as-is (jsonb, no
// schema validation against them) precisely because the point is to never lose a batch
// that already failed once; a strict typed insert here could itself fail on the same
// class of problem it exists to survive. Deliberately still Postgres, not a local file
// or separate store — the brief requires Postgres to remain the source of truth for
// both reads and writes, so this only helps when Postgres itself is reachable via this
// separate, simpler insert even though the main flush transaction failed; if Postgres is
// fully unreachable, this insert fails too and the batch is still lost (logged, not
// silently — see writeBuffer.ts).
export const logsDeadLetter = pgTable('logs_dead_letter', {
    id: uuid('id').notNull().defaultRandom(),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason').notNull(),
    entries: jsonb('entries').$type<ValidatedLog[]>().notNull(),
}, (table) => [primaryKey({ columns: [table.id] })]);

