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

  return dropped;
}

export async function moveToAppropriatePartition(): Promise<{ moved: number }> {
    const moved = await db.execute(sql`
        WITH moved_rows AS (
            DELETE FROM logs_default
            RETURNING id, timestamp, level, service, message, attributes
        )
        INSERT INTO logs logs (id, timestamp, level, service, message, attributes)
        SELECT id, timestamp, level, service, message, attributes FROM moved_rows
        RETURNING id;
    `)

    return {
        moved: moved.length
    }
}