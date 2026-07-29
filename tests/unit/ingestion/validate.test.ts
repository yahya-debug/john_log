import { describe, expect, it } from "vitest";
import { validateEntry, validateBatch, isStale } from "../../../src/ingestion/validate.js";
import { Env } from "../../../src/config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("validateEntry", () => {
    it("accepts a well-formed entry and normalizes attribute values to strings", () => {
        const res = validateEntry({
            timestamp: "2026-07-20T14:32:01.123Z",
            level: "error",
            service: "checkout",
            message: "payment declined",
            attributes: { user_id: "42", retries: 3, ok: false },
        });

        expect(res.valid).toBe(true);
        expect((res as any).data).toEqual({
            timestamp: "2026-07-20T14:32:01.123Z",
            level: "error",
            service: "checkout",
            message: "payment declined",
            attributes: { user_id: "42", retries: "3", ok: "false" },
        });
    });

    it("defaults attributes to an empty object when omitted", () => {
        const res = validateEntry({
            timestamp: "2026-07-20T14:32:01.123Z",
            level: "info",
            service: "checkout",
            message: "ok",
        });

        expect(res.valid).toBe(true);
        expect((res as any).data.attributes).toEqual({});
    });

    it("rejects a non-object entry", () => {
        const res = validateEntry("not an object");
        expect(res.valid).toBe(false);
        expect((res as any).reason).toMatch(/object/);
    });

    it("rejects an unparseable timestamp", () => {
        const res = validateEntry({ timestamp: "not-a-date", level: "info", service: "a", message: "m" });
        expect(res.valid).toBe(false);
        expect((res as any).reason).toMatch(/timestamp/i);
    });

    it("rejects a timestamp more than 5 minutes in the future", () => {
        const future = new Date(Date.now() + 6 * 60 * 1000).toISOString();
        const res = validateEntry({ timestamp: future, level: "info", service: "a", message: "m" });
        expect(res.valid).toBe(false);
        expect((res as any).reason).toMatch(/future/);
    });

    it("accepts a timestamp exactly at the 5 minute boundary in the past", () => {
        const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const res = validateEntry({ timestamp: past, level: "info", service: "a", message: "m" });
        expect(res.valid).toBe(true);
    });

    it("rejects an unknown level", () => {
        const res = validateEntry({ timestamp: new Date().toISOString(), level: "critical", service: "a", message: "m" });
        expect(res.valid).toBe(false);
        expect((res as any).reason).toMatch(/level/i);
    });

    it("rejects an empty service", () => {
        const res = validateEntry({ timestamp: new Date().toISOString(), level: "info", service: "   ", message: "m" });
        expect(res.valid).toBe(false);
    });

    it("rejects an empty message", () => {
        const res = validateEntry({ timestamp: new Date().toISOString(), level: "info", service: "a", message: "" });
        expect(res.valid).toBe(false);
    });

    it("rejects attributes that aren't a flat object", () => {
        const res = validateEntry({
            timestamp: new Date().toISOString(),
            level: "info",
            service: "a",
            message: "m",
            attributes: { nested: { a: 1 } },
        });
        expect(res.valid).toBe(false);
        expect((res as any).reason).toMatch(/flat object/);
    });

    it("rejects attributes given as an array", () => {
        const res = validateEntry({
            timestamp: new Date().toISOString(),
            level: "info",
            service: "a",
            message: "m",
            attributes: [1, 2, 3],
        });
        expect(res.valid).toBe(false);
    });

    it("rejects attributes given as a non-object primitive", () => {
        const res = validateEntry({
            timestamp: new Date().toISOString(),
            level: "info",
            service: "a",
            message: "m",
            attributes: "nope",
        });
        expect(res.valid).toBe(false);
    });

    it("rejects a timestamp older than the retention window", () => {
        const stale = new Date(Date.now() - (Env.RETENTION_DAYS + 1) * DAY_MS).toISOString();
        const res = validateEntry({ timestamp: stale, level: "info", service: "a", message: "m" });
        expect(res.valid).toBe(false);
        expect((res as any).reason).toMatch(/retention window/);
    });

    it("accepts a timestamp just within the retention window", () => {
        const fresh = new Date(Date.now() - (Env.RETENTION_DAYS - 1) * DAY_MS).toISOString();
        const res = validateEntry({ timestamp: fresh, level: "info", service: "a", message: "m" });
        expect(res.valid).toBe(true);
    });

    it("accepts a stale timestamp when allowStale is set (admin backfill path)", () => {
        const stale = new Date(Date.now() - (Env.RETENTION_DAYS + 10) * DAY_MS).toISOString();
        const res = validateEntry({ timestamp: stale, level: "info", service: "a", message: "m" }, { allowStale: true });
        expect(res.valid).toBe(true);
    });

    it("still rejects a future timestamp even with allowStale set", () => {
        const future = new Date(Date.now() + 6 * 60 * 1000).toISOString();
        const res = validateEntry({ timestamp: future, level: "info", service: "a", message: "m" }, { allowStale: true });
        expect(res.valid).toBe(false);
        expect((res as any).reason).toMatch(/future/);
    });
});

describe("isStale", () => {
    it("is false for a timestamp well within the retention window", () => {
        expect(isStale(new Date(Date.now() - 5 * DAY_MS))).toBe(false);
    });

    it("is true for a timestamp older than the retention window", () => {
        expect(isStale(new Date(Date.now() - (Env.RETENTION_DAYS + 1) * DAY_MS))).toBe(true);
    });

    it("is false for the current moment", () => {
        expect(isStale(new Date())).toBe(false);
    });

    it("accepts an ISO string the same way it accepts a Date", () => {
        const iso = new Date(Date.now() - (Env.RETENTION_DAYS + 1) * DAY_MS).toISOString();
        expect(isStale(iso)).toBe(true);
    });
});

describe("validateBatch", () => {
    it("splits a batch into accepted entries and rejected entries with their original index", () => {
        const { accepted, rejected } = validateBatch([
            { timestamp: new Date().toISOString(), level: "info", service: "a", message: "ok" },
            { timestamp: new Date().toISOString(), level: "critical", service: "a", message: "bad level" },
            { timestamp: new Date().toISOString(), level: "warn", service: "a", message: "ok too" },
        ]);

        expect(accepted).toHaveLength(2);
        expect(rejected).toEqual([{ index: 1, reason: expect.stringMatching(/level/i) }]);
    });

    it("returns empty accepted/rejected for an empty batch", () => {
        expect(validateBatch([])).toEqual({ accepted: [], rejected: [] });
    });

    it("rejects a stale entry by default, but accepts it when allowStale is passed through", () => {
        const stale = new Date(Date.now() - (Env.RETENTION_DAYS + 1) * DAY_MS).toISOString();
        const entry = { timestamp: stale, level: "info", service: "a", message: "old" };

        const normal = validateBatch([entry]);
        expect(normal.accepted).toHaveLength(0);
        expect(normal.rejected[0]?.reason).toMatch(/retention window/);

        const backfill = validateBatch([entry], { allowStale: true });
        expect(backfill.accepted).toHaveLength(1);
        expect(backfill.rejected).toHaveLength(0);
    });

    it("never lets one bad entry drop the whole batch", () => {
        const { accepted, rejected } = validateBatch([
            { timestamp: "garbage", level: "info", service: "a", message: "m" },
        ]);
        expect(accepted).toHaveLength(0);
        expect(rejected).toHaveLength(1);
    });
});
