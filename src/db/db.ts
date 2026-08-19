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
