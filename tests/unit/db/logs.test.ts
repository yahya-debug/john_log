import { describe, expect, it, vi, beforeEach } from "vitest";
import { withFallback } from "../../../src/db/replicaFallback.js";

// queryLogs (src/db/logs.ts) reads via withReplicaFallback (src/db/db.ts),
// falling back to db.$client (the primary) only on a connection-level
// failure. withFallback's own logic has direct unit coverage in
// replicaFallback.test.ts; this test mocks db.js's readClient/db.$client and
// wires withReplicaFallback to the real (untested-here) withFallback, so it
// exercises queryLogs's actual integration with the fallback mechanism
// without needing a live Postgres connection at all.
const mockReadClient = vi.fn();
const mockWriteClient = vi.fn();

vi.mock("../../../src/db/db.js", () => ({
    db: { $client: (...args: unknown[]) => mockWriteClient(...args) },
    readClient: (...args: unknown[]) => mockReadClient(...args),
    withReplicaFallback: (run: (client: unknown) => Promise<unknown>) =>
        withFallback(
            () => run((...args: unknown[]) => mockReadClient(...args)),
            () => run((...args: unknown[]) => mockWriteClient(...args))
        ),
}));

import { queryLogs } from "../../../src/db/logs.js";

function connectionError(code: string) {
    return Object.assign(new Error(`connection failed: ${code}`), { code });
}

beforeEach(() => {
    mockReadClient.mockReset();
    mockWriteClient.mockReset();
});

describe("queryLogs replica fallback", () => {
    it("reads from the replica when it's reachable, never touching the primary", async () => {
        mockReadClient.mockResolvedValue([{ id: "1", message: "from-replica" }]);

        const rows = await queryLogs({} as any, 10);

        expect(rows).toEqual([{ id: "1", message: "from-replica" }]);
        expect(mockWriteClient).not.toHaveBeenCalled();
    });

    it("falls back to the primary on ECONNREFUSED", async () => {
        mockReadClient.mockRejectedValue(connectionError("ECONNREFUSED"));
        mockWriteClient.mockResolvedValue([{ id: "2", message: "from-primary" }]);

        const rows = await queryLogs({} as any, 10);

        expect(rows).toEqual([{ id: "2", message: "from-primary" }]);
        expect(mockWriteClient).toHaveBeenCalledTimes(1);
    });

    it("does NOT fall back on a real query error — that propagates unchanged", async () => {
        // A genuine Postgres error (bad syntax, not a connection problem) — falling
        // back here would silently retry the same broken query against the primary
        // and mask the real bug instead of surfacing it.
        const queryErr = Object.assign(new Error("syntax error at or near"), { code: "42601" });
        mockReadClient.mockRejectedValue(queryErr);

        await expect(queryLogs({} as any, 10)).rejects.toThrow("syntax error");
        expect(mockWriteClient).not.toHaveBeenCalled();
    });

    it("propagates the primary's own error if the fallback query also fails", async () => {
        mockReadClient.mockRejectedValue(connectionError("ECONNREFUSED"));
        const primaryErr = new Error("primary is down too");
        mockWriteClient.mockRejectedValue(primaryErr);

        await expect(queryLogs({} as any, 10)).rejects.toThrow("primary is down too");
    });
});
