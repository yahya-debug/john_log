import express from "express";
import qs from "qs";
import logsRouter from "./routes/logs.js";
import aggregateRouter from "./routes/aggregate.js";
import adminRouter from "./routes/admin.js";
import { finalErrorHandler, malformedJSON } from "./middleware/errorHandlers.js";
import { runMigration } from "../db/migrate.js";
import { retain, retentionJob } from "../retention/job.js";
import path from "node:path";
export function App() {
    const app = express();
    // Express's default "simple" query parser doesn't nest dotted keys, so
    // attr.user_id=42 would arrive as the flat key "attr.user_id" instead of
    // query.attr.user_id. allowDots makes attr.<key> filters actually work.
    app.set('query parser', (str) => qs.parse(str, { allowDots: true }));
    // middlewares
    // Default 100kb is too small for large log batches; nothing in the
    // ingestion contract caps batch size.
    app.use(express.json({ limit: '10mb' }));
    app.use('/logs', logsRouter);
    app.use('/logs/aggregate', aggregateRouter);
    app.use('/admin', adminRouter);
    app.use('/dashboard', express.static(path.join(process.cwd(), "dashboard", "dist")));
    app.use(malformedJSON);
    // Last: catches anything malformedJSON didn't (an unexpected query error,
    // a dropped connection, etc.) and turns it into a clean 500 instead of
    // letting it crash the process — see middleware/errorHandlers.ts.
    app.use(finalErrorHandler);
    // retain() partitions the `logs` table, so it can't run until migrations
    // have created it — chain it onto migration completion instead of firing
    // both off in parallel.
    runMigration()
        .then(() => retain())
        .catch(err => console.error(`retention job failed: ${err}`));
    retentionJob();
    return app;
}
