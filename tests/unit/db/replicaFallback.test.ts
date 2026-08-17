import { describe, expect, it, vi } from "vitest";
import { isConnectionError, withFallback } from "../../../src/db/replicaFallback.js";

function connectionError(code: string) {
    return Object.assign(new Error(`connection failed: ${code}`), { code });
}

describe("isConnectionError", () => {
    it.each(["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "57P01", "57P02", "57P03"])(
        "treats %s as a connection error",
        (code) => {
            expect(isConnectionError(connectionError(code))).toBe(true);
        }
    );

    // Confirmed directly against the real stack under heavier concurrent load
    // (a real benchmark run with a 4-CPU generator): the replica's TCP port
    // was already open before Postgres itself finished recovery, so the
    // connection succeeded at the network level and Postgres responded with
    // its own "not ready" error instead — a genuine PostgresError, not a
    // Node network error, and previously not caught at all.
    it("treats Postgres's own 'database system is starting up' (57P03) as a connection error", () => {
        const err = Object.assign(new Error("the database system is starting up"), {
            code: "57P03",
            severity: "FATAL",
            routine: "ProcessStartupPacket",
        });
        expect(isConnectionError(err)).toBe(true);
    });

    it("does not treat a real Postgres error code as a connection error", () => {
        expect(isConnectionError(Object.assign(new Error("syntax error"), { code: "42601" }))).toBe(false);
    });

    it("handles non-object/non-error values without throwing", () => {
        expect(isConnectionError(undefined)).toBe(false);
        expect(isConnectionError("plain string")).toBe(false);
        expect(isConnectionError(null)).toBe(false);
    });

    // Confirmed directly against the real stack: drizzle-orm's .execute() (used
    // by db/stats.ts) wraps the real connection error one level deeper as
    // Error.cause, with no .code on the top-level error at all — a top-level-only
    // check silently missed this and the fallback never triggered.
    it("finds a connection error nested one level down in .cause", () => {
        const wrapped = new Error("Failed query");
        (wrapped as any).cause = connectionError("ENOTFOUND");
        expect(isConnectionError(wrapped)).toBe(true);
    });

    it("finds a connection error nested several levels down in .cause", () => {
        let err: Error = connectionError("ECONNREFUSED");
        for (let i = 0; i < 3; i++) {
            const outer = new Error(`wrapper ${i}`);
            (outer as any).cause = err;
            err = outer;
        }
        expect(isConnectionError(err)).toBe(true);
    });

    it("does not loop forever on a circular .cause chain", () => {
        const a: any = new Error("a");
        const b: any = new Error("b");
        a.cause = b;
        b.cause = a;
        expect(isConnectionError(a)).toBe(false);
    });

    it("does not fall back when .cause is a real query error, not a connection one", () => {
        const wrapped = new Error("Failed query");
        (wrapped as any).cause = Object.assign(new Error("syntax error"), { code: "42601" });
        expect(isConnectionError(wrapped)).toBe(false);
    });
});

describe("withFallback", () => {
    it("returns the primary's result without calling the fallback", async () => {
        const primary = vi.fn().mockResolvedValue("primary-result");
        const fallback = vi.fn().mockResolvedValue("fallback-result");

        await expect(withFallback(primary, fallback)).resolves.toBe("primary-result");
        expect(fallback).not.toHaveBeenCalled();
    });

    it("retries via the fallback on a connection error", async () => {
        const primary = vi.fn().mockRejectedValue(connectionError("ECONNREFUSED"));
        const fallback = vi.fn().mockResolvedValue("fallback-result");

        await expect(withFallback(primary, fallback)).resolves.toBe("fallback-result");
        expect(fallback).toHaveBeenCalledTimes(1);
    });

    it("does not call the fallback on a non-connection error — it propagates", async () => {
        const queryErr = Object.assign(new Error("syntax error"), { code: "42601" });
        const primary = vi.fn().mockRejectedValue(queryErr);
        const fallback = vi.fn();

        await expect(withFallback(primary, fallback)).rejects.toThrow("syntax error");
        expect(fallback).not.toHaveBeenCalled();
    });

    it("propagates the fallback's own error if it also fails", async () => {
        const primary = vi.fn().mockRejectedValue(connectionError("ECONNREFUSED"));
        const fallback = vi.fn().mockRejectedValue(new Error("primary is down too"));

        await expect(withFallback(primary, fallback)).rejects.toThrow("primary is down too");
    });
});
