import { NextFunction, Request, Response } from "express";
import { isLevel } from "../types/log.js";

export function validateQueryParams(req: Request, res: Response, next: NextFunction) {
    const { query } = req;

    if ("since" in query) {
        const since_date = new Date(query.since as string);
        if ("until" in query) {
            const until_date = new Date(query.until as string)
            if (until_date < since_date)
                return res.status(400).json({ error: "bad timestamp" })
        }
    }

    console.log("level" in query, !isLevel(query.level))
    if ("level" in query && !isLevel(query.level))
        return res.status(400).json({ error: "unknown level" })

    if ("limit" in query && isNaN(Number(query.limit)))
        return res.status(400).json({ error: "limit should be number" })

    next();
}