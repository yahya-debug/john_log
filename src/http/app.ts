import express, { type Express } from "express";
import logsRouter from "./routes/logs.js";
import aggregateRouter from "./routes/aggregate.js"
import { errorCatcher, malformedJSON } from "./middleware/errorHandlers.js";

export function App() {
    const app = express();

    // middlewares
    app.use(express.json());

    app.use('/logs', logsRouter);
    app.use('/logs/aggregate', aggregateRouter);


    app.use(malformedJSON);
    return app;
}