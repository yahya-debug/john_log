import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/db/logs.js", () => ({
    aggregateLogs: vi.fn(),
    aggregateFromRollup: vi.fn(),
    aggregateFromMinuteRollup: vi.fn(),
}));

import { aggregateLogs, aggregateFromRollup, aggregateFromMinuteRollup } from "../../../src/db/logs.js";
import { runAggregate } from "../../../src/query/aggregateQuery.js";
import { resetAggregateCache } from "../../../src/query/aggregateCache.js";
import { recordAccepted, resetLiveAggregate } from "../../../src/query/liveAggregate.js";
import { ValidatedLog } from "../../../src/types/log.js";

const mockedAggregateLogs = vi.mocked(aggregateLogs);
const mockedAggregateFromRollup = vi.mocked(aggregateFromRollup);
const mockedAggregateFromMinuteRollup = vi.mocked(aggregateFromMinuteRollup);

function log(overrides: Partial<ValidatedLog> = {}): ValidatedLog {
    return {
        timestamp: new Date().toISOString(),
        level: "info",
        service: "checkout",
        message: "ok",
        ...overrides,
    };
}

beforeEach(() => {
    mockedAggregateLogs.mockReset();
    mockedAggregateFromRollup.mockReset();
    mockedAggregateFromMinuteRollup.mockReset();
    // Otherwise identical query shapes across these test cases (e.g. two
    // different tests both calling runAggregate({ bucket: "1m" })) would hit
    // aggregateQuery.ts's cache and silently return a previous test's mocked
    // result instead of exercising aggregateLogs again.
    resetAggregateCache();
    // liveAggregate.ts (real module, not mocked — see its own tests for why
    // it's safe to import directly) holds process-lifetime state too, same
    // reason.
    resetLiveAggregate();
});

// The existing bucket="1m" tests above and below this point never pass
// since/until, so liveAggregate.ts's queryLive always refuses (an
// unparseable date, see liveAggregate.test.ts) and every one of them falls
// straight through to the DB path unchanged — they're exercising the
// DB/cache path, not the live one. The live path itself, with real
// since/until and real recorded data, is covered separately below.
describe("runAggregate: live in-memory path (bucket=1m, real since/until)", () => {
    // See liveAggregate.test.ts's own comment on this: trackerStartedAt is
    // captured at real module-import time, which happens moments before
    // these tests run — without jumping fake time a safe margin forward
    // first, `since = now - 60s` would race against that and can land
    // before trackerStartedAt, tripping queryLive's "can't trust this"
    // guard for what should be an ordinary recent query.
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 5 * 60_000);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("serves a 1m query straight from the in-memory tracker, without touching aggregateLogs", async () => {
        const now = new Date();
        recordAccepted([log({ service: "checkout", timestamp: now.toISOString() })]);

        const res = await runAggregate({
            bucket: "1m",
            since: new Date(now.getTime() - 60_000).toISOString(),
            until: new Date(now.getTime() + 60_000).toISOString(),
        });

        expect(res).toEqual({ buckets: [{ start: expect.any(String), group: null, count: 1 }] });
        expect(mockedAggregateLogs).not.toHaveBeenCalled();
    });

    it("falls back to the minute rollup (not aggregateLogs) when since predates what the tracker can reliably answer", async () => {
        mockedAggregateFromMinuteRollup.mockResolvedValue([]);
        const now = new Date();

        await runAggregate({
            bucket: "1m",
            since: new Date(now.getTime() - 60 * 60_000).toISOString(), // an hour back — outside retention
            until: now.toISOString(),
        });

        // Unlike the ephemeral in-memory tracker, logs_minute_counts (see
        // db/logs.ts's aggregateFromMinuteRollup) has no retention-window
        // ceiling of its own — this is the case that actually needed one.
        expect(mockedAggregateFromMinuteRollup).toHaveBeenCalled();
        expect(mockedAggregateLogs).not.toHaveBeenCalled();
    });

    it("does not cache a live-path hit — a later poll reflects newly recorded data instead of a stale snapshot", async () => {
        const now = new Date();
        const params = {
            bucket: "1m" as const,
            since: new Date(now.getTime() - 60_000).toISOString(),
            until: new Date(now.getTime() + 60_000).toISOString(),
        };

        recordAccepted([log({ timestamp: now.toISOString() })]);
        const first = await runAggregate(params);
        expect(first).toEqual({ buckets: [{ start: expect.any(String), group: null, count: 1 }] });

        recordAccepted([log({ timestamp: now.toISOString() })]);
        const second = await runAggregate(params);
        expect(second).toEqual({ buckets: [{ start: expect.any(String), group: null, count: 2 }] });
    });

    it("still uses the DB scan (not the live path) for bucket=1m when q= is present", async () => {
        mockedAggregateLogs.mockResolvedValue([]);
        const now = new Date();
        recordAccepted([log({ timestamp: now.toISOString() })]);

        await runAggregate({
            bucket: "1m",
            since: new Date(now.getTime() - 60_000).toISOString(),
            until: new Date(now.getTime() + 60_000).toISOString(),
            q: "declined",
        });

        expect(mockedAggregateLogs).toHaveBeenCalled();
    });
});

// Every bucket size now has rollup coverage when unfiltered (1m/5m ->
// logs_minute_counts, 1h/1d -> logs_hourly_counts — see canUseMinuteRollup/
// canUseHourlyRollup in aggregateQuery.ts), so a q=/attr.* filter is the only
// thing left that reaches the raw scan over `logs`, regardless of bucket
// size. These tests all add q= specifically to force that path — the
// interval-translation/WHERE-building/envelope-wrapping behavior under test
// is aggregateLogs's, not the filter's.
describe("runAggregate: raw scan over `logs` (only reached via q=/attr.* now)", () => {
    it("translates the bucket size param into the Postgres interval literal", async () => {
        mockedAggregateLogs.mockResolvedValue([]);
        await runAggregate({ bucket: "5m", q: "declined" });
        expect(mockedAggregateLogs).toHaveBeenCalledWith(expect.anything(), "5 minutes", undefined);
        expect(mockedAggregateFromRollup).not.toHaveBeenCalled();
        expect(mockedAggregateFromMinuteRollup).not.toHaveBeenCalled();
    });

    it("builds real WHERE conditions (not undefined) when since/until are given", async () => {
        mockedAggregateLogs.mockResolvedValue([]);
        await runAggregate({ since: "2026-07-20T14:00:00Z", until: "2026-07-20T15:00:00Z", bucket: "5m", q: "declined" });
        const [conditions] = mockedAggregateLogs.mock.calls[0]!;
        expect(conditions).toBeDefined();
    });

    it.each([
        ["1m", "1 minute"],
        ["5m", "5 minutes"],
    ])("maps bucket=%s to %s", async (bucket, interval) => {
        mockedAggregateLogs.mockResolvedValue([]);
        await runAggregate({ bucket, q: "declined" });
        expect(mockedAggregateLogs).toHaveBeenCalledWith(expect.anything(), interval, undefined);
    });

    it("wraps the aggregateLogs result in a { buckets } envelope", async () => {
        const rows = [{ start: "2026-07-20T14:00:00Z", group: "checkout", count: 118 }];
        mockedAggregateLogs.mockResolvedValue(rows as any);
        const res = await runAggregate({ bucket: "1m", q: "declined" });
        expect(res).toEqual({ buckets: rows });
    });

    it("returns an empty buckets array when there's no data", async () => {
        mockedAggregateLogs.mockResolvedValue([]);
        const res = await runAggregate({ bucket: "1m", q: "declined" });
        expect(res).toEqual({ buckets: [] });
    });

    it("builds WHERE conditions from filters the same way runQuery does", async () => {
        mockedAggregateLogs.mockResolvedValue([]);
        await runAggregate({ bucket: "1m", service: "checkout", level: "error", q: "declined" });
        const [conditions] = mockedAggregateLogs.mock.calls[0]!;
        expect(conditions).toBeDefined();
    });

    it.each(["1h", "1d"])("falls back to the live scan for bucket=%s when q= is present", async (bucket) => {
        mockedAggregateLogs.mockResolvedValue([]);
        await runAggregate({ bucket, q: "declined" });
        expect(mockedAggregateLogs).toHaveBeenCalled();
        expect(mockedAggregateFromRollup).not.toHaveBeenCalled();
    });

    it.each(["1h", "1d"])("falls back to the live scan for bucket=%s when attr.* is present", async (bucket) => {
        mockedAggregateLogs.mockResolvedValue([]);
        await runAggregate({ bucket, attr: { user_id: "42" } });
        expect(mockedAggregateLogs).toHaveBeenCalled();
        expect(mockedAggregateFromRollup).not.toHaveBeenCalled();
    });
});

describe("runAggregate: live-scan result caching", () => {
    it("serves a second identical query from cache instead of calling aggregateLogs again", async () => {
        const rows = [{ start: "2026-07-20T14:00:00Z", group: null, count: 5 }];
        mockedAggregateLogs.mockResolvedValue(rows as any);

        const first = await runAggregate({ bucket: "1m", q: "declined" });
        const second = await runAggregate({ bucket: "1m", q: "declined" });

        expect(mockedAggregateLogs).toHaveBeenCalledOnce();
        expect(second).toEqual(first);
    });

    it("treats different filters as different cache entries", async () => {
        mockedAggregateLogs.mockResolvedValueOnce([{ start: "x", group: null, count: 1 }] as any);
        mockedAggregateLogs.mockResolvedValueOnce([{ start: "x", group: null, count: 2 }] as any);

        const a = await runAggregate({ bucket: "1m", q: "declined" });
        const b = await runAggregate({ bucket: "1m", q: "timeout" });

        expect(mockedAggregateLogs).toHaveBeenCalledTimes(2);
        expect(a).not.toEqual(b);
    });

    // Reversed from the original design: measured directly under concurrent
    // load on the read replica, an unfiltered shape had a *worse* p95 than
    // the genuinely expensive q=-filtered one — not because it's
    // individually costly, but because every shape queues behind every other
    // one on the replica's single CPU core. Caching it too cuts total query
    // volume reaching Postgres, which is what actually matters here. (At the
    // time this was written bucket=1m with no filter meant the raw scan —
    // it's since gained its own rollup, logs_minute_counts, so this now goes
    // through aggregateFromMinuteRollup instead; the point being tested,
    // that an "already cheap"-looking shape still gets cached, still holds.)
    it("caches a plain minute-rollup query with no q=/attr.* filter too", async () => {
        mockedAggregateFromMinuteRollup.mockResolvedValueOnce([{ start: "x", group: null, count: 1 }] as any);
        mockedAggregateFromMinuteRollup.mockResolvedValueOnce([{ start: "x", group: null, count: 2 }] as any);

        const first = await runAggregate({ bucket: "1m" });
        const second = await runAggregate({ bucket: "1m" });

        expect(mockedAggregateFromMinuteRollup).toHaveBeenCalledOnce();
        expect(second).toEqual(first);
    });

    // Same reversal — the rollup path reads a handful of rows from a small
    // table, genuinely cheap in isolation, but measured at 12.38s p95 under
    // concurrent load purely from queuing on the replica's one core.
    it("caches the rollup fast path too", async () => {
        mockedAggregateFromRollup.mockResolvedValueOnce([{ start: "x", group: null, count: 1 }] as any);
        mockedAggregateFromRollup.mockResolvedValueOnce([{ start: "x", group: null, count: 2 }] as any);

        const first = await runAggregate({ bucket: "1h", since: "2026-07-20T00:00:00Z", until: "2026-07-21T00:00:00Z" });
        const second = await runAggregate({ bucket: "1h", since: "2026-07-20T00:00:00Z", until: "2026-07-21T00:00:00Z" });

        expect(mockedAggregateFromRollup).toHaveBeenCalledOnce();
        expect(second).toEqual(first);
    });
});

// bucket=1m here always predates the real "now" these tests run at by years,
// so liveAggregate.ts's queryLive (checked first for bucket=1m — see
// canUseLive) reliably refuses and falls through to the minute rollup, same
// as the hourly describe block below doesn't need to think about the live
// path at all (canUseLive only ever applies to bucket=1m).
describe("runAggregate: minute-rollup fast path (1m/5m, no q=/attr.*)", () => {
    it.each(["1m", "5m"])("routes bucket=%s straight to aggregateFromMinuteRollup, not aggregateLogs", async (bucket) => {
        mockedAggregateFromMinuteRollup.mockResolvedValue([]);
        await runAggregate({ bucket, since: "2026-07-20T00:00:00Z", until: "2026-07-20T00:05:00Z" });
        expect(mockedAggregateFromMinuteRollup).toHaveBeenCalledOnce();
        expect(mockedAggregateLogs).not.toHaveBeenCalled();
        expect(mockedAggregateFromRollup).not.toHaveBeenCalled();
    });

    it("passes service/level filters and Date-converted since/until through", async () => {
        mockedAggregateFromMinuteRollup.mockResolvedValue([]);
        await runAggregate({
            bucket: "5m",
            service: "checkout",
            level: "error",
            since: "2026-07-20T00:00:00Z",
            until: "2026-07-20T00:05:00Z",
        });
        expect(mockedAggregateFromMinuteRollup).toHaveBeenCalledWith(
            {
                service: "checkout",
                level: "error",
                since: new Date("2026-07-20T00:00:00Z"),
                until: new Date("2026-07-20T00:05:00Z"),
            },
            "5m",
            undefined
        );
    });

    it("passes group_by through untouched", async () => {
        mockedAggregateFromMinuteRollup.mockResolvedValue([]);
        await runAggregate({ bucket: "5m", group_by: "service", since: "2026-07-20T00:00:00Z", until: "2026-07-20T00:05:00Z" });
        expect(mockedAggregateFromMinuteRollup).toHaveBeenCalledWith(expect.anything(), "5m", "service");
    });

    it("wraps the aggregateFromMinuteRollup result in a { buckets } envelope", async () => {
        const rows = [{ start: "2026-07-20T00:00:00Z", group: "checkout", count: 42 }];
        mockedAggregateFromMinuteRollup.mockResolvedValue(rows as any);
        const res = await runAggregate({ bucket: "5m", since: "2026-07-20T00:00:00Z", until: "2026-07-20T00:05:00Z" });
        expect(res).toEqual({ buckets: rows });
    });
});

describe("runAggregate: rollup fast path (1h/1d, no q=/attr.*)", () => {
    it.each(["1h", "1d"])("routes bucket=%s straight to aggregateFromRollup, not aggregateLogs", async (bucket) => {
        mockedAggregateFromRollup.mockResolvedValue([]);
        await runAggregate({ bucket, since: "2026-07-20T00:00:00Z", until: "2026-07-21T00:00:00Z" });
        expect(mockedAggregateFromRollup).toHaveBeenCalledOnce();
        expect(mockedAggregateLogs).not.toHaveBeenCalled();
    });

    it("passes service/level filters and Date-converted since/until through", async () => {
        mockedAggregateFromRollup.mockResolvedValue([]);
        await runAggregate({
            bucket: "1h",
            service: "checkout",
            level: "error",
            since: "2026-07-20T00:00:00Z",
            until: "2026-07-21T00:00:00Z",
        });
        expect(mockedAggregateFromRollup).toHaveBeenCalledWith(
            {
                service: "checkout",
                level: "error",
                since: new Date("2026-07-20T00:00:00Z"),
                until: new Date("2026-07-21T00:00:00Z"),
            },
            "1h",
            undefined
        );
    });

    it("passes group_by through untouched", async () => {
        mockedAggregateFromRollup.mockResolvedValue([]);
        await runAggregate({ bucket: "1h", group_by: "service", since: "2026-07-20T00:00:00Z", until: "2026-07-21T00:00:00Z" });
        expect(mockedAggregateFromRollup).toHaveBeenCalledWith(expect.anything(), "1h", "service");
    });

    it("wraps the aggregateFromRollup result in a { buckets } envelope", async () => {
        const rows = [{ start: "2026-07-20T14:00:00Z", group: "checkout", count: 118 }];
        mockedAggregateFromRollup.mockResolvedValue(rows as any);
        const res = await runAggregate({ bucket: "1h", since: "2026-07-20T00:00:00Z", until: "2026-07-21T00:00:00Z" });
        expect(res).toEqual({ buckets: rows });
    });
});
