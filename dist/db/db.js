import postgres from "postgres";
import { Env } from "../config.js";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from './schema.js';
import { sql } from "drizzle-orm";
export const db = await async function () {
    let conn = postgres(Env.db_url);
    let db = drizzle(conn, { schema });
    const dbName = Env.db_name;
    // just the same string to connect to a specific DB but replace the name with postgres
    const adminConnStr = Env.db_url?.replace(`/${dbName}`, '/postgres');
    const adminConn = postgres(adminConnStr);
    const admin = drizzle(adminConn);
    try {
        const checkExistance = await admin.execute(sql `SELECT 1 FROM pg_database WHERE datname = ${dbName}`);
        if (checkExistance.length == 0) {
            await admin.execute(sql `CREATE DATABASE ${sql.identifier(dbName)}`);
            conn = postgres(Env.db_url);
            db = drizzle(conn, { schema });
            console.log(`DB created`);
        }
        else {
            conn = postgres(Env.db_url);
            db = drizzle(conn, { schema });
            console.log(`DB already exist`);
        }
    }
    finally {
        await adminConn.end();
    }
    return db;
}();
