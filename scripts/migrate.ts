// CI/setup entrypoint for applying migrations. Deliberately reuses
// runMigration() from src/db/migrate.ts — the same code path App() runs at
// startup in Docker — instead of the `drizzle-kit migrate` CLI, which failed
// silently (exit 1, no error message) in GitHub Actions for reasons that
// didn't reproduce locally under an identical Node 20 container.
import { _isReady } from "../src/db/migrate.js";

const ready = await _isReady();
if (!ready) {
    console.error("migrations did not complete successfully");
    process.exit(1);
}
console.log("migrations applied successfully");
// db.ts opens a persistent connection pool meant to outlive App() for the
// life of the server — this one-off script has to force-exit instead of
// waiting for those sockets to close on their own.
process.exit(0);
