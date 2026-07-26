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

export function errorCatcher(err: unknown, req: Request, res: Response, next: NextFunction) {
    try {
        next(err);
    } catch (error) {
        res.status(400).json({ msg: (error as Error).message });
    }
}