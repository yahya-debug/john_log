// Heavy concurrent reads + sustained writes, much higher read concurrency
// than loadtest/k6/lib.js's 2-5 VU aggregate probes — trying to reproduce
// the 500s seen when the real benchmark CLI used --generator-cpus 4.
const BASE_URL = "http://localhost:8080";
const DURATION_SEC = 45;
const READ_CONCURRENCY = 200; // many concurrent GET /logs + GET /logs/aggregate
const WRITE_BATCHES_PER_SEC = 30; // ~15k/s at batch 500

function makeWriteBatch() {
    const now = Date.now();
    const logs = [];
    for (let i = 0; i < 500; i++) {
        logs.push({
            timestamp: new Date(now - Math.floor(Math.random() * 1000)).toISOString(),
            level: "info", service: "checkout",
            message: `synthetic ${Math.random().toString(36).slice(2)}`,
            attributes: { user_id: String(Math.floor(Math.random() * 100000)) },
        });
    }
    return JSON.stringify({ logs });
}

let readOk = 0, read500 = 0, readOtherErr = 0, writeOk = 0, writeErr = 0;
const errorBodies = [];
const start = Date.now();

async function writer() {
    while (Date.now() - start < DURATION_SEC * 1000) {
        try {
            const res = await fetch(`${BASE_URL}/logs`, {
                method: "POST", headers: { "content-type": "application/json" },
                body: makeWriteBatch(),
            });
            if (res.ok) writeOk++; else writeErr++;
        } catch { writeErr++; }
        await new Promise(r => setTimeout(r, 1000 / WRITE_BATCHES_PER_SEC));
    }
}

async function reader(id) {
    while (Date.now() - start < DURATION_SEC * 1000) {
        const kind = id % 3;
        let url;
        if (kind === 0) {
            url = `${BASE_URL}/logs?service=checkout&limit=50`;
        } else if (kind === 1) {
            const since = new Date(Date.now() - 3600_000).toISOString();
            const until = new Date().toISOString();
            url = `${BASE_URL}/logs/aggregate?since=${since}&until=${until}&bucket=1m&group_by=service`;
        } else {
            const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
            const until = new Date().toISOString();
            url = `${BASE_URL}/logs/aggregate?since=${since}&until=${until}&bucket=1h&q=declined`;
        }
        try {
            const res = await fetch(url);
            if (res.ok) {
                readOk++;
            } else if (res.status === 500) {
                read500++;
                if (errorBodies.length < 3) errorBodies.push(await res.text());
            } else {
                readOtherErr++;
            }
        } catch (e) { readOtherErr++; }
    }
}

const writers = Array.from({ length: 1 }, writer);
const readers = Array.from({ length: READ_CONCURRENCY }, (_, i) => reader(i));
await Promise.all([...writers, ...readers]);

console.log(`writes: ok=${writeOk} err=${writeErr}`);
console.log(`reads: ok=${readOk} 500s=${read500} other_err=${readOtherErr}`);
if (errorBodies.length) console.log("sample 500 bodies:", errorBodies);
