import { describe, expect, it, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../../src/db/db.js";
import { logs } from "../../../src/db/schema.js";
import { dropOldPartitions, ensureFuturePartitions } from "../../../src/retention/partitions.js";
import { retain } from "../../../src/retention/job.js";

function dateOffset(days: number): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}

function partitionName(date: Date): string {
    return `logs_${date.toISOString().slice(0, 10).replaceAll("-", "_")}`;
}

async function listPartitions(): Promise<string[]> {
    const rows = await db.execute<{ relname: string }>(sql`
        SELECT child.relname
        FROM pg_inherits
        JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
        JOIN pg_class child ON pg_inherits.inhrelid = child.oid
        WHERE parent.relname = 'logs'
    `);
    return rows.map((r) => r.relname);
}

// Creates a single dated partition directly via SQL, independent of
// ensureFuturePartitions (which only ever creates partitions starting from
// "today" forward) — needed so dropOldPartitions has something old to drop
// without creating dozens of intervening partitions to reach it.
async function createPartitionForDate(date: Date): Promise<string> {
    const name = partitionName(date);
    const from = date.toISOString().slice(0, 10);
    const to = new Date(date.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS ${sql.identifier(name)}
        PARTITION OF logs FOR VALUES FROM (${sql.raw(`'${from}'`)}) TO (${sql.raw(`'${to}'`)})
    `);
    return name;
}

async function dropPartitionIfExists(name: string): Promise<void> {
    await db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(name)}`);
}

describe("ensureFuturePartitions", () => {
    it("creates today's partition plus the next N days, named logs_YYYY_MM_DD", async () => {
        const created = await ensureFuturePartitions(2);

        expect(created).toEqual([
            partitionName(dateOffset(0)),
            partitionName(dateOffset(1)),
            partitionName(dateOffset(2)),
        ]);

        const partitions = await listPartitions();
        for (const name of created) {
            expect(partitions).toContain(name);
        }
    });

    it("is idempotent — calling it again with already-existing partitions doesn't error", async () => {
        await expect(ensureFuturePartitions(2)).resolves.toEqual([
            partitionName(dateOffset(0)),
            partitionName(dateOffset(1)),
            partitionName(dateOffset(2)),
        ]);
    });
});

describe("dropOldPartitions", () => {
    const oldDate = dateOffset(-60);
    const oldName = partitionName(oldDate);
    const keepDate = dateOffset(0);

    afterAll(() => dropPartitionIfExists(oldName));

    it("drops dated partitions older than the retention window and reports their names", async () => {
        await createPartitionForDate(oldDate);
        await ensureFuturePartitions(0); // make sure today's partition exists as the "keep" control

        const dropped = await dropOldPartitions(30);
        expect(dropped).toContain(oldName);

        const partitions = await listPartitions();
        expect(partitions).not.toContain(oldName);
    });

    it("leaves partitions within the retention window alone", async () => {
        const partitions = await listPartitions();
        expect(partitions).toContain(partitionName(keepDate));
    });

    it("reports nothing dropped when nothing is old enough", async () => {
        const dropped = await dropOldPartitions(30);
        expect(dropped).toEqual([]);
    });
});

describe("moveToAppropriatePartition", () => {
    const targetDate = dateOffset(45); // safely past PARTITION_LOOKAHEAD_DAYS, so it starts out unpartitioned
    const targetName = partitionName(targetDate);

    afterAll(async () => {
        await dropPartitionIfExists(targetName);
    });

    // Postgres won't let you CREATE a partition over a date range that
    // already has matching rows sitting in logs_default (it validates the
    // default partition's contents against the new bounds) — so
    // moveToAppropriatePartition can never legitimately fire in an "insert
    // stray row, then create the partition" order; the CREATE itself is
    // rejected first. Pin that down explicitly, since it constrains how
    // (or whether) this function can ever be used from real ingestion.
    it("Postgres refuses to create a partition over a date range logs_default already has rows for", async () => {
        await db
            .insert(logs)
            .values({ timestamp: targetDate, level: "info", service: "__itest_move__", message: "move-me", attributes: {} });

        let error: any;
        try {
            await createPartitionForDate(targetDate);
        } catch (e) {
            error = e;
        }
        expect(error).toBeDefined();
        expect(String(error?.cause?.message ?? error?.message)).toMatch(/default partition/i);

        await db.delete(logs).where(sql`service = '__itest_move__'`);
    });

    // NOTE: we deliberately don't exercise the "happy path" (insert a stray
    // logs_default row, call moveToAppropriatePartition(), assert it moved)
    // here. The real function has no scoping — it's `DELETE FROM logs_default
    // RETURNING ... INSERT INTO logs ...` over the *entire* table — and this
    // database's logs_default currently holds ~1.7M rows (from loadtest
    // seeding: seed dates only span the past week, but partitions only ever
    // get created from "today" forward, so most seeded history has nowhere
    // else to live). Actually calling it here would rewrite all of that on
    // every test run. If this function is ever wired up for real use, it
    // needs a date/batch-scoped signature before it's safe to call at all,
    // let alone test against a populated table.
});

describe("retain", () => {
    it("runs the full ensure+drop cycle without throwing, using real config", async () => {
        await expect(retain()).resolves.toBeUndefined();
    });
});
