import { describe, expect, it, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../../src/db/db.js";
import { logs } from "../../../src/db/schema.js";
import {
    backfillPartitionForDate,
    dropOldPartitions,
    ensureFuturePartitions,
    reconcileDefaultDate,
    reconcileDefaultPartition,
} from "../../../src/retention/partitions.js";
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

// Inserts directly into the logs_default child table, bypassing the
// parent's partition routing — this is the only way to reproduce a stray
// row for a date, whether or not that date already has a matching partition,
// since inserting through `logs` itself would just route there directly.
async function insertStrayRow(date: Date, service: string): Promise<string> {
    const [row] = await db.execute<{ id: string }>(sql`
        INSERT INTO logs_default (timestamp, level, service, message, attributes)
        VALUES (${date.toISOString()}::timestamptz, 'info', ${service}, 'stray-row', '{}'::jsonb)
        RETURNING id
    `);
    return row!.id;
}

async function tableOidOf(id: string): Promise<string> {
    const [row] = await db.execute<{ part: string }>(
        sql`SELECT tableoid::regclass::text AS part FROM logs WHERE id = ${id}`
    );
    return row!.part;
}

describe("backfillPartitionForDate", () => {
    const targetDate = dateOffset(45); // safely past PARTITION_LOOKAHEAD_DAYS, so it starts out unpartitioned
    const targetName = partitionName(targetDate);
    const otherDate = dateOffset(46);
    const otherName = partitionName(otherDate);

    afterAll(async () => {
        await dropPartitionIfExists(targetName);
        await dropPartitionIfExists(otherName);
    });

    it("creates the partition and moves a stray logs_default row into it", async () => {
        const id = await insertStrayRow(targetDate, "__itest_backfill__");
        expect(await tableOidOf(id)).toBe("logs_default");

        const result = await backfillPartitionForDate(targetDate);
        expect(result).toEqual({ partition: targetName, moved: 1 });
        expect(await tableOidOf(id)).toBe(targetName);
    });

    it("is idempotent — calling it again for the same date just moves nothing", async () => {
        await expect(backfillPartitionForDate(targetDate)).resolves.toEqual({ partition: targetName, moved: 0 });
    });

    it("only touches the requested date, leaving other logs_default rows alone", async () => {
        const untouchedId = await insertStrayRow(otherDate, "__itest_backfill__");

        await backfillPartitionForDate(targetDate); // targetDate again, not otherDate

        expect(await tableOidOf(untouchedId)).toBe("logs_default");
        await db.delete(logs).where(sql`id = ${untouchedId}`);
    });
});

describe("reconcileDefaultDate", () => {
    const withinWindowDate = dateOffset(47);
    const withinWindowName = partitionName(withinWindowDate);
    const pastRetentionDate = dateOffset(-90);

    afterAll(() => dropPartitionIfExists(withinWindowName));

    it("backfills a date that's still within the retention window", async () => {
        await insertStrayRow(withinWindowDate, "__itest_reconcile__");
        const result = await reconcileDefaultDate(withinWindowDate, 30);
        expect(result).toEqual({ action: "backfilled", count: 1 });

        const partitions = await listPartitions();
        expect(partitions).toContain(withinWindowName);
    });

    it("deletes (rather than backfills) a date that's already past the retention window", async () => {
        const id = await insertStrayRow(pastRetentionDate, "__itest_reconcile__");
        const result = await reconcileDefaultDate(pastRetentionDate, 30);
        expect(result).toEqual({ action: "deleted", count: 1 });

        // gone entirely, not moved anywhere
        const rows = await db.execute(sql`SELECT 1 FROM logs WHERE id = ${id}`);
        expect(rows).toHaveLength(0);

        const name = partitionName(pastRetentionDate);
        expect(await listPartitions()).not.toContain(name);
    });
});

describe("reconcileDefaultPartition", () => {
    const freshDates = [dateOffset(48), dateOffset(49)];
    const staleDate = dateOffset(-95);

    afterAll(async () => {
        for (const d of freshDates) await dropPartitionIfExists(partitionName(d));
    });

    it("sweeps every distinct logs_default date, backfilling fresh ones and deleting stale ones", async () => {
        for (const d of freshDates) await insertStrayRow(d, "__itest_sweep__");
        await insertStrayRow(staleDate, "__itest_sweep__");

        const result = await reconcileDefaultPartition(30);

        expect(result.deleted).toBeGreaterThanOrEqual(1);
        for (const d of freshDates) {
            expect(result.backfilled).toContain(partitionName(d));
        }
    });
});

describe("retain", () => {
    it("runs the full ensure+drop+reconcile cycle without throwing, using real config", async () => {
        await expect(retain()).resolves.toBeUndefined();
    });
});
