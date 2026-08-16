import { ErrorRequestHandler, NextFunction, Request, Response } from "express";

// create type HttpError to get the status that express.json() sets when parsing fails
interface HttpError extends SyntaxError {
    status?: number;
    body?: string;
}

export function malformedJSON(err: unknown, req: Request, res: Response, next: NextFunction) {
    if (err instanceof SyntaxError && (err as HttpError).status == 400 && 'body' in err) {
        console.error(`Malformed JSON rejected`)

        return res.status(400).json({
            status: 'error',
            error: "Malformed JSON",
            message: "The request body failed to be parsed" 
        })
    }

    next(err);
}

// Catch-all, registered last in app.ts's middleware chain: anything that
// reaches here is an error malformedJSON didn't recognize — a query error,
// a dropped connection, a replica query cancelled mid-flight (a normal
// replication event under load, not a bug). Without this, such an error
// just propagates out of an async route handler and can crash the whole
// process instead of producing a response. Replaces the old errorCatcher,
// which wrapped `next(err)` in a try/catch that couldn't actually catch
// anything from downstream async handlers.
export function finalErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
    console.error("unhandled error in request pipeline:", err);
    if (res.headersSent) return next(err); // Express owns the response once headers are sent — must defer, not double-send
    res.status(500).json({ error: "internal server error" });
}