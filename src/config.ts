import { config } from 'dotenv';
config();

export const Env = {
    db_name: process.env.POSTGRES_DB,
    db_url: process.env.DB_CONNECTION,
    // GET /logs and GET /logs/aggregate read from here instead (see db/db.ts's
    // readClient) — falls back to db_url when unset, so the app still works
    // against a single Postgres with no replica configured.
    read_db_url: process.env.READ_DB_CONNECTION || process.env.DB_CONNECTION,
    PORT: process.env.PORT,
    RETENTION_DAYS: Number(process.env.RETENTION_DAYS) || 30,
    PARTITION_LOOKAHEAD_DAYS: Number(process.env.PARTITION_LOOKAHEAD_DAYS) || 7,
    RETENTION_CRON: process.env.RETENTION_CRON || "10 0 * * *",
    AGGREGATE_Q_MAX_CONCURRENT: Number(process.env.AGGREGATE_Q_MAX_CONCURRENT) || Infinity,
}