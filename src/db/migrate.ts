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

export async function _isReady(): Promise<boolean> {
    await runMigration()
    return isReady;
}