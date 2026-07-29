import { describe, expect, it } from "vitest";
import { isBucketSize, BUCKET_INTERVALS } from "../../../src/types/QueryParams.js";

describe("isBucketSize", () => {
    it.each(["1m", "5m", "1h", "1d"])("accepts %s", (size) => {
        expect(isBucketSize(size)).toBe(true);
    });

    it("rejects an unsupported bucket size", () => {
        expect(isBucketSize("30s")).toBe(false);
        expect(isBucketSize("1w")).toBe(false);
    });

    it("rejects non-string values", () => {
        expect(isBucketSize(undefined as any)).toBe(false);
        expect(isBucketSize(null as any)).toBe(false);
    });
});

describe("BUCKET_INTERVALS", () => {
    it("maps every valid bucket size to a Postgres interval literal", () => {
        expect(BUCKET_INTERVALS).toEqual({
            "1m": "1 minute",
            "5m": "5 minutes",
            "1h": "1 hour",
            "1d": "1 day",
        });
    });
});
