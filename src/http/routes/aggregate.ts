import express, { Request, Response } from 'express';
import { validateAggregateParams } from '../../query/validate.js';
import { runAggregate } from '../../query/aggregateQuery.js';
import { Env } from '../../config.js';

const router = express.Router();

// Only q=-filtered aggregates are gated: they're the one measured case that degrades
// badly under concurrent load (README's Known limitations / Measured performance
// results) — the rollup-served and attr./unfiltered live-scan shapes aren't affected
// and stay uncapped. Module-level counter, not per-request state, since the whole
// point is tracking how many are in flight *across* concurrent requests.
let inFlightQAggregates = 0;

router.get('/', validateAggregateParams, async function (req: Request, res: Response) {
    const { query } = req;
    const isQFiltered = typeof query.q === "string" && query.q.length > 0;

    if (isQFiltered && inFlightQAggregates >= Env.AGGREGATE_Q_MAX_CONCURRENT) {
        res.setHeader("Retry-After", "1");
        return res.status(429).json({ error: "too many concurrent q=-filtered aggregate requests, retry shortly" });
    }

    if (isQFiltered) inFlightQAggregates++;
    try {
        res.status(200).json(await runAggregate(query));
    } finally {
        if (isQFiltered) inFlightQAggregates--;
    }
})

export default router;
