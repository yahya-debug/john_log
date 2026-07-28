import express, { type Express } from "express";
import qs from "qs";
import logsRouter from "./routes/logs.js";
import aggregateRouter from "./routes/aggregate.js"
import { errorCatcher, malformedJSON } from "./middleware/errorHandlers.js";
import { runMigration } from "../db/migrate.js";
import { retain, retentionJob } from "../retention/job.js";

export function App() {
    const app = express();

    // Express's default "simple" query parser doesn't nest dotted keys, so
    // attr.user_id=42 would arrive as the flat key "attr.user_id" instead of
    // query.attr.user_id. allowDots makes attr.<key> filters actually work.
    app.set('query parser', (str: string) => qs.parse(str, { allowDots: true }));

    // middlewares
    app.use(express.json());

    app.use('/logs', logsRouter);
    app.use('/logs/aggregate', aggregateRouter);


    app.use(malformedJSON);

    runMigration();
    retain().catch(err => console.error(`retention job failed: ${err}`));
    retentionJob();
    return app;
}