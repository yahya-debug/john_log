import express, { Request, Response } from "express";
import { validateBatch } from "../../ingestion/validate.js";
import { validateQueryParams } from "../../query/validate.js";
import { runQuery } from "../../query/logsQuery.js";
import { pushLogs } from "../../ingestion/writeBuffer.js";

const router = express.Router();

// ingest
router.post('/', async function (req, res) {
    if (!Array.isArray(req.body?.logs))
        return res.status(400).json({ error: "request body must be { logs: [...] }" });

    const validate = validateBatch(req.body.logs);
    const responseJSON = {
        accepted: validate.accepted.length,
        rejected: validate.rejected
    }

    if (validate.accepted.length == 0)
        return res.status(400).json(responseJSON)

    // Awaited, but cheap: pushLogs only checks in-memory buffer capacity and
    // pushes — it never waits on Postgres. The actual flush stays fully
    // decoupled (src/ingestion/writeBuffer.ts). This await exists so a
    // buffer-at-capacity batch can be turned away with 503 + Retry-After
    // instead of getting a 200 that later turns out to be a lie.
    const push = await pushLogs(validate.accepted);
    if (!push.admitted) {
        res.setHeader("Retry-After", String(push.retryAfterSec));
        return res.status(429).json({ error: "write buffer is at capacity, retry shortly" });
    }

    res.status(200).json(responseJSON);
})

// query
router.get('/', validateQueryParams, async function (req: Request, res: Response) {
    const { query } = req;
    
    res.status(200).json(await runQuery(query));
})


export default router;