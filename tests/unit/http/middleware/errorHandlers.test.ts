import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { finalErrorHandler } from "../../../../src/http/middleware/errorHandlers.js";

// finalErrorHandler is the catch-all registered last in app.ts's middleware
// chain — added specifically because a replica query cancelled mid-flight
// used to crash the whole process (see docker-compose.yml's
// hot_standby_feedback comment, and errorHandlers.ts). Without this, any
// unexpected error from a route handler (a dropped replica connection, a
// real query bug) reaches Node as an unhandled rejection instead of a clean
// response — the brief explicitly requires avoiding "application crashes
// during sustained ingestion."
function buildApp() {
    const app = express();
    app.get("/boom", () => {
        throw new Error("simulated unexpected failure");
    });
    app.use(finalErrorHandler);
    return app;
}

describe("finalErrorHandler", () => {
    it("turns an unhandled route error into a clean 500, not a crash", async () => {
        const res = await request(buildApp()).get("/boom");

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "internal server error" });
    });

    it("logs the error instead of swallowing it silently", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

        await request(buildApp()).get("/boom");

        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it("defers to next(err) instead of double-sending once headers are already sent", () => {
        const next = vi.fn();
        const res = { headersSent: true, status: vi.fn(), json: vi.fn() } as any;
        const err = new Error("late failure");

        finalErrorHandler(err, {} as any, res, next);

        expect(next).toHaveBeenCalledWith(err);
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
    });
});
