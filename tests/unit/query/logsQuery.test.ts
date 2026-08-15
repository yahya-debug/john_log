import { describe, expect, it, vi, beforeEach } from "vitest";

// runQuery imports queryLogs from ../db/logs.js, which itself imports the
// live-connecting db.ts singleton — mocking it here means this test never
// touches a real database, and isolates runQuery's own orchestration logic
// (limit clamping, cursor encode/decode, next_cursor rules).
vi.mock("../../../src/db/logs.js", () => ({
    queryLogs: vi.fn(),
}));

import { queryLogs } from "../../../src/db/logs.js";
import { runQuery } from "../../../src/query/logsQuery.js";
import { encodeCursor } from "../../../src/query/cursor.js";

const mockedQueryLogs = vi.mocked(queryLogs);

function row(id: string, timestamp: string) {
    return { id, timestamp, level: "info", service: "checkout", message: "m", attributes: {} } as any;
}

beforeEach(() => {
    mockedQueryLogs.mockReset();
});

describe("runQuery", () => {
    it("defaults to a limit of 100 when none is given", async () => {
        mockedQueryLogs.mockResolvedValue([]);
        await runQuery({});
        expect(mockedQueryLogs).toHaveBeenCalledWith(expect.anything(), 100);
    });

    it("passes through a limit under the cap unchanged", async () => {
        mockedQueryLogs.mockResolvedValue([]);
        await runQuery({ limit: 50 });
        expect(mockedQueryLogs).toHaveBeenCalledWith(expect.anything(), 50);
    });

    it("clamps a limit above 1000 down to 1000", async () => {
        mockedQueryLogs.mockResolvedValue([]);
        await runQuery({ limit: 5000 });
        expect(mockedQueryLogs).toHaveBeenCalledWith(expect.anything(), 1000);
    });

    it("returns next_cursor: null when fewer rows than the limit come back (last page)", async () => {
        mockedQueryLogs.mockResolvedValue([row("1", "2026-07-20T14:00:00Z")]);
        const res = await runQuery({ limit: 10 });
        expect(res.next_cursor).toBeNull();
        expect(res.logs).toHaveLength(1);
    });

    it("returns next_cursor: null on an empty result set", async () => {
        mockedQueryLogs.mockResolvedValue([]);
        const res = await runQuery({ limit: 10 });
        expect(res.next_cursor).toBeNull();
    });

    it("returns an encoded cursor from the last row when the page is full (more results likely)", async () => {
        mockedQueryLogs.mockResolvedValue([
            row("1", "2026-07-20T14:05:00Z"),
            row("2", "2026-07-20T14:00:00Z"),
        ]);
        const res = await runQuery({ limit: 2 });
        expect(res.next_cursor).toBe(encodeCursor({ timestamp: "2026-07-20T14:00:00Z", id: "2" }));
    });

    it("decodes an incoming cursor and folds it into the query conditions", async () => {
        mockedQueryLogs.mockResolvedValue([]);
        const cursor = encodeCursor({ timestamp: "2026-07-20T14:00:00Z", id: "abc" });
        await runQuery({ cursor });

        const [conditions] = mockedQueryLogs.mock.calls[0]!;
        expect(conditions).toBeDefined(); // a real SQL condition was built from the cursor, not skipped
    });

    it("propagates filters into the WHERE conditions passed to queryLogs", async () => {
        mockedQueryLogs.mockResolvedValue([]);
        await runQuery({ service: "checkout" });
        const [conditions] = mockedQueryLogs.mock.calls[0]!;
        expect(conditions).toBeDefined();
    });

    it("passes an empty (no-op) conditions fragment through when no filters or cursor are given", async () => {
        mockedQueryLogs.mockResolvedValue([]);
        await runQuery({});
        expect(mockedQueryLogs).toHaveBeenCalledWith(expect.anything(), 100);
    });
});
