import express, { Request, Response } from 'express';
import { validateAggregateParams } from '../../query/validate.js';
import { runAggregate } from '../../query/aggregateQuery.js';

const router = express.Router();

router.get('/', validateAggregateParams, async function (req: Request, res: Response) {
    const { query } = req;

    res.status(200).json(await runAggregate(query));
})

export default router;