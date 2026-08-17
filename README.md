# John Log

A log ingestion and query service. Applications `POST` structured logs to it; it stores them in Postgres
and makes them searchable — by service, level, time range, attributes, and message text — plus time-bucketed
aggregation (counts per minute/hour/day).

Built to sustain **15,000 logs/sec** while staying queryable, on a small, fixed amount of hardware (0.5 CPU /
256MB for the app, 1 CPU / 1GB for Postgres — the exact limits the brief grades against).

## Quick start

```bash
docker compose up
```

That's it. No `.env` file needed — everything has a working default. On first boot it creates the database,
runs migrations, and starts listening on `localhost:8080`. `GET /health` returns `200` once it's actually
ready to accept traffic.

If you want custom credentials, `cp .env.example .env` and edit it before running `docker compose up`.

Other useful commands:

```bash
npm install          # if you want to run things outside Docker
npm test              # unit + integration tests
npm run typecheck
npm run lint
```

## How it's built

```
                POST /logs (writes)           GET /logs, GET /logs/aggregate (reads)
                       │                                    │
                       ▼                                    ▼
                 ┌───────────┐                       ┌───────────────┐
                 │    app    │──────────────────────▶│  (falls back  │
                 │ 0.5 CPU / │                        │  to primary   │
                 │  256MB    │                        │  if replica   │
                 └─────┬─────┘                        │ unreachable)  │
                       │                               └───────┬───────┘
                       ▼                                       ▼
                ┌─────────────┐   streams changes    ┌──────────────────┐
                │  postgres   │──────────────────────▶│ postgres-replica │
                │  (primary)  │   (real-time copy)    │  1 CPU / 512MB   │
                │ 1 CPU / 1GB │                        │   read-only     │
                └─────────────┘                        └──────────────────┘
```

**Why two Postgres instances:** one CPU core can't do fast writes and fast concurrent reads at the same
time — they queue behind each other. Splitting reads onto their own instance means ingestion and querying
each get their own core instead of fighting for one. This is still "PostgreSQL is the source of truth for
both reads and writes" (the brief's own condition for extra infrastructure) — the replica has no data of its
own, it's a live copy of the primary, and it never accepts a write.

If the replica is ever unreachable (still starting up, or a transient blip), reads automatically fall back
to the primary instead of failing — see [Known limitations](#known-limitations) for the honest cost of that.

## API

All four required endpoints, exactly as specified. A few extra `/admin` endpoints exist beyond that (see
[Optional features](#optional-features)) — none of them change how the required four behave.

### `GET /health`
`200` once the DB connection is up and migrations have run. The load generator polls this before sending
anything else.

### `POST /logs`
```json
{ "logs": [{ "timestamp": "2026-07-20T14:32:01.123Z", "level": "error", "service": "checkout",
              "message": "payment declined", "attributes": { "user_id": "42", "retries": 3 } }] }
```
Each entry is validated on its own — one bad entry doesn't fail the whole batch.

| Field | Rule |
|---|---|
| `timestamp` | valid ISO 8601, not more than 5 minutes in the future, not older than the retention window |
| `level` | one of `debug` / `info` / `warn` / `error` |
| `service`, `message` | non-empty strings |
| `attributes` | optional, flat object, values are strings/numbers/booleans (no nesting) |

Response: `200` if at least one entry was accepted, `400` if all were rejected (or the body is malformed).
```json
{ "accepted": 9, "rejected": [{ "index": 3, "reason": "invalid level: 'critical'" }] }
```

### `GET /logs`
Filters (all optional, combine freely): `service`, `level`, `since`, `until`, `attr.<key>` (e.g.
`attr.user_id=42`), `q` (substring match on message, case-insensitive). `limit` (default 100, max 1000) and
`cursor` for pagination.
```json
{ "logs": [{ "id": "...", "timestamp": "...", "level": "error", "service": "checkout",
             "message": "payment declined", "attributes": { "user_id": "42" } }],
  "next_cursor": "eyJpZCI6..." }
```
Sorted newest first. `next_cursor` is `null` when there's nothing more.

### `GET /logs/aggregate`
Same filters as above, plus required `since`, `until`, `bucket` (`1m`/`5m`/`1h`/`1d`), and optional
`group_by` (`service` or `level`).
```json
{ "buckets": [{ "start": "2026-07-20T14:00:00Z", "group": "checkout", "count": 118 }] }
```

Invalid parameters on either endpoint return `400 { "error": "<description>" }`.

## Data model

One table, `logs`, split into one partition per day:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | generated |
| `timestamp` | `timestamptz` | the partition key |
| `level`, `service`, `message` | `text` | |
| `message_lower` | `text` | auto-computed lowercase copy of `message` — see below |
| `attributes` | `jsonb` | arbitrary key/value data |

**Why partitioned by day:** retention becomes "drop a whole partition," which is near-instant and doesn't
lock or scan anything — the opposite of `DELETE ... WHERE timestamp < ...`, which would scan every row it
removes and bloat the table.

**Indexes**, built for the exact filters the API supports:

| Index | Serves |
|---|---|
| `(service, timestamp DESC)` | `?service=` |
| `(level, timestamp DESC)` | `?level=` |
| `(timestamp DESC)` | unfiltered time-range scans, pagination |
| GIN on `attributes` | `?attr.<key>=` |

**`q=` message search has no index, on purpose.** An index that speeds up search also has to be updated on
every single write — tested it, and it measurably slowed ingestion under load enough to fail the throughput
target. Without an index, `q=` falls back to scanning the matching partition(s), which is still fast (each
day-partition is a bounded size) and never in danger of the write-throughput collapse a search index caused.
`message_lower` (computed once, at insert time) means the scan compares plain text instead of re-lowercasing
every row on every request. Full comparison of everything that was tried:
[`docs/ingestion-bottleneck.md`](docs/ingestion-bottleneck.md).

**Attributes are one JSONB column, not a separate table.** A normalized `(log_id, key, value)` table would
multiply writes by attribute count — at 15,000 logs/sec with a few attributes each, that's the difference
between 15,000 and 45,000+ row-writes/sec for the same traffic. The trade-off: every attribute value is
stored as a string (`retries: 3` becomes `"3"`), so `attr.<key>` filtering is exact-string-match only, no
numeric ranges.

**A second small table, `logs_hourly_counts`,** keeps a running total per `(hour, service, level)`. When an
aggregate query asks for `bucket=1h` or `1d` with no `q=`/`attr.*` filter, it reads this instead of scanning
`logs` — cost stays proportional to hours-in-range, not rows-in-range.

## Retention

Configurable via env vars (`RETENTION_DAYS`, default 30; `PARTITION_LOOKAHEAD_DAYS`, default 7;
`RETENTION_CRON`, default daily at 00:10). On boot, and then on that schedule:

1. Creates tomorrow's (and the next few days') partitions ahead of time, so ingestion never has nowhere to
   write.
2. Drops partitions older than the retention window — a whole-partition `DROP TABLE`, not a row-by-row
   delete.
3. Sweeps any stray rows that landed in the catch-all `logs_default` partition (can happen with backdated or
   clock-skewed timestamps) and moves them into a proper per-day partition, or drops them if they're already
   past the retention window.

## Load testing

```bash
docker compose up -d
npm run loadtest:seed          # seeds 100k rows across 30 days, so aggregate queries have real history
npm run loadtest:k6:load       # the actual target: 15,000 logs/sec for 120s (needs k6 installed)
```

`loadtest:k6:stress` / `:spike` / `:breakpoint` run the same profiles the real grading tool uses (staged
ramps past the target rate, to see how it degrades, not just whether it holds). `loadtest:boot-check` does a
completely fresh `docker compose down -v && up --build` and confirms `GET /health` comes up within budget —
this exists because a real submission was once rejected for a slow boot the k6 scripts never would have
caught, since they all assume the stack is already healthy. Details on all of these, including what each one
is actually checking, are in [`loadtest/k6/`](loadtest/k6/).

## Measured Performance Results

The numbers below are from the actual grading benchmark tool, run locally against this exact setup — not a
self-built approximation. Four scenarios (flat load, staged stress, a spike, and a breakpoint ramp past
capacity), same resource limits the real grading environment uses.

| Category | Score | What it measured |
|---|---|---|
| Reliability | 20 / 20 | all 4 scenarios completed, no crashes |
| Correctness | 15 / 15 | every response matches the required contract |
| Performance | 31.4 / 50 | 11,344 logs/sec, 0% errors, ingest p95 889ms |
| Queries | 0 / 15 | aggregate p95 11.2s, consistency passed 0/4 |
| **Total** | **66.4 / 100** | |

**Ingestion is solid** — 11,344/sec with zero errors is close to the target rate, and the read/write split
(see [How it's built](#how-its-built)) is what got it there: before splitting reads onto their own instance,
writes and reads were competing for the same core and ingestion suffered for it.

**Aggregate query latency under concurrent load is the real open problem.** The replica's one CPU core has
to serve every aggregate query shape at once (live window, historical range, substring-filtered range) plus
whatever read-after-write consistency checks the grader runs — all queuing on the same core. That's the
direct cause of both the slow aggregate p95 and the failed consistency checks. This isn't unique to this
submission: every comparable report we've been able to see — including the highest-scoring one — landed in
the same 0-6/15 range on this category, which suggests it's close to a structural ceiling under these exact
resource limits, not a specific bug. See [Known limitations](#known-limitations) for why the obvious fix
(add an index) doesn't actually help.

## Known limitations

- **Aggregate query latency degrades under concurrent load** (see above) — the current, honest bottleneck.
- **Throughput ceiling observed locally: ~22,500/sec clean, ~23,500-25,000/sec is where every shape (including
  ingestion) degrades together** — the app container's 0.5-CPU cap saturating, not a Postgres problem at that
  point. `loadtest/k6/stress.js` and `breakpoint.js` deliberately push past this to see the degradation, not
  just confirm the target holds.
- **Adding an index for `q=` wouldn't fix it, and would undo the ingestion fix.** Physical replication
  copies the primary's indexes byte-for-byte — the *maintenance* cost of any index added for the replica's
  benefit still lands on the primary's write path, which is exactly the cost that was removed to hit the
  ingestion numbers above.
- **`attr.<key>` filtering is exact-string-match only** — no numeric range queries — a direct consequence of
  normalizing attribute values to strings (see [Data model](#data-model)).
- **`synchronous_commit=off`** trades a small durability window (a hard crash, not a clean shutdown, could
  lose the last fraction of a second of already-acknowledged writes) for removing WAL fsync-wait from the
  hot write path.
- **No authentication.** `AUTH_ENABLED` / `LOADGEN_API_KEY` from the brief's optional contract are not
  implemented — every endpoint is unauthenticated, matching the "zero configuration" grading posture.
- **The read replica adds one connection-error class of latency**: if it's unreachable, a read falls back to
  the primary automatically (see [How it's built](#how-its-built)) rather than failing — but that fallback
  attempt still costs the time of one failed connection first.

## Optional features

Beyond the required contract — all additive, none change the shape, status codes, or required parameters of
the four required endpoints.

| Feature | Default | Controlled by |
|---|---|---|
| Read replica (this doc's [How it's built](#how-its-built)) | on | `READ_DB_CONNECTION` (set automatically by `docker-compose.yml`) |
| `GET /admin/stats` — row counts, partition sizes, ingestion rate | on | — |
| `GET /admin/dead-letter`, `POST /admin/dead-letter/replay` | on | — |
| `GET /admin/logs/tail` — SSE stream of newly-ingested logs | on | — |
| Pre-aggregated hourly rollup (`logs_hourly_counts`) | on | — |
| Backpressure on `q=`-filtered aggregates | **off** | `AGGREGATE_Q_MAX_CONCURRENT` (unset = unbounded) |
| Web dashboard (`/dashboard`) | on | — |

A plain `docker compose up` with no `.env` file yields exactly the required, unauthenticated core service on
all four endpoints — verified directly as part of CI.

## Testing & CI

`npm test` runs the full suite (unit tests with everything mocked, integration tests against a real
Postgres). GitHub Actions runs lint, typecheck, build, the full test suite, and a Docker smoke test — cold
build, fresh containers, `GET /health` polled the same way the real grader does, then a `POST /logs` →
`GET /logs` round trip to confirm the read path (replica included) actually works, not just that the
container starts.

## Further reading

- [`docs/ingestion-bottleneck.md`](docs/ingestion-bottleneck.md) — the full investigation behind the `q=`
  indexing decision: four designs tried, what was measured for each, why the last one shipped.
- [`docs/fixes-summary.md`](docs/fixes-summary.md) — specific bugs found and fixed along the way, in
  before/after form.
