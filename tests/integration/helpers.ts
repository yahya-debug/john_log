// Shared setup for integration tests, which run against the real Postgres
// instance (DB_CONNECTION from .env / docker-compose) rather than mocks.
// Every test scopes itself to a unique `service` tag so it can run safely
// against a database that already holds real/seeded data, and cleans up
// after itself rather than requiring a dedicated empty test database.
import { eq } from "drizzle-orm";
import { db } from "../../src/db/db.js";
import { logs } from "../../src/db/schema.js";

let counter = 0;

export function uniqueService(prefix: string): string {
    counter += 1;
    return `__itest_${prefix}_${Date.now()}_${counter}__`;
}

export async function deleteService(service: string): Promise<void> {
    await db.delete(logs).where(eq(logs.service, service));
}
