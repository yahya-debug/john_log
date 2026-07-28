import { config } from 'dotenv';
config();

export const Env = {
    db_url: process.env.DB_CONNECTION,
    PORT: process.env.PORT,
    RETENTION_DAYS: Number(process.env.RETENTION_DAYS) || 30,
    PARTITION_LOOKAHEAD_DAYS: Number(process.env.PARTITION_LOOKAHEAD_DAYS) || 7,
    RETENTION_CRON: process.env.RETENTION_CRON || "10 0 * * *",
}