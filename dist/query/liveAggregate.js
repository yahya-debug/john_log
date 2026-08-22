// In-memory counterpart to aggregateLogs/aggregateFromRollup (db/logs.ts) for
// the one shape that matters most for the brief's "queryable within 20s"
// requirement: bucket=1m, no q=/attr.* filter, a recent range. Postgres stays
// the source of truth — this is a read-side accelerator only, populated by
// writeBuffer.ts's flush() calling recordAccepted() right after a batch is
// durably committed (not at accept time), so it can never diverge ahead of
// what Postgres actually holds, just lag behind it by at most one flush
// interval. Takes no dependency on writeBuffer.ts itself — recordAccepted is
// a plain function writeBuffer.ts calls into, not an event this module
// subscribes to — so importing this module (e.g. from aggregateQuery.ts)
// never drags in db/db.ts's eager connect-on-import bootstrap.
//
// Deliberately scoped to what's provably safe to answer from memory: only
// service/level/since/until (plain equality/range filters aggregateLogs
// itself applies), never q=/attr.* (unbounded value space, not tracked
// here — see filters.ts's commandCondition). Callers decide bucket size;
// this module only ever deals in 1-minute buckets, matching date_bin('1
// minute', timestamp, TIMESTAMPTZ '2000-01-01') exactly, since that origin
// is itself minute-aligned.
const MINUTE_MS = 60_000;
const RETENTION_MINUTES = 15;
const buckets = new Map();
// Bounds how far back a query can trust "no data in memory" to mean "zero",
// not "we simply weren't running yet". Without this, a query() call shortly
// after process start could silently return an incomplete (looks-empty)
// answer for a range that predates the tracker entirely, instead of
// correctly refusing to answer it.
const trackerStartedAt = Date.now();
function bucketKeyFor(timestamp) {
    const ms = new Date(timestamp).getTime();
    return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}
function groupKeyFor(service, level) {
    return `${service}\x00${level}`;
}
export function recordAccepted(entries) {
    for (const entry of entries) {
        const bucketStart = bucketKeyFor(entry.timestamp);
        if (Number.isNaN(bucketStart))
            continue; // defensive only — validated upstream already
        let bucket = buckets.get(bucketStart);
        if (!bucket) {
            bucket = new Map();
            buckets.set(bucketStart, bucket);
        }
        const key = groupKeyFor(entry.service, entry.level);
        bucket.set(key, (bucket.get(key) ?? 0) + 1);
    }
    prune();
}
// Runs on every record() call instead of a separate timer — this module has
// no lifetime of its own to manage (no interval to unref/clear), and pruning
// is cheap (at most RETENTION_MINUTES map entries to scan).
function prune() {
    const cutoff = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS - (RETENTION_MINUTES - 1) * MINUTE_MS;
    for (const bucketStart of buckets.keys()) {
        if (bucketStart < cutoff)
            buckets.delete(bucketStart);
    }
}
function sumBucket(bucket, filters) {
    const sums = new Map();
    for (const [key, count] of bucket) {
        const [service, level] = key.split("\x00");
        if (filters.service && service !== filters.service)
            continue;
        if (filters.level && level !== filters.level)
            continue;
        const groupKey = filters.groupBy === "service" ? service : filters.groupBy === "level" ? level : null;
        sums.set(groupKey, (sums.get(groupKey) ?? 0) + count);
    }
    return sums;
}
// Returns the same shape aggregateLogs/aggregateFromRollup do, or null if
// `since` reaches further back than what's actually retained/known, or
// either bound is unparseable — the caller (aggregateQuery.ts) is expected
// to fall back to the real DB query whenever this returns null, never to
// treat null as "zero results". The NaN checks matter on their own: an
// invalid Date compares false against everything (NaN < x and NaN >= x are
// both always false), which would otherwise silently filter every bucket
// out and return a deceptive-looking [] instead of admitting "can't answer
// this" — the exact "looks-empty but actually unknown" failure this
// function exists to avoid.
export function queryLive(filters) {
    const sinceBucket = bucketKeyFor(filters.since);
    const untilMs = filters.until.getTime();
    if (Number.isNaN(sinceBucket) || Number.isNaN(untilMs))
        return null;
    const oldestReliable = Math.max(Math.floor(trackerStartedAt / MINUTE_MS) * MINUTE_MS, Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS - (RETENTION_MINUTES - 1) * MINUTE_MS);
    if (sinceBucket < oldestReliable)
        return null;
    const rows = [];
    const sortedStarts = [...buckets.keys()]
        .filter((start) => start >= sinceBucket && start < untilMs)
        .sort((a, b) => a - b);
    for (const bucketStart of sortedStarts) {
        const sums = sumBucket(buckets.get(bucketStart), filters);
        for (const [group, count] of sums) {
            rows.push({ start: new Date(bucketStart).toISOString(), group, count });
        }
    }
    return rows;
}
// Exposed for tests — this module holds process-lifetime state, so tests
// need a way to reset it between cases instead of colliding on shared state.
export function resetLiveAggregate() {
    buckets.clear();
}
