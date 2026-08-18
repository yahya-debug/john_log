import { sql } from "drizzle-orm";
import { db } from "../db/db.js";

const PARTITION_PREFIX = "logs_";
const DATE_SUFFIX = /^\d{4}_\d{2}_\d{2}$/;

function partitionName(date: Date): string {
    const iso = date.toISOString().slice(0, 10).replaceAll("-", "_");
    return `${PARTITION_PREFIX}${iso}`;
}

function dayBounds(date: Date): { from: string; to: string } {
    const from = date.toISOString().slice(0, 10);
    const to = new Date(date.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return { from, to };
}

/**
 * Creates the daily partitions for [today, today + daysAhead]. Idempotent —
 * safe to run repeatedly (e.g. once a day) so ingestion never falls back to
 * logs_default once the partitions created at migration time run out.
 */
export async function ensureFuturePartitions(daysAhead: number): Promise<string[]> {
    const created: string[] = [];

    for (let i = 0; i <= daysAhead; i++) {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() + i);

        const name = partitionName(date);
        const { from, to } = dayBounds(date);

        // sql.identifier() prevents SQL injection by properly escaping table and column names.

        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS ${sql.identifier(name)}
            PARTITION OF logs FOR VALUES FROM (${sql.raw(`'${from}'`)}) TO (${sql.raw(`'${to}'`)})
        `);
        created.push(name);
    }

    return created;
}

async function listDatedPartitions(): Promise<string[]> {
    // relname: text name of the table
    // oid: internal numeric id of the table
    // pg_inherits: Tracks inheritance relationships between tables (which includes PostgreSQL table partitions).
    // inhparent: oid of of parent table
    // inhrelid: oid of child table
    // pg_class: system catalog details for every table
    const rows = await db.execute<{ relname: string }>(sql`
        SELECT child.relname
        FROM pg_inherits
        JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
        JOIN pg_class child ON pg_inherits.inhrelid = child.oid
        WHERE parent.relname = 'logs'
    `);

    return rows
        .map((r) => r.relname)
        .filter((name) => name.startsWith(PARTITION_PREFIX) && DATE_SUFFIX.test(name.slice(PARTITION_PREFIX.length)));
}


export async function dropOldPartitions(retentionDays: number): Promise<string[]> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffName = partitionName(cutoff);

  const partitions = await listDatedPartitions();
  const dropped: string[] = [];

  for (const name of partitions) {
    if (name < cutoffName) {
      await db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(name)}`);
      dropped.push(name);
    }
  }

  // logs_hourly_counts/logs_minute_counts (the GET /logs/aggregate rollups — see
  // src/db/logs.ts) have no partitioning of their own, so they need an explicit
  // sweep alongside dropping the dated partitions above, or they'd grow past the
  // retention window forever. logs_minute_counts especially — at ~30x the row
  // count of the hourly table for the same window, an unbounded one of these
  // would eventually cost more to scan than what it's supposed to speed up.
  await db.execute(sql`DELETE FROM logs_hourly_counts WHERE hour < ${cutoff.toISOString()}::timestamptz`);
  await db.execute(sql`DELETE FROM logs_minute_counts WHERE minute < ${cutoff.toISOString()}::timestamptz`);

  return dropped;
}

/**
 * Creates (if missing) the dated partition for `date` and moves any matching
 * rows already sitting in logs_default into it.
 *
 * Postgres refuses to attach a new partition over a range logs_default
 * already holds rows for (it validates the default's contents against every
 * sibling partition's bounds — including a brand new one). Detaching
 * logs_default first sidesteps that check entirely — there's briefly no
 * default partition for anything to conflict with. But that same check
 * applies again on the way back in: reattaching logs_default as DEFAULT
 * re-validates it against every sibling, including the partition we just
 * created — so the matching rows have to be moved out of logs_default
 * *before* reattaching, not after, or the reattach itself fails with the
 * same error. The move is scoped to just this one day's range, unlike the
 * old version, so it's safe to run against a logs_default holding millions
 * of unrelated rows.
 *
 * The whole detach→create→move→reattach sequence runs inside one
 * transaction, gated by a transaction-scoped advisory lock: two calls for
 * different dates (e.g. the daily cron and a manual admin backfill
 * overlapping) can't both detach logs_default at once, and if anything in
 * the middle fails, Postgres rolls the detach back too instead of leaving
 * logs_default permanently orphaned.
 */
export async function backfillPartitionForDate(date: Date): Promise<{ partition: string; moved: number }> {
    const name = partitionName(date);
    const { from, to } = dayBounds(date);

    return await db.transaction(async (tx) => {
        // Acquires a transaction-level advisory lock named 'logs_default_backfill'.
        // If two HTTP requests attempt to backfill partitions simultaneously,
        //  this forces them to queue sequentially. The lock automatically releases when the transaction finishes.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('logs_default_backfill'))`);

        async function moveMatchingRows(): Promise<number> {
            const moved = await tx.execute(sql`
                WITH moved_rows AS (
                    DELETE FROM logs_default
                    WHERE timestamp >= ${from}::timestamptz AND timestamp < ${to}::timestamptz
                    RETURNING id, timestamp, level, service, message, attributes
                )
                INSERT INTO logs (id, timestamp, level, service, message, attributes)
                SELECT id, timestamp, level, service, message, attributes FROM moved_rows
                RETURNING id
            `);
            return moved.length;
        }

        const existsRows = await tx.execute<{ exists: boolean }>(
            sql`SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = ${name}) AS exists`
        );
        if (existsRows[0]!.exists) {
            return { partition: name, moved: await moveMatchingRows() };
        }

        await tx.execute(sql`ALTER TABLE logs DETACH PARTITION logs_default`);
        await tx.execute(sql`
            CREATE TABLE ${sql.identifier(name)}
            PARTITION OF logs FOR VALUES FROM (${sql.raw(`'${from}'`)}) TO (${sql.raw(`'${to}'`)})
        `);
        const moved = await moveMatchingRows();
        await tx.execute(sql`ALTER TABLE logs ATTACH PARTITION logs_default DEFAULT`);
        return { partition: name, moved };
    });
}

/**
 * A stray logs_default row for `date` is only worth backfilling into its own
 * partition if it's still within the retention window — otherwise it would
 * just get dropped again on the next dropOldPartitions run, so it's deleted
 * outright instead.
 */
export async function reconcileDefaultDate(
    date: Date,
    retentionDays: number
): Promise<{ action: "deleted" | "backfilled"; count: number }> {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);

    if (date < cutoff) {
        const { from, to } = dayBounds(date);
        const deleted = await db.execute(sql`
            DELETE FROM logs_default
            WHERE timestamp >= ${from}::timestamptz AND timestamp < ${to}::timestamptz
            RETURNING id
        `);
        return { action: "deleted", count: deleted.length };
    }

    const { moved } = await backfillPartitionForDate(date);
    return { action: "backfilled", count: moved };
}

// Sweeps every distinct date currently sitting in logs_default and resolves
// each one via reconcileDefaultDate — the routine housekeeping counterpart
// to ensureFuturePartitions/dropOldPartitions.
export async function reconcileDefaultPartition(
    retentionDays: number
): Promise<{ deleted: number; backfilled: string[] }> {
    const rows = await db.execute<{ day: string }>(
        sql`SELECT DISTINCT date_trunc('day', timestamp)::date AS day FROM logs_default`
    );

    let deleted = 0;
    const backfilled: string[] = [];

    for (const { day } of rows) {
        const date = new Date(day);
        const result = await reconcileDefaultDate(date, retentionDays);
        if (result.action === "deleted") deleted += result.count;
        else if (result.count > 0) backfilled.push(partitionName(date));
    }

    return { deleted, backfilled };
}