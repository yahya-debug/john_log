import { config } from 'dotenv';
import { App } from "./http/app.js";
import { Env } from './config.js';
import { isMigrationReady } from './db/migrate.js';



const app = App();

app.get('/', function (req, res) {
    console.log('Hi');
    res.send(`Hi`)
});

// Readiness: is the app ready to serve traffic (migrations done)? Gate
// routing on this — safe to poll often since it's just a flag read.
app.get('/health', function (req, res) {
    if (isMigrationReady())
        return res.status(200).send('healthy')

    res.status(503).json({ status: 'not ready' }); // not ready status
})

// Liveness: is the process itself alive? Deliberately never checks DB/
// migration state — a slow-to-migrate DB shouldn't make k8s think the
// process is hung and restart it.
app.get('/live', function (req, res) {
    res.status(200).send('alive');
})

const PORT = Env.PORT || 8080;
app.listen(PORT, () => console.log(`Started on port: ${PORT}`));