import postgres from "postgres";
import { Env } from "../config.js";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from './schema.js'
const conn = postgres(Env.db_url as string);
export const db = drizzle(conn, { schema });