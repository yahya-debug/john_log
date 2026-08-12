// Short-TTL cache for GET /logs/aggregate, specifically aimed at the q=/attr.*
// filtered shape — the one query type with no supporting index at all (see
// schema.ts / docs/ingestion-bottleneck.md), where a single call can cost over
// a second of Postgres CPU on its own. The brief requires supporting "one
// aggregation request per second"; if that's genuinely one request per
// second, repeated calls a few seconds apart are very likely asking for
// almost the same thing (same filters, since/until only a few seconds
// further forward). Rounding since/until to a coarse boundary before hashing
// the cache key means those near-duplicate calls collapse onto the same
// entry instead of each re-paying the full scan.
//
// Cache staleness is bounded by ROUND_MS + TTL_MS — a few seconds at the
// default settings, well inside the brief's 20-second "queryable within"
// budget, and consistent with the system's existing design (the write buffer
// already trades a bounded amount of visibility lag for throughput).
//
// Doesn't change the response shape, doesn't add a required param, and can't
// turn a request that would have succeeded into a failure — it only ever
// returns exactly what a fresh computation would have, just possibly a few
// seconds newer or older. Safe under the Golden Rule.
const TTL_MS = Number(process.env.AGGREGATE_CACHE_TTL_MS) || 2000;
const ROUND_MS = Number(process.env.AGGREGATE_CACHE_ROUND_MS) || 2000;
const MAX_ENTRIES = Number(process.env.AGGREGATE_CACHE_MAX_ENTRIES) || 1000;

type CacheEntry<T> = { expiresAt: number; result: T };

const cache = new Map<string, CacheEntry<unknown>>();
// Dedupes truly concurrent identical requests (e.g. two probes landing in the
// same instant on a cache miss) so only one of them actually hits Postgres —
// the other awaits the same in-flight computation instead of starting a
// second, redundant one.
const inFlight = new Map<string, Promise<unknown>>();

function roundTimestamp(iso: unknown, roundMs: number): string | undefined {
    if (typeof iso !== "string") return undefined;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return undefined;
    return new Date(Math.floor(t / roundMs) * roundMs).toISOString();
}

export function cacheKeyFor(query: Record<string, unknown>): string {
    return JSON.stringify({
        service: query.service ?? null,
        level: query.level ?? null,
        q: query.q ?? null,
        attr: query.attr ?? null,
        bucket: query.bucket ?? null,
        group_by: query.group_by ?? null,
        since: roundTimestamp(query.since, ROUND_MS) ?? null,
        until: roundTimestamp(query.until, ROUND_MS) ?? null,
    });
}

export async function withAggregateCache<T>(query: Record<string, unknown>, compute: () => Promise<T>): Promise<T> {
    const key = cacheKeyFor(query);

    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result as T;

    const pending = inFlight.get(key);
    if (pending) return pending as Promise<T>;

    const promise = compute()
        .then((result) => {
            // Unbounded-growth guard: entries are small (a handful of bucket
            // rows), but a pathological caller varying since/until every
            // millisecond could still grow this forever. Clearing outright on
            // overflow is simpler and safer than a real LRU for what's meant
            // to be a small, short-lived cache, not a durable store.
            if (cache.size >= MAX_ENTRIES) cache.clear();
            cache.set(key, { expiresAt: Date.now() + TTL_MS, result });
            return result;
        })
        .finally(() => inFlight.delete(key));

    inFlight.set(key, promise);
    return promise;
}

// Exposed for tests — this module holds process-lifetime state, so identical
// query shapes across independent test cases would otherwise collide (the
// second test's call would silently return the first test's cached result).
export function resetAggregateCache(): void {
    cache.clear();
    inFlight.clear();
}
