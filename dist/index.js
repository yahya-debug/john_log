import { App } from "./http/app.js";
import { Env } from './config.js';
import { isMigrationReady } from './db/migrate.js';
import { flushNow } from './ingestion/writeBuffer.js';
const app = App();
app.get('/', function (req, res) {
    console.log('Hi');
    res.send(`Hi`);
});
// Readiness: is the app ready to serve traffic (migrations done)? Gate
// routing on this — safe to poll often since it's just a flag read.
app.get('/health', function (req, res) {
    if (isMigrationReady())
        return res.status(200).send('healthy');
    res.status(503).json({ status: 'not ready' }); // not ready status
});
// Liveness: is the process itself alive? Deliberately never checks DB/
// migration state — a slow-to-migrate DB shouldn't make k8s think the
// process is hung and restart it.
app.get('/live', function (req, res) {
    res.status(200).send('alive');
});
const PORT = Env.PORT || 8080;
const server = app.listen(PORT, () => console.log(`Started on port: ${PORT}`));
// SIGTERM: docker compose stop/down, a k8s pod eviction. SIGINT: Ctrl+C
// locally. Both mean "stop normally" — as opposed to a crash, where
// whatever's currently buffered in writeBuffer.ts is expected to be lost.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5000;
async function shutdown(signal) {
    console.log(`${signal} received, shutting down`);
    // Stop accepting new connections first, so nothing new can push into
    // the write buffer while we're trying to drain it.
    server.close(() => console.log('server closed to new connections'));
    try {
        // Bounded wait: if Postgres happens to be unreachable right now,
        // flushNow() could hang — don't let that hang shutdown itself
        // (and whatever's orchestrating it, e.g. Docker/k8s) indefinitely.
        await Promise.race([
            flushNow(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('flush timed out')), SHUTDOWN_FLUSH_TIMEOUT_MS)),
        ]);
        console.log('write buffer flushed');
    }
    catch (err) {
        console.error('shutdown: flush did not complete in time, exiting anyway:', err);
    }
    // Explicit exit rather than relying on the event loop draining
    // naturally — the retention cron job (node-cron, src/retention/job.ts)
    // isn't unref'd and would otherwise keep the process alive.
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
