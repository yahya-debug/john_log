// Seeds ~1M synthetic rows directly through drizzle (bypassing HTTP) so the
// mixed load test runs against a table sized like the brief's grading target.
// Usage: SEED_ROWS=1000000 npx tsx loadtest/seed.ts
import { db } from "../src/db/db.js";
import { logs } from "../src/db/schema.js";
import { pick } from "./util.js";
import type { Level } from "../src/types/log.js";

const TOTAL_ROWS = Number(process.env.SEED_ROWS) || 1_000_000;
const BATCH_SIZE = 2_000;
const CONCURRENCY = 8;
// spread across the past N days so the table looks like real accumulated
// history, distinct from the live window the mixed test queries
const SEED_DAYS = Number(process.env.SEED_DAYS) || 7;

const SERVICES = ["checkout", "auth", "catalog", "payments", "shipping", "search"];
const LEVELS: Level[] = ["debug", "info", "warn", "error"];
const REGIONS = ["us-east", "us-west", "eu-west", "eu-central", "ap-south"];
const MESSAGES = [
    "request completed",
    "payment declined",
    "cache miss",
    "retrying upstream call",
    "connection reset",
    "user session expired",
    "rate limit exceeded",
    "database query slow",
];

function randomRow() {
    const spanMs = SEED_DAYS * 24 * 60 * 60 * 1000;
    return {
        timestamp: new Date(Date.now() - Math.random() * spanMs),
        level: pick(LEVELS),
        service: pick(SERVICES),
        message: pick(MESSAGES),
        attributes: {
            user_id: String(Math.floor(Math.random() * 100_000)),
            region: pick(REGIONS),
            retries: Math.floor(Math.random() * 5),
        },
    };
}

async function main() {
    const batches = Math.ceil(TOTAL_ROWS / BATCH_SIZE);
    let nextBatch = 0;
    const start = Date.now();

    async function worker() {
        while (nextBatch < batches) {
            const mine = nextBatch++;
            const size = mine === batches - 1 ? TOTAL_ROWS - mine * BATCH_SIZE : BATCH_SIZE;
            await db.insert(logs).values(Array.from({ length: size }, randomRow));

            if (mine % 20 === 0) {
                const inserted = Math.min((mine + 1) * BATCH_SIZE, TOTAL_ROWS);
                const elapsed = (Date.now() - start) / 1000;
                console.log(`${inserted}/${TOTAL_ROWS} rows (${Math.round(inserted / elapsed)}/s)`);
            }
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`done: ${TOTAL_ROWS} rows in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    process.exit(0);
}

main();
