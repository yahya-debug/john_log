import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { recordAccepted, queryLive, resetLiveAggregate } from "../../../src/query/liveAggregate.js";
import { ValidatedLog } from "../../../src/types/log.js";

function log(overrides: Partial<ValidatedLog> = {}): ValidatedLog {
    return {
        timestamp: new Date().toISOString(),
        level: "info",
        service: "checkout",
        message: "ok",
        ...overrides,
    };
}

// liveAggregate.ts's trackerStartedAt is captured once, at real module-import
// time — before any test here runs — and queryLive refuses a `since` older
// than that moment (see "returns null ... process start" below). Without
// this, a test's own "now - 60s" would race against however long module
// import actually took: fast enough in practice that since ends up *before*
// trackerStartedAt, tripping the guard for what should be an ordinary
// "last 60 seconds" query. Jumping fake time a safe margin forward first
// means every test's "now" is comfortably past that boundary instead.
const SAFE_MARGIN_MS = 5 * 60_000;

beforeEach(() => {
    resetLiveAggregate();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SAFE_MARGIN_MS);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("recordAccepted / queryLive", () => {
    it("counts an accepted entry into a single summed bucket when no group_by is given", () => {
        const now = new Date();
        recordAccepted([log({ timestamp: now.toISOString() })]);

        const rows = queryLive({ since: new Date(now.getTime() - 60_000), until: new Date(now.getTime() + 60_000) });

        expect(rows).toEqual([{ start: expect.any(String), group: null, count: 1 }]);
    });

    it("groups by service when asked, same as aggregateLogs's group_by=service", () => {
        const now = new Date();
        recordAccepted([
            log({ service: "checkout", timestamp: now.toISOString() }),
            log({ service: "checkout", timestamp: now.toISOString() }),
            log({ service: "billing", timestamp: now.toISOString() }),
        ]);

        const rows = queryLive({
            since: new Date(now.getTime() - 60_000),
            until: new Date(now.getTime() + 60_000),
            groupBy: "service",
        });

        expect(rows).toEqual(expect.arrayContaining([
            { start: expect.any(String), group: "checkout", count: 2 },
            { start: expect.any(String), group: "billing", count: 1 },
        ]));
    });

    it("groups by level when asked", () => {
        const now = new Date();
        recordAccepted([
            log({ level: "error", timestamp: now.toISOString() }),
            log({ level: "error", timestamp: now.toISOString() }),
            log({ level: "info", timestamp: now.toISOString() }),
        ]);

        const rows = queryLive({
            since: new Date(now.getTime() - 60_000),
            until: new Date(now.getTime() + 60_000),
            groupBy: "level",
        });

        expect(rows).toEqual(expect.arrayContaining([
            { start: expect.any(String), group: "error", count: 2 },
            { start: expect.any(String), group: "info", count: 1 },
        ]));
    });

    it("applies service/level as equality filters, same as commandCondition's plain filters", () => {
        const now = new Date();
        recordAccepted([
            log({ service: "checkout", level: "error", timestamp: now.toISOString() }),
            log({ service: "checkout", level: "info", timestamp: now.toISOString() }),
            log({ service: "billing", level: "error", timestamp: now.toISOString() }),
        ]);

        const rows = queryLive({
            since: new Date(now.getTime() - 60_000),
            until: new Date(now.getTime() + 60_000),
            service: "checkout",
            level: "error",
        });

        expect(rows).toEqual([{ start: expect.any(String), group: null, count: 1 }]);
    });

    it("keeps separate minute buckets separate, sorted ascending by start", () => {
        const now = new Date();
        const twoMinAgo = new Date(now.getTime() - 2 * 60_000);
        recordAccepted([log({ timestamp: twoMinAgo.toISOString() })]);
        recordAccepted([log({ timestamp: now.toISOString() })]);

        const rows = queryLive({ since: new Date(now.getTime() - 5 * 60_000), until: new Date(now.getTime() + 60_000) });

        expect(rows).toHaveLength(2);
        expect(new Date(rows![0]!.start).getTime()).toBeLessThan(new Date(rows![1]!.start).getTime());
    });

    it("returns [] (not null) for an in-window query that genuinely matches nothing — a real answer, not a refusal", () => {
        const now = new Date();
        recordAccepted([log({ service: "checkout", timestamp: now.toISOString() })]);

        const rows = queryLive({
            since: new Date(now.getTime() - 60_000),
            until: new Date(now.getTime() + 60_000),
            service: "some-other-service",
        });

        expect(rows).toEqual([]);
    });

    it("returns null (not []) when since reaches further back than retention/process start", () => {
        const now = new Date();
        recordAccepted([log({ timestamp: now.toISOString() })]);

        const rows = queryLive({ since: new Date(now.getTime() - 60 * 60_000), until: new Date(now.getTime() + 60_000) });

        expect(rows).toBeNull();
    });

    // Without this, an invalid Date compares false against everything (NaN < x
    // and NaN >= x are both always false), which would silently filter every
    // bucket out and return a deceptive-looking [] instead of admitting
    // "can't answer this" — the exact failure this function exists to avoid.
    it("returns null for an unparseable since or until instead of silently matching nothing", () => {
        const now = new Date();
        expect(queryLive({ since: new Date(NaN), until: new Date(now.getTime() + 60_000) })).toBeNull();
        expect(queryLive({ since: new Date(now.getTime() - 60_000), until: new Date(NaN) })).toBeNull();
    });
});

describe("retention boundary", () => {
    it("still answers a since exactly at the edge of the retention window", () => {
        const start = Date.now();
        recordAccepted([log({ timestamp: new Date(start).toISOString() })]);

        // Just inside the 15-minute window this module retains.
        vi.setSystemTime(start + 10 * 60_000);
        const rows = queryLive({ since: new Date(start), until: new Date(start + 60_000) });

        expect(rows).toEqual([{ start: expect.any(String), group: null, count: 1 }]);
    });

    it("refuses (null) once since falls outside the retention window", () => {
        const start = Date.now();
        recordAccepted([log({ timestamp: new Date(start).toISOString() })]);

        // Past the 15-minute window — a fresh record() call (even an empty
        // one) is what actually runs prune() and drops the old bucket.
        vi.setSystemTime(start + 20 * 60_000);
        recordAccepted([]);

        const rows = queryLive({ since: new Date(start), until: new Date(start + 60_000) });

        expect(rows).toBeNull();
    });
});
