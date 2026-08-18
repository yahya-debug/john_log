// Generic "try the fast path, fall back to the safe path on a connection
// failure" helper — used by db/db.ts's withReplicaFallback (db/logs.ts's raw
// tagged-template queries) and executeWithReplicaFallback (db/stats.ts's
// drizzle .execute()) so a read replica being unreachable degrades to "served
// by the primary, a little slower" instead of failing the request. Kept in
// its own module, independent of db.ts's connection bootstrap (which does a
// blocking "create the database if missing" check at import time), so this
// logic is testable in complete isolation — no Postgres connection, real or
// mocked, needed at all.

// Connection-level failures only (the replica unreachable — e.g. still mid
// pg_basebackup right after boot, since app.ts no longer waits on it being
// healthy before starting — or a transient network blip later). Anything
// else (a genuine query bug) rethrows unchanged instead of silently retrying
// against the primary and masking it.
//
// Two different failure shapes, both meaning "this Postgres instance can't
// serve queries right now": Node/postgres.js network-level codes (TCP never
// connected at all) AND Postgres's own SQLSTATE codes for "reached the
// server, but it isn't accepting queries yet" — confirmed directly under
// real load: the replica's TCP port was already accepting connections before
// Postgres itself finished recovery, producing `PostgresError: the database
// system is starting up` (code 57P03) instead of a network error. A
// code-only check against the network-level set missed this entirely — the
// fallback never triggered, every such read 500'd. 57P01/57P02 (admin/crash
// shutdown) are the same shape for the same reason: a replica that's down
// for any reason should degrade to the primary, not fail the request.
// 57014 (query_canceled) is what Postgres returns when db.ts's
// statement_timeout fires — a query that connected fine but didn't return in
// time. Same "this instance can't serve queries right now" shape as the
// others: without it here, the timeout cuts the hang short but the resulting
// error just rethrows as a 500 instead of retrying against the primary,
// defeating the point of adding the timeout in the first place.
const CONNECTION_ERROR_CODES = new Set([
    "CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT",
    "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET",
    "57P01", "57P02", "57P03", // Postgres: admin_shutdown, crash_shutdown, cannot_connect_now
    "57014", // Postgres: query_canceled (our own statement_timeout firing)
]);

// Checks err.code directly (postgres.js's raw tagged-template calls expose it
// there) and walks err.cause (drizzle-orm's .execute() wraps the real
// connection error one level deeper, as a standard Error.cause — confirmed
// directly: stopping the replica produced a top-level error with no .code at
// all, and the actual `ENOTFOUND` on .cause.code, which a top-level-only
// check silently missed, meaning db/stats.ts's fallback never triggered).
// Bounded depth (5) so a malformed circular .cause chain can't loop forever.
export function isConnectionError(err: unknown, depth = 5): boolean {
    if (depth <= 0 || typeof err !== "object" || err === null) return false;
    if ("code" in err && CONNECTION_ERROR_CODES.has(String((err as { code: unknown }).code))) return true;
    if ("cause" in err) return isConnectionError((err as { cause: unknown }).cause, depth - 1);
    return false;
}

export async function withFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    try {
        return await primary();
    } catch (err) {
        if (!isConnectionError(err)) throw err;
        console.warn(`read replica unreachable or timed out, falling back to primary: ${(err as Error).message}`);
        return fallback();
    }
}
