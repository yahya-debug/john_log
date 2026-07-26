import { config } from 'dotenv';
import { App } from "./http/app.js";
import { Env } from './config.js';
import { _isReady } from './db/migrate.js';



const app = App();

app.get('/', function (req, res) {
    console.log('Hi');
    res.send(`Hi`)
});

app.get('/health', async function (req, res) {
    if (await _isReady())
        return res.status(200).send('healthy')

    res.status(503).json({ status: 'not ready' }); // not ready status
})

const PORT = Env.PORT || 8080;
app.listen(PORT, () => console.log(`Started on port: ${PORT}`));