import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { and } from "drizzle-orm";
import { commandCondition, combineConditions } from "../../../src/query/filters.js";

// commandCondition/combineConditions build drizzle SQL objects, not raw
// strings — rendering them through the real Postgres dialect (without a live
// connection) is how we assert on the actual query text/params drizzle would
// send, which is what actually matters for both correctness and injection
// safety.
const dialect = new PgDialect();
function render(query: Parameters<typeof commandCondition>[0]) {
    const combined = combineConditions(commandCondition(query));
    return combined ? dialect.sqlToQuery(combined) : undefined;
}

describe("commandCondition / combineConditions", () => {
    it("returns undefined (no WHERE clause) for an empty query", () => {
        expect(render({})).toBeUndefined();
    });

    it("builds an exact-match condition for service", () => {
        const { sql, params } = render({ service: "checkout" })!;
        expect(sql).toBe('"logs"."service" = $1');
        expect(params).toEqual(["checkout"]);
    });

    it("builds an exact-match condition for level", () => {
        const { sql, params } = render({ level: "error" })!;
        expect(sql).toBe('"logs"."level" = $1');
        expect(params).toEqual(["error"]);
    });

    it("builds since as inclusive (>=) and until as exclusive (<)", () => {
        const { sql, params } = render({ since: "2026-07-20T14:00:00Z", until: "2026-07-20T15:00:00Z" })!;
        expect(sql).toBe('("logs"."timestamp" >= $1 and "logs"."timestamp" < $2)');
        expect(params).toEqual(["2026-07-20T14:00:00.000Z", "2026-07-20T15:00:00.000Z"]);
    });

    it("builds a case-insensitive substring match via LIKE against the precomputed message_lower column, parameterized (not string-concatenated)", () => {
        const { sql, params } = render({ q: "declined" })!;
        expect(sql).toBe('"logs"."message_lower" LIKE $1');
        expect(params).toEqual(["%declined%"]);
    });

    it("lowercases q itself so case-insensitivity holds against the lowercased column", () => {
        const { sql, params } = render({ q: "DeClInEd" })!;
        expect(sql).toBe('"logs"."message_lower" LIKE $1');
        expect(params).toEqual(["%declined%"]);
    });

    it("parameterizes q even when it contains SQL metacharacters", () => {
        const { sql, params } = render({ q: "'; DROP TABLE logs; --" })!;
        expect(sql).toBe('"logs"."message_lower" LIKE $1');
        expect(params).toEqual(["%'; drop table logs; --%"]);
    });

    it("builds an attribute containment check for a single attr.<key>", () => {
        const { sql, params } = render({ attr: { user_id: "42" } })!;
        expect(sql).toBe('"logs"."attributes" @> $1::jsonb');
        expect(params).toEqual([JSON.stringify({ user_id: "42" })]);
    });

    it("builds one containment check per attribute, ANDed together", () => {
        const { sql, params } = render({ attr: { user_id: "42", region: "eu-west" } })!;
        expect(sql).toBe('("logs"."attributes" @> $1::jsonb and "logs"."attributes" @> $2::jsonb)');
        expect(params).toEqual([
            JSON.stringify({ user_id: "42" }),
            JSON.stringify({ region: "eu-west" }),
        ]);
    });

    it("ANDs every provided filter together, in a stable order", () => {
        const { sql, params } = render({
            service: "checkout",
            level: "error",
            since: "2026-07-20T14:00:00Z",
            q: "declined",
        })!;
        expect(sql).toBe(
            '("logs"."service" = $1 and "logs"."level" = $2 and "logs"."timestamp" >= $3 and "logs"."message_lower" LIKE $4)'
        );
        expect(params).toEqual(["checkout", "error", "2026-07-20T14:00:00.000Z", "%declined%"]);
    });

    it("ignores until with no since (still builds a valid < condition, no crash)", () => {
        const { sql, params } = render({ until: "2026-07-20T15:00:00Z" })!;
        expect(sql).toBe('"logs"."timestamp" < $1');
        expect(params).toEqual(["2026-07-20T15:00:00.000Z"]);
    });
});

describe("combineConditions", () => {
    it("returns undefined for an empty condition list", () => {
        expect(combineConditions([])).toBeUndefined();
    });

    it("matches drizzle's own and(...) for a single condition (no redundant wrapping)", () => {
        const conditions = commandCondition({ service: "checkout" });
        const combined = combineConditions(conditions);
        const expected = and(...conditions);
        expect(dialect.sqlToQuery(combined!)).toEqual(dialect.sqlToQuery(expected!));
    });
});
