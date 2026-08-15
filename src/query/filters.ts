import postgres from "postgres";
import { Env } from "../config.js";
import { QueryParams } from "../types/QueryParams.js";

// postgres.js's own tagged-template function doubles as the fragment builder —
// unlike drizzle-orm's detached `sql` helper, a fragment has to come from an actual
// client instance. This one is never queried directly (only db/db.ts's `db.$client`
// is, for the real, already-connected client) — it exists purely to construct
// Fragment objects, which are plain strings+params data that whichever client
// actually executes the outer query serializes using its own connection, regardless
// of which instance built them (verified against postgres.js's own `stringify`/
// `fragment` internals). Constructing a client is lazy — no socket opens until a
// query runs on it — so this never connects to anything on its own. Deliberately
// separate from db.$client so importing this file (a pure condition-building
// module used by unit tests too) doesn't drag in db/db.ts's eager, blocking
// "connect and create the database if missing" bootstrap.
export const sql = postgres(Env.db_url as string);

export function commandCondition(query: QueryParams): postgres.Fragment[] {
    const conditions: postgres.Fragment[] = [];

    if (query.service)
        conditions.push(sql`service = ${query.service}`)
    if (query.level)
        conditions.push(sql`level = ${query.level}`)
    // .toISOString(), not a raw Date: db/db.ts's drizzle(conn, {schema}) wrapper
    // reconfigures conn's type serialization for its own column-mapping needs, which
    // breaks postgres.js's normal automatic Date->timestamptz serialization for raw
    // tagged-template queries run through db.$client — a bare Date param throws
    // ("Received an instance of Date") deep in the wire protocol. Pre-stringifying
    // sidesteps it entirely, matching db/logs.ts's insertLogs/upsertHourlyCounts,
    // which already do this for the same reason.
    if (query.since)
        conditions.push(sql`timestamp >= ${new Date(query.since).toISOString()}`)
    if (query.until)
        conditions.push(sql`timestamp < ${new Date(query.until).toISOString()}`)
    if (query.q)
        // LIKE against the precomputed message_lower column (see schema.ts) instead of
        // ILIKE against message: same case-insensitive semantics (both sides lowercased),
        // but avoids Postgres re-lowercasing `message` on every row of every scan.
        conditions.push(sql`message_lower LIKE ${'%' + query.q.toLowerCase() + '%'}`)
    if (query.attr)
        for (const [key, val] of Object.entries(query.attr))
            conditions.push(sql`attributes @> ${JSON.stringify({ [key]: val })}::jsonb`); // @> containment check (gin index)

    /*
        this is safe:
        postgres.js does not send this as a single concatenated string
        it is done like this:
        * first part: msg LIKE $1
        * second part: %{substr}%

        this keeps the query safe from SQL injection
    */
    return conditions;
}

// Combines conditions into a full WHERE clause, or an empty fragment when there are
// none — postgres.js builds dynamic queries by nesting sql fragments inside other sql
// fragments/templates (its "Building queries" pattern) rather than handing back a
// query-builder object the way an ORM would, so the WHERE keyword has to be included
// here rather than added later by the caller.
export function combineConditions(conditions: postgres.Fragment[]): postgres.Fragment {
    if (conditions.length === 0) return sql``;
    return sql`WHERE ${conditions.flatMap((c, i) => (i === 0 ? [c] : [sql` AND `, c]))}`;
}