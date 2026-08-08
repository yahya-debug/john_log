import express from "express";
import { validateBatch, isStale } from "../../ingestion/validate.js";
import { deleteDeadLetter, insertLogs, listDeadLetters, upsertHourlyCounts } from "../../db/logs.js";
import { getStats } from "../../db/stats.js";
import { backfillPartitionForDate } from "../../retention/partitions.js";
import { db } from "../../db/db.js";
import { tailEmitter } from "../../ingestion/writeBuffer.js";
import { isLevel } from "../../types/log.js";
const router = express.Router();
// Everything worth knowing about the current state of the store: per-partition
// row counts and sizes (including logs_default, so a growing backlog there is
// visible), totals by level/service, the actual stored time range, a rough
// ingestion rate, and the retention config driving all of the above.
router.get('/stats', async function (req, res) {
    res.status(200).json(await getStats());
});
// Manual-only historical backfill: bypasses ingestion's normal "reject
// anything older than the retention window" rule, but only for entries
// actually still within the window — anything older than that is discarded
// rather than inserted, since it would just get dropped again on the next
// retention sweep anyway. Never called by any scheduled job.
router.post('/logs/backfill', async function (req, res) {
    const { accepted, rejected } = validateBatch(req.body.logs, { allowStale: true });
    const toInsert = accepted.filter((entry) => !isStale(entry.timestamp));
    const discarded = accepted.length - toInsert.length;
    const dates = new Set(toInsert.map((entry) => new Date(entry.timestamp).toISOString().slice(0, 10)));
    for (const date of dates)
        await backfillPartitionForDate(new Date(date));
    if (toInsert.length > 0) {
        await insertLogs(toInsert);
        // Keeps GET /logs/aggregate's rollup fast-path (src/db/logs.ts) accurate for
        // backfilled historical data too, not just normal ingestion.
        await upsertHourlyCounts(toInsert);
    }
    const responseJSON = { accepted: toInsert.length, discarded, rejected };
    res.status(toInsert.length > 0 ? 200 : 400).json(responseJSON);
});
// Manual-only dead-letter inspection: everything writeBuffer.ts's flush() gave up on
// (see src/db/schema.ts's logsDeadLetter and README's Optional features). Read-only —
// doesn't touch the queue, just lets an operator see what's sitting in it and why.
router.get('/dead-letter', async function (req, res) {
    res.status(200).json(await listDeadLetters());
});
// Manual-only replay: retries every currently dead-lettered batch, one transaction per
// row (see db/logs.ts's deadLetterEntries for why per-row, not one combined batch — a
// single failure in a combined insert would roll back rows that would've replayed
// fine). Each row's entries go through the exact same insertLogs+upsertHourlyCounts
// pair the write buffer's flush() uses, so a successful replay is indistinguishable
// from normal ingestion. Only removed from logs_dead_letter on success; anything that
// fails again (same underlying issue, or a new one) stays queued for a later attempt —
// never called by any scheduled job, same posture as /logs/backfill.
router.post('/dead-letter/replay', async function (req, res) {
    const rows = await listDeadLetters();
    let replayed = 0;
    let stillFailed = 0;
    for (const row of rows) {
        try {
            await db.$client.begin(async (tx) => {
                await insertLogs(row.entries, tx);
                await upsertHourlyCounts(row.entries, tx);
            });
            await deleteDeadLetter(row.id);
            replayed++;
        }
        catch (error) {
            console.error(`dead-letter replay: row ${row.id} failed again, leaving queued:`, error);
            stillFailed++;
        }
    }
    res.status(200).json({ replayed, stillFailed });
});
// Live-tail (stretch goal): streams newly-flushed entries as Server-Sent Events,
// filtered by the same service/level params GET /logs supports (q=/attr.* aren't —
// keeping the in-memory filter cheap per event mattered more than parity here).
// Fed directly off writeBuffer.ts's post-flush event, not a DB poll or a new
// connection per client — subscribing costs one EventEmitter listener, nothing else.
// Only entries that actually committed are ever emitted (see writeBuffer.ts), so
// what's tailed always matches what GET /logs would return. Doesn't include the
// DB-generated `id`: insertLogs skips `.returning()` on the hot path (see
// db/logs.ts), so a tailed entry is a Log minus `id`.
router.get('/logs/tail', function (req, res) {
    const service = typeof req.query.service === 'string' ? req.query.service : undefined;
    const level = typeof req.query.level === 'string' ? req.query.level : undefined;
    if (level !== undefined && !isLevel(level))
        return res.status(400).json({ error: `invalid level: '${level}'` });
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    req.socket.setNoDelay(true); // don't let Nagle's algorithm batch/delay these
    res.flushHeaders();
    res.write(': connected\n\n');
    function onFlushed(entries) {
        for (const entry of entries) {
            if (service !== undefined && entry.service !== service)
                continue;
            if (level !== undefined && entry.level !== level)
                continue;
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
        }
    }
    tailEmitter.on('flushed', onFlushed);
    // Proxies/load balancers commonly time out an idle connection; a periodic
    // comment line (ignored by EventSource clients per the SSE spec) keeps it open.
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    req.on('close', () => {
        clearInterval(heartbeat);
        tailEmitter.off('flushed', onFlushed);
    });
});
export default router;
