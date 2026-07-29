import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../../src/query/cursor.js";

describe("cursor encode/decode", () => {
    it("round-trips a cursor through base64", () => {
        const cursor = { timestamp: "2026-07-20T14:32:01.123Z", id: "abc-123" };
        expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    });

    it("produces an opaque, URL-safe-ish base64 string", () => {
        const encoded = encodeCursor({ timestamp: "2026-07-20T14:32:01.123Z", id: "abc-123" });
        expect(encoded).not.toContain("{");
        expect(() => Buffer.from(encoded, "base64")).not.toThrow();
    });

    it("throws on a garbage cursor string rather than silently misbehaving", () => {
        expect(() => decodeCursor("not-valid-base64-json")).toThrow();
    });
});
