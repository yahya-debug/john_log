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

describe("writeBuffer admission control", () => {
    it("admits a batch and reports admitted: true when there's room", async () => {
        await expect(pushLogs([entry()])).resolves.toEqual({ admitted: true });
        await flushNow(); // drain so it doesn't count toward later tests' buffer state
    });

    it("rejects a batch with admitted: false + retryAfterSec when it would overflow a non-empty buffer", async () => {
        // WRITE_BUFFER_MAX_SIZE defaults to 50_000 — get something already
        // sitting in the buffer, then ask for more than the remaining room.
        await pushLogs(Array.from({ length: 5 }, () => entry()));

        const result = await pushLogs(Array.from({ length: 50_000 }, () => entry()));

        expect(result).toEqual({ admitted: false, retryAfterSec: expect.any(Number) });
        await flushNow();
    });

    it("still admits a single batch larger than the cap when the buffer is currently empty", async () => {
        // Otherwise one legitimately large request could never be admitted at all.
        await flushNow(); // ensure empty first
        const result = await pushLogs(Array.from({ length: 50_001 }, () => entry()));

        expect(result).toEqual({ admitted: true });
        await flushNow();
    });
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
