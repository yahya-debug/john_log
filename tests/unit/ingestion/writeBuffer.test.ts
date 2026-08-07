import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../../src/db/logs.js", () => ({
    insertLogs: vi.fn(),
    upsertHourlyCounts: vi.fn(),
    deadLetterEntries: vi.fn(),
}));
vi.mock("../../../src/db/db.js", () => ({ db: { $client: { begin: vi.fn() } } }));

import { insertLogs, upsertHourlyCounts, deadLetterEntries } from "../../../src/db/logs.js";
import { db } from "../../../src/db/db.js";
import { pushLogs, flushNow } from "../../../src/ingestion/writeBuffer.js";
import type { ValidatedLog } from "../../../src/types/log.js";

const mockedInsertLogs = vi.mocked(insertLogs);
const mockedUpsertHourlyCounts = vi.mocked(upsertHourlyCounts);
const mockedDeadLetterEntries = vi.mocked(deadLetterEntries);
const mockedBegin = vi.mocked(db.$client.begin);

function entry(overrides: Partial<ValidatedLog> = {}): ValidatedLog {
    return { timestamp: new Date().toISOString(), level: "info", service: "svc", message: "m", attributes: {}, ...overrides };
}

beforeEach(() => {
    mockedInsertLogs.mockReset().mockResolvedValue(undefined as any);
    mockedUpsertHourlyCounts.mockReset().mockResolvedValue(undefined as any);
    mockedDeadLetterEntries.mockReset().mockResolvedValue(undefined);
    // Mirrors db.$client.begin's real contract: run the callback against a
    // (fake) transaction-scoped client, propagating whatever it throws.
    mockedBegin.mockReset().mockImplementation((cb: any) => cb({}));
});

describe("writeBuffer flush", () => {
    it("does not dead-letter when the flush transaction succeeds", async () => {
        pushLogs([entry({ service: "flush-ok" })]);
        await flushNow();

        expect(mockedInsertLogs).toHaveBeenCalledOnce();
        expect(mockedUpsertHourlyCounts).toHaveBeenCalledOnce();
        expect(mockedDeadLetterEntries).not.toHaveBeenCalled();
    });

    it("dead-letters the whole batch, with the error message as reason, when insertLogs fails", async () => {
        mockedInsertLogs.mockRejectedValueOnce(new Error("insert boom"));

        pushLogs([entry({ service: "dl-insert" }), entry({ service: "dl-insert" })]);
        await flushNow();

        expect(mockedDeadLetterEntries).toHaveBeenCalledOnce();
        const [entries, reason] = mockedDeadLetterEntries.mock.calls[0]!;
        expect(entries).toHaveLength(2);
        expect(entries.every((e) => e.service === "dl-insert")).toBe(true);
        expect(reason).toBe("insert boom");
    });

    it("dead-letters the batch when upsertHourlyCounts fails, even though insertLogs itself succeeded", async () => {
        mockedUpsertHourlyCounts.mockRejectedValueOnce(new Error("rollup boom"));

        pushLogs([entry({ service: "dl-rollup" })]);
        await flushNow();

        expect(mockedDeadLetterEntries).toHaveBeenCalledOnce();
        const [, reason] = mockedDeadLetterEntries.mock.calls[0]!;
        expect(reason).toBe("rollup boom");
    });

    it("logs loudly and drops the batch (without throwing) if the dead-letter insert itself also fails", async () => {
        mockedInsertLogs.mockRejectedValueOnce(new Error("insert boom"));
        mockedDeadLetterEntries.mockRejectedValueOnce(new Error("dead-letter insert failed too"));
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        pushLogs([entry({ service: "dl-both-fail" })]);
        await expect(flushNow()).resolves.toBeUndefined();

        expect(mockedDeadLetterEntries).toHaveBeenCalledOnce();
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("flush AND dead-letter both failed"),
            expect.anything(),
            expect.anything()
        );
        errorSpy.mockRestore();
    });
});
