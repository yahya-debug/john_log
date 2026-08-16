import postgres from "postgres";
import { Env } from "../config.js";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from './schema.js'
import { sql } from "drizzle-orm";


export const db =await async function(): Promise<PostgresJsDatabase<typeof schema> & {$client: postgres.Sql<{}>}> {
    const dbName = Env.db_name;
    // just the same string to connect to a specific DB but replace the name with postgres
    const adminConnStr = Env.db_url?.replace(`/${dbName}`, '/postgres');
    const adminConn = postgres(adminConnStr as string)
    const admin = drizzle(adminConn);

    try {
        const checkExistance = await admin.execute(sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`);

        if (checkExistance.length == 0) {
            await admin.execute(sql`CREATE DATABASE ${sql.identifier(dbName as string)}`)
            console.log(`DB created`);
        } else {
            console.log(`DB already exist`);
        }
    } finally {
        await adminConn.end();
    }

    const conn = postgres(Env.db_url as string);
    return drizzle(conn, { schema });
}();

// Read-only connection for GET /logs and GET /logs/aggregate (see db/logs.ts's
// queryLogs/aggregateLogs/aggregateFromRollup) — points at the read replica
// when READ_DB_CONNECTION is set, otherwise falls back to the same primary
// `db` uses (src/config.ts). No "create database if missing" logic here — a
// replica gets its schema via physical replication, it never creates its own.
//
// Wrapped in drizzle(...), same as `db` above, even though nothing here uses
// drizzle's query builder — a *plain* `postgres(...)` client double-encodes
// jsonb parameters that arrive via a Fragment built by another client (e.g.
// commandCondition's `attributes @> ${...}::jsonb` in query/filters.ts):
// confirmed directly — the exact same Fragment, run through a plain client,
// silently matched 0 rows; run through a drizzle-wrapped client, matched
// correctly. Whatever type-serialization drizzle sets up on the connection
// fixes it, so every client that runs a query built from these fragments
// needs the same wrapping, not just `db`.
export const readClient: postgres.Sql<{}> = drizzle(postgres(Env.read_db_url as string), { schema }).$client;
