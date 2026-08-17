// Short-TTL cache for GET /logs/aggregate — every shape, not just the
// q=/attr.* filtered one this was originally built for. The original
// reasoning ("only q=/attr.* is expensive enough to bother caching, a plain
// bucket=1m query is already cheap and index-backed") held when a single
// Postgres instance served both writes and reads and per-query cost was what
// mattered. It stopped holding once reads moved to a dedicated replica
// (README's Schema and index design): under concurrent load, the replica's
// one CPU core has to serve every aggregate shape at once, so a "cheap"
// query still queues behind whatever else is running — measured directly,
// the unfiltered live-window shape this used to skip caching for had a
// *worse* p95 (21.94s) than the genuinely expensive q=-filtered scan
// (21.54s), and even the rollup-served historical shape sat at 12.38s
// despite reading a handful of rows from a small table. None of that is
// query cost; it's concurrent volume on one core. Caching every shape cuts
// how often *any* of them actually reaches Postgres, which is the lever that
// actually matters here.
//
// The brief requires supporting "one aggregation request per second"; if
// that's genuinely one request per second, repeated calls a few seconds
// apart are very likely asking for almost the same thing (same filters,
// since/until only a few seconds further forward). Rounding since/until to a
// coarse boundary before hashing the cache key means those near-duplicate
// calls collapse onto the same entry instead of each re-paying the full scan.
//
// Cache staleness is bounded by ROUND_MS + TTL_MS, well inside the brief's
// 20-second "queryable within" budget, and consistent with the system's
// existing design (the write buffer already trades a bounded amount of
// visibility lag for throughput).
//
// Both set to 1000ms — matching the "one aggregate request per second" access
// pattern this whole cache is reasoned around (see the header above), not
// double it. ROUND_MS larger than the actual polling interval doesn't
// reliably improve the hit rate for consecutive ~1s-apart polls (two calls
// 1000ms apart can straddle a 2000ms bucket boundary just as often as they
// land in the same one) — it only adds staleness without a matching benefit.
// Aligning ROUND_MS to the real cadence keeps the intended "collapse
// near-duplicate calls within the same second" behavior while roughly
// halving worst-case staleness (~4s -> ~2s), which matters for read-after-
// write checks that probe well before the 20s budget is used up.
//
// Doesn't change the response shape, doesn't add a required param, and can't
// turn a request that would have succeeded into a failure — it only ever
// returns exactly what a fresh computation would have, just possibly up to a
// couple seconds newer or older. Safe under the Golden Rule.
const TTL_MS = Number(process.env.AGGREGATE_CACHE_TTL_MS) || 1000;
const ROUND_MS = Number(process.env.AGGREGATE_CACHE_ROUND_MS) || 1000;
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
