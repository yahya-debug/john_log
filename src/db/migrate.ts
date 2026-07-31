import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db.js";

let isReady: boolean = false;

export async function runMigration() {
    try {
        // import.meta is an object that every module gets
        // holding metadata about the module itself
        // by using it, regardless of where we run our app
        // it will resolve to this module data
        await migrate(db, { migrationsFolder: `${import.meta.dirname}/migrations` });

        // if done service is ready
        isReady = true;
    } catch (error) {
        console.error((error as Error).message);
    }
}

// Cheap, synchronous, no DB round-trip or disk read — just reads the flag
// runMigration() already set. Safe to poll frequently (e.g. a k8s readiness
// probe), unlike _isReady() below which re-runs the whole migration check.
export function isMigrationReady(): boolean {
    return isReady;
}

// Actively runs migrations and reports whether they succeeded. Used by the
// CI/setup entrypoint (scripts/migrate.ts) and by tests that need to wait
// out App()'s fire-and-forget migration — not by the HTTP /health route,
// which should only ever read the cached state via isMigrationReady().
export async function _isReady(): Promise<boolean> {
    await runMigration()
    return isReady;
}