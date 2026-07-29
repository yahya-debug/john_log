import { sql } from "drizzle-orm";
import { db } from "./db.js";
import { Env } from "../config.js";

export interface PartitionStat {
    name: string;
    bound: string | null;
    // estimated, not exact — see getStats()
    rows_estimate: number;
    size_bytes: number;
}

export interface Stats {
    totals: {
        rows: number;
        by_level: Record<string, number>;
        by_service: Record<string, number>;
    };
    partitions: PartitionStat[];
    time_range: { oldest: string | null; newest: string | null };
    ingestion_rate: { last_1m: number; last_5m: number; per_second_1m: number };
    retention_config: {
        retention_days: number;
        partition_lookahead_days: number;
        retention_cron: string;
    };
    database_size_bytes: number;
}

// pg_total_relation_size on the parent returns 0 — partitioned tables hold no
// storage themselves, everything lives in the child partitions — so size is
// computed per-partition and summed, not asked of `logs` directly.
//
// Per-partition row counts come from pg_stat_user_tables.n_live_tup (a
// planner estimate autovacuum/autoanalyze keeps up to date), not a real
// COUNT(*). An earlier version ran `(SELECT count(*) FROM logs WHERE
// tableoid = c.oid)` per partition — since tableoid isn't the partition key,
// Postgres can't prune on it, so every one of those correlated subqueries
// scanned *all* partitions rather than just its own: N partitions meant N
// full table scans (measured at ~3.2s on this repo's ~2M-row dev table).
// n_live_tup answers instantly from the catalog instead — the standard
// tradeoff monitoring tools make for exactly this reason. totals.rows below
// stays exact regardless, since it's summed from the by_level/by_service
// GROUP BYs, which already scan the real data.
export async function getStats(): Promise<Stats> {
    const [partitionRows, levelRows, serviceRows, rangeRows, rateRows] = await Promise.all([
        db.execute<{ name: string; bound: string | null; rows_estimate: number; size_bytes: number }>(sql`
            SELECT
                c.relname AS name,
                pg_get_expr(c.relpartbound, c.oid) AS bound,
                COALESCE(s.n_live_tup, 0)::int AS rows_estimate,
                pg_total_relation_size(c.oid)::float8 AS size_bytes
            FROM pg_inherits i
            JOIN pg_class c ON i.inhrelid = c.oid
            JOIN pg_class p ON i.inhparent = p.oid
            LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
            WHERE p.relname = 'logs'
            ORDER BY c.relname
        `),
        db.execute<{ level: string; count: number }>(
            sql`SELECT level, count(*)::int AS count FROM logs GROUP BY level`
        ),
        db.execute<{ service: string; count: number }>(
            sql`SELECT service, count(*)::int AS count FROM logs GROUP BY service ORDER BY count(*) DESC`
        ),
        db.execute<{ oldest: string | null; newest: string | null }>(
            sql`SELECT min(timestamp) AS oldest, max(timestamp) AS newest FROM logs`
        ),
        // the outer WHERE isn't redundant with the FILTER below even though
        // it's the same bound as last_5m — it's what lets Postgres prune to
        // ~today's partition instead of scanning every partition to compute
        // a FILTER'd aggregate over the whole table
        db.execute<{ last_1m: number; last_5m: number }>(sql`
            SELECT
                count(*) FILTER (WHERE timestamp >= now() - interval '1 minute')::int AS last_1m,
                count(*)::int AS last_5m
            FROM logs
            WHERE timestamp >= now() - interval '5 minutes'
        `),
    ]);

    const partitions: PartitionStat[] = partitionRows.map((r) => ({
        name: r.name,
        bound: r.bound,
        rows_estimate: r.rows_estimate,
        size_bytes: r.size_bytes,
    }));

    const by_level: Record<string, number> = {};
    for (const r of levelRows) by_level[r.level] = r.count;

    const by_service: Record<string, number> = {};
    for (const r of serviceRows) by_service[r.service] = r.count;

    const rate = rateRows[0] ?? { last_1m: 0, last_5m: 0 };

    return {
        totals: {
            // exact, unlike partitions[].rows_estimate — this is a sum of the
            // by_level GROUP BY, which already scans the real data
            rows: Object.values(by_level).reduce((sum, n) => sum + n, 0),
            by_level,
            by_service,
        },
        partitions,
        time_range: { oldest: rangeRows[0]?.oldest ?? null, newest: rangeRows[0]?.newest ?? null },
        ingestion_rate: {
            last_1m: rate.last_1m,
            last_5m: rate.last_5m,
            per_second_1m: Math.round((rate.last_1m / 60) * 100) / 100,
        },
        retention_config: {
            retention_days: Env.RETENTION_DAYS,
            partition_lookahead_days: Env.PARTITION_LOOKAHEAD_DAYS,
            retention_cron: Env.RETENTION_CRON,
        },
        database_size_bytes: partitions.reduce((sum, p) => sum + p.size_bytes, 0),
    };
}
