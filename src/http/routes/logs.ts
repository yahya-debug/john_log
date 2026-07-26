import express, { Request, Response } from "express";
import { validateBatch } from "../../ingestion/validate.js";
import { insertLogs } from "../../db/logs.js";
import { validateQueryParams } from "../../query/validate.js";
import { runQuery } from "../../query/logsQuery.js";

const router = express.Router();

// ingest
router.post('/', async function (req, res) {
    const validate = validateBatch(req.body.logs);
    const responseJSON = { 
        accepted: validate.accepted.length,
        rejected: validate.rejected
    }

    if (validate.accepted.length == 0)
        return res.status(400).json(responseJSON)

    await insertLogs(validate.accepted);
    res.status(200).json(responseJSON);
})

// query
router.get('/', validateQueryParams, async function (req: Request, res: Response) {
    const { query } = req;
    
    res.status(200).json(await runQuery(query));
})


export default router;