import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../../src/db/logs.js", () => ({
    aggregateLogs: vi.fn(),
    aggregateFromRollup: vi.fn(),
}));

import { aggregateLogs, aggregateFromRollup } from "../../../src/db/logs.js";
import { runAggregate } from "../../../src/query/aggregateQuery.js";

const mockedAggregateLogs = vi.mocked(aggregateLogs);
const mockedAggregateFromRollup = vi.mocked(aggregateFromRollup);

beforeEach(() => {
    mockedAggregateLogs.mockReset();
    mockedAggregateFromRollup.mockReset();
});

// bucket=1h/1d with no q=/attr.* filter routes to the logs_hourly_counts rollup
// (src/db/logs.ts's aggregateFromRollup) instead of scanning `logs` directly — see
// src/query/aggregateQuery.ts's canUseRollup. Everything else (finer buckets, or a
// q=/attr filter present) keeps using the live scan (aggregateLogs), unchanged.
describe("runAggregate: live scan path (1m/5m, or any bucket with q=/attr.*)", () => {
    it("translates the bucket size param into the Postgres interval literal", async () => {
        mockedAggregateLogs.mockResolvedValue([]);
        await runAggregate({ bucket: "5m" });
        expect(mockedAggregateLogs).toHaveBeenCalledWith(undefined, "5 minutes", undefined);
        expect(mockedAggregateFromRollup).not.toHaveBeenCalled();
    });

    it("builds real WHERE conditions (not undefined) when since/until are given", async () => {
        mockedAggregateLogs.mockResolvedValue([]);
        await runAggregate({ since: "2026-07-20T14:00:00Z", until: "2026-07-20T15:00:00Z", bucket: "5m" });
        const [conditions] = mockedAggregateLogs.mock.calls[0]!;
        expect(conditions).toBeDefined();
    });

    it.each([
        ["1m", "1 minute"],
        ["5m", "5 minutes"],
    ])("maps bucket=%s to %s", async (bucket, interval) => {
        mockedAggregateLogs.mockResolvedValue([]);
        await runAggregate({ bucket });
        expect(mockedAggregateLogs).toHaveBeenCalledWith(undefined, interval, undefined);
    });

    it("wraps the aggregateLogs result in a { buckets } envelope", async () => {
        const rows = [{ start: "2026-07-20T14:00:00Z", group: "checkout", count: 118 }];
        mockedAggregateLogs.mockResolvedValue(rows as any);
        const res = await runAggregate({ bucket: "1m" });
        expect(res).toEqual({ buckets: rows });
    });

    it("returns an empty buckets array when there's no data", async () => {
        mockedAggregateLogs.mockResolvedValue([]);
        const res = await runAggregate({ bucket: "1m" });
        expect(res).toEqual({ buckets: [] });
    });

    it("builds WHERE conditions from filters the same way runQuery does", async () => {
        mockedAggregateLogs.mockResolvedValue([]);
        await runAggregate({ bucket: "1m", service: "checkout", level: "error" });
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
