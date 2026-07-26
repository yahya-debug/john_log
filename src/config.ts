import { config } from 'dotenv';
config();

export const Env = {
    db_url: process.env.DB_CONNECTION,
    PORT: process.env.PORT,
}