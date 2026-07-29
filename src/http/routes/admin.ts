import express, { Request, Response } from "express";
import { validateBatch, isStale } from "../../ingestion/validate.js";
import { insertLogs } from "../../db/logs.js";
import { getStats } from "../../db/stats.js";
import { backfillPartitionForDate } from "../../retention/partitions.js";

const router = express.Router();

// Everything worth knowing about the current state of the store: per-partition
// row counts and sizes (including logs_default, so a growing backlog there is
// visible), totals by level/service, the actual stored time range, a rough
// ingestion rate, and the retention config driving all of the above.
router.get('/stats', async function (req: Request, res: Response) {
    res.status(200).json(await getStats());
})

// Manual-only historical backfill: bypasses ingestion's normal "reject
// anything older than the retention window" rule, but only for entries
// actually still within the window — anything older than that is discarded
// rather than inserted, since it would just get dropped again on the next
// retention sweep anyway. Never called by any scheduled job.
router.post('/logs/backfill', async function (req: Request, res: Response) {
    const { accepted, rejected } = validateBatch(req.body.logs, { allowStale: true });

    const toInsert = accepted.filter((entry) => !isStale(entry.timestamp));
    const discarded = accepted.length - toInsert.length;

    const dates = new Set(toInsert.map((entry) => new Date(entry.timestamp).toISOString().slice(0, 10)));
    for (const date of dates)
        await backfillPartitionForDate(new Date(date));

    if (toInsert.length > 0)
        await insertLogs(toInsert);

    const responseJSON = { accepted: toInsert.length, discarded, rejected };
    res.status(toInsert.length > 0 ? 200 : 400).json(responseJSON);
})

export default router;
