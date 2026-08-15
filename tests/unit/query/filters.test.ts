import { describe, expect, it } from "vitest";
import { commandCondition, combineConditions } from "../../../src/query/filters.js";

// commandCondition/combineConditions build postgres.js sql Fragments now, not
// drizzle SQL objects — a Fragment is just its template `.strings` (raw literal
// pieces) and `.args` (interpolated values), set synchronously by the tag call, so
// walking them gives us the real query text/params postgres.js would send without
// needing a live connection. This mirrors (a simplified version of) what
// postgres.js's own stringify/fragment internals do when the outer query actually
// runs — see query/filters.ts's header comment.
function isFragmentish(val: unknown): boolean {
    return (
        (!!val && typeof val === "object" && "strings" in val && "args" in val) ||
        (Array.isArray(val) && val.length > 0 && isFragmentish(val[0]))
    );
}

function render(node: any, params: unknown[]): string {
    if (Array.isArray(node)) return node.map((n) => render(n, params)).join("");

    let out = node.strings[0];
    for (let i = 0; i < node.args.length; i++) {
        const val = node.args[i];
        out += isFragmentish(val) ? render(val, params) : (params.push(val), `$${params.length}`);
        out += node.strings[i + 1];
    }
    return out;
}

function query(q: Parameters<typeof commandCondition>[0]) {
    const params: unknown[] = [];
    const sql = render(combineConditions(commandCondition(q)), params);
    return { sql, params };
}

describe("commandCondition / combineConditions", () => {
    it("returns an empty fragment (no WHERE clause) for an empty query", () => {
        expect(query({}).sql).toBe("");
    });

    it("builds an exact-match condition for service", () => {
        const { sql, params } = query({ service: "checkout" });
        expect(sql).toBe("WHERE service = $1");
        expect(params).toEqual(["checkout"]);
    });

    it("builds an exact-match condition for level", () => {
        const { sql, params } = query({ level: "error" });
        expect(sql).toBe("WHERE level = $1");
        expect(params).toEqual(["error"]);
    });

    it("builds since as inclusive (>=) and until as exclusive (<)", () => {
        const { sql, params } = query({ since: "2026-07-20T14:00:00Z", until: "2026-07-20T15:00:00Z" });
        expect(sql).toBe("WHERE timestamp >= $1 AND timestamp < $2");
        expect(params).toEqual(["2026-07-20T14:00:00.000Z", "2026-07-20T15:00:00.000Z"]);
    });

    it("builds a case-insensitive substring match via LIKE against the precomputed message_lower column, parameterized (not string-concatenated)", () => {
        const { sql, params } = query({ q: "declined" });
        expect(sql).toBe("WHERE message_lower LIKE $1");
        expect(params).toEqual(["%declined%"]);
    });

    it("lowercases q itself so case-insensitivity holds against the lowercased column", () => {
        const { sql, params } = query({ q: "DeClInEd" });
        expect(sql).toBe("WHERE message_lower LIKE $1");
        expect(params).toEqual(["%declined%"]);
    });

    it("parameterizes q even when it contains SQL metacharacters", () => {
        const { sql, params } = query({ q: "'; DROP TABLE logs; --" });
        expect(sql).toBe("WHERE message_lower LIKE $1"); // the SQL skeleton never changes shape...
        expect(params).toEqual(["%'; drop table logs; --%"]); // ...the dangerous text is only ever a parameter value
    });

    it("builds an attribute containment check for a single attr.<key>", () => {
        const { sql, params } = query({ attr: { user_id: "42" } });
        expect(sql).toBe("WHERE attributes @> $1::jsonb");
        expect(params).toEqual([JSON.stringify({ user_id: "42" })]);
    });

    it("builds one containment check per attribute, ANDed together", () => {
        const { sql, params } = query({ attr: { user_id: "42", region: "eu-west" } });
        expect(sql).toBe("WHERE attributes @> $1::jsonb AND attributes @> $2::jsonb");
        expect(params).toEqual([
            JSON.stringify({ user_id: "42" }),
            JSON.stringify({ region: "eu-west" }),
        ]);
    });

    it("ANDs every provided filter together, in a stable order", () => {
        const { sql, params } = query({
            service: "checkout",
            level: "error",
            since: "2026-07-20T14:00:00Z",
            q: "declined",
        });
        expect(sql).toBe("WHERE service = $1 AND level = $2 AND timestamp >= $3 AND message_lower LIKE $4");
        expect(params).toEqual(["checkout", "error", "2026-07-20T14:00:00.000Z", "%declined%"]);
    });

    it("ignores until with no since (still builds a valid < condition, no crash)", () => {
        const { sql, params } = query({ until: "2026-07-20T15:00:00Z" });
        expect(sql).toBe("WHERE timestamp < $1");
        expect(params).toEqual(["2026-07-20T15:00:00.000Z"]);
    });
});

describe("combineConditions", () => {
    it("renders an empty fragment for an empty condition list", () => {
        expect(render(combineConditions([]), [])).toBe("");
    });

    it("does not add a redundant AND for a single condition", () => {
        const conditions = commandCondition({ service: "checkout" });
        const sql = render(combineConditions(conditions), []);
        expect(sql).toBe("WHERE service = $1");
        expect(sql).not.toMatch(/AND/);
    });
});
