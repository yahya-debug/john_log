import { describe, expect, it } from "vitest";
import { isLevel } from "../../../src/types/log.js";

describe("isLevel", () => {
    it.each(["debug", "info", "warn", "error"])("accepts %s", (level) => {
        expect(isLevel(level)).toBe(true);
    });

    it("rejects an unknown level string", () => {
        expect(isLevel("critical")).toBe(false);
    });

    it("rejects non-string values", () => {
        expect(isLevel(123)).toBe(false);
        expect(isLevel(null)).toBe(false);
        expect(isLevel(undefined)).toBe(false);
        expect(isLevel(["error"])).toBe(false);
    });
});
