import express, { type Express } from "express";
import logsRouter from "./routes/logs.js";
import { errorCatcher, malformedJSON } from "./middleware/errorHandlers.js";

export function App() {
    const app = express();

    // middlewares
    app.use(express.json());

    app.use('/logs', logsRouter);


    app.use(malformedJSON);
    return app;
}