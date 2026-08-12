import { and, eq, gte, lt, sql, SQL } from "drizzle-orm";
import { logs } from "../db/schema.js";
import { QueryParams } from "../types/QueryParams.js";




export function commandCondition(query: QueryParams): SQL[] {
    const conditions: SQL[] = [];

    if (query.service)
        conditions.push(eq(logs.service, query.service))
    if (query.level)
        conditions.push(eq(logs.level, query.level))
    if (query.since)
        conditions.push(gte(logs.timestamp, new Date(query.since)))
    if (query.until)
        conditions.push(lt(logs.timestamp, new Date(query.until)))
    if (query.q)
        // LIKE against the precomputed message_lower column (see schema.ts) instead of
        // ILIKE against message: same case-insensitive semantics (both sides lowercased),
        // but avoids Postgres re-lowercasing `message` on every row of every scan.
        conditions.push(sql`${logs.messageLower} LIKE ${'%' + query.q.toLowerCase() + '%'}`)
    if (query.attr)
        for (const [key, val] of Object.entries(query.attr))
            conditions.push(sql`${logs.attributes} @> ${JSON.stringify({ [key]: val })}::jsonb`); // @> containment check (gin index)

    // sql`${logs.message} ILIKE ${'%' + query.q + '%'}`
    /*
        this is safe:
        drizzle does not send this as a single concatenated string
        it is done like this:
        * first part: msg ILIKE $1
        * second part: %{substr}%
        
        this keeps the query safe from SQL injection
    */
    return conditions;
}

export function combineConditions(conditions: SQL[]): SQL | undefined {
    return conditions.length > 0 ? and(...conditions):undefined;
}