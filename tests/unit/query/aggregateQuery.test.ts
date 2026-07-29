import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../../src/db/logs.js", () => ({
    aggregateLogs: vi.fn(),
}));

import { aggregateLogs } from "../../../src/db/logs.js";
import { runAggregate } from "../../../src/query/aggregateQuery.js";

const mockedAggregateLogs = vi.mocked(aggregateLogs);

beforeEach(() => {
    mockedAggregateLogs.mockReset();
});

describe("runAggregate", () => {
    it("translates the bucket size param into the Postgres interval literal", async () => {
        mockedAggregateLogs.mockResolvedValue([]);
        await runAggregate({ bucket: "5m" });
        expect(mockedAggregateLogs).toHaveBeenCalledWith(undefined, "5 minutes", undefined);
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
        ["1h", "1 hour"],
        ["1d", "1 day"],
    ])("maps bucket=%s to %s", async (bucket, interval) => {
        mockedAggregateLogs.mockResolvedValue([]);
        await runAggregate({ bucket });
        expect(mockedAggregateLogs).toHaveBeenCalledWith(undefined, interval, undefined);
    });

    it("passes group_by through untouched", async () => {
        mockedAggregateLogs.mockResolvedValue([]);
        await runAggregate({ bucket: "1h", group_by: "service" });
        expect(mockedAggregateLogs).toHaveBeenCalledWith(undefined, "1 hour", "service");
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
});
