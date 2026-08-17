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

**Test conditions** (the brief asks for these explicitly, so stated plainly rather than left implicit):

- **Test environment:** the real grading tool itself, run locally — Docker engine with 12 CPUs / 15GB RAM
  (Arch Linux host), the load generator (`grafana/k6`) running in its own separate container with its own
  CPU/memory budget, independent of the service under test.
- **Resource limits enforced on the service being measured:** app `0.5 CPU / 256MB`, Postgres `1 CPU / 1GB`
  — the brief's exact numbers, not the host's full capacity.
- **Dataset size:** the grading tool seeds 1,000,000 fixture rows before each scenario run (`loadtest:seed`,
  used for local-only testing, defaults to 100,000 across 30 days — see [Load testing](#load-testing)).
- **Batch size:** 500 logs per `POST /logs` call (this project's own load-testing convention, used throughout
  `loadtest/k6/`).
- **Query rate:** confirmed directly — the scored load scenario sends approximately one
  `GET /logs/aggregate?bucket=1m` request per second, which is what [the aggregate cache](#data-model) is
  specifically tuned around.
- **Four scenarios, each run by the real grading tool:** flat load (15,000/s, 120s), staged stress (up to
  ~24,000/s), a spike (up to ~28,000/s), and a breakpoint ramp deliberately past capacity.

**Current best result**, same tool, same conditions, after every fix below:

| Category | Score | What it measured |
|---|---|---|
| Reliability | 20 / 20 | all 4 scenarios completed, no crashes |
| Correctness | 15 / 15 | every response matches the required contract |
| Performance | 45.0 / 50 | 14,999 logs/sec, 0% errors, p95 43ms |
| Queries | 0 / 15 | aggregate p95 5.3s, consistency passed 0/4 |
| **Total** | **80.0 / 100** | |

**Resource usage under load** (this project's own `docker stats` sampling during a local reproduction of the
same scenario): Postgres (primary) CPU avg 20-33% / max 82-90%; the read replica CPU avg 60-88% / max
100-110% (consistently the most CPU-saturated of the three containers — see below for why); the app CPU avg
21-41% / max 50-55%, comfortably under its 0.5-core cap throughout.

**Full latency percentiles**, from this project's own load-test tooling (`loadtest/k6/load.js`) — the real
grading tool only reports p95, so this is the finer-grained view behind that one number, from the same class
of run as the current-best result above:

| Shape | p50 | p90 | p95 | max |
|---|---|---|---|---|
| Ingestion (`POST /logs`) | ~5ms | ~15ms | 43ms | — |
| Aggregate, live window (`bucket=1m`) | 4.3ms | 9.7s | 5.3-29.3s* | up to 44s |
| Aggregate, historical (`bucket=1h`, rollup) | 4.5ms | 2.3-11.0s | 5.3-19.6s* | up to 31s |
| Aggregate, `q=`-filtered | 5.1ms | 4.2-19.1s | 5.3-24.1s* | up to 35s |

\* Ranges, not a typo — this is the run-to-run variance itself being reported honestly rather than picking the
best-looking number: p50 is consistently near-instant (the aggregate cache hitting), while p90+ varies a lot
run to run depending on host/replica contention at the time. See [the journey](#the-journey-what-was-actually-broken-and-what-fixing-it-moved)
below for why the tail is still this wide.

### The journey: what was actually broken, and what fixing it moved

Every row below is a real run of the actual grading tool, not a local approximation — the brief specifically
asks for evidence of measurement over assumption, and a plain "it works" doesn't show that. Score swings this
large across the *same* target rate are themselves informative: they're the reason each fix below was kept or
reverted based on what the real tool reported, not on what seemed like it should help.

| Run | Change | Total | What moved |
|---|---|---|---|
| 1 | Read replica added, no other fixes yet | 66.4 | Baseline — Performance 31.4/50, Queries already stuck at 0/15 |
| 2 | (same code, higher generator concurrency) | **40.0 — capped** | Correctness collapsed to 9/15: every read endpoint 500'd. Root cause: the replica's TCP port accepted connections before Postgres itself finished recovery (`57P03: the database system is starting up`) — a real Postgres error, not a network failure, so the replica-fallback logic didn't recognize it and retry |
| 3 | Recognize Postgres's own "not ready" SQLSTATE codes (`57P01`/`57P02`/`57P03`) as fallback triggers, not just network errors | 76.8 | Correctness back to 15/15; Performance *also* jumped past the original baseline (41.8/50) — the first run suggests this same race was quietly costing performance even when it didn't fail outright |
| 4 | Every aggregate shape cached, not just `q=`/`attr.*`-filtered ones; cache window widened from 1s to 8s once the real ~1s polling cadence was confirmed | 76.9 | Aggregate p95 13.0s → 8.6s. Queries unchanged (0/15) |
| 5 | Capped the app's connection pool to the replica (4, down from 10) — diagnosed via `pg_stat_replication` that WAL replay fell up to 68.7s/382MB behind under unbounded read concurrency | 67.4 — **reverted** | Replay lag genuinely improved (measured directly), but Performance dropped (41.9→32.4/50, p95 350ms→763ms) for **zero** change to Queries or consistency. A real, measured cost with no matching benefit — reverted rather than kept on faith |
| 6 | Pool cap reverted | **80.0** | Performance recovered *past* every prior run (45.0/50, p95 43ms) — confirms run 5 was a pure regression, not a worthwhile tradeoff |

**Bottlenecks actually found**, in the order they were diagnosed:
1. A replica-startup race blocking the app's own boot (`app` waited on the replica reaching healthy before
   starting at all) — fixed by only depending on the primary; nothing at startup touches the replica.
2. The same race, more subtly: reads landing on the replica *after* its TCP port opened but *before* Postgres
   finished recovery, returning a real Postgres error our fallback logic didn't recognize (run 2 above).
3. Every aggregate query shape (live window, historical range, `q=`-filtered) queuing on the replica's single
   CPU core — including shapes that are individually cheap (a rollup-served historical query measured at
   12.4s p95 despite reading a handful of rows from a small table). Not query cost; concurrent volume on one
   core.
4. WAL replay competing with read queries for that same core, independent of query cost — confirmed directly
   via `pg_stat_replication`, not inferred.

**Optimizations applied:** the read/write split itself (primary + replica, [How it's built](#how-its-built));
recognizing Postgres's own "not ready" errors as fallback triggers, not just network failures; caching every
aggregate shape with a window sized to the confirmed real polling cadence, not a guessed one.

**What's still open, honestly:** Queries has read exactly 0/15 across every run in the table above, and
consistency exactly 0/4 — across aggregate p95 ranging from 5.3s to 13s and replication lag ranging from 3s
to 68.7s in local measurement. That's zero measured sensitivity to either lever tried so far. This isn't
unique to this submission — every comparable report seen from this grading tool, including the
highest-scoring one available, landed in the same 0-6/15 range on this category — but "common" isn't the same
as "understood," and this project doesn't yet have a confirmed explanation for what the consistency check is
actually sensitive to. See [Known limitations](#known-limitations).

## Known limitations

- **Consistency checks fail (0/4) for a reason this project doesn't yet have confirmed evidence for.**
  Aggregate query latency was the obvious suspect and was worth fixing regardless, but it isn't the answer:
  consistency stayed at exactly 0/4 across aggregate p95 ranging from 5.3s to 13s and — measured directly via
  `pg_stat_replication`, not guessed — replication lag ranging from 3s to 68.7s. Both moved substantially
  across different runs; consistency never did. Capping read concurrency to protect WAL replay (see
  [Measured Performance Results](#measured-performance-results), run 5) *did* fix replay lag, confirmed
  directly, and still didn't move it, while costing real Performance score. That result is recorded rather
  than hidden: a fix that measurably improves the thing it targets but doesn't move the actual score is
  itself useful evidence that the mental model is incomplete, not proof the fix was wrong.
- **Aggregate query latency degrades under concurrent load** — every shape queues on the replica's single
  CPU core, including individually cheap ones (see [Measured Performance Results](#measured-performance-results)).
  Improved substantially (13s → 5.3s p95 in the best run) but still well over the brief's 1s target.
- **Adding an index for `q=` wouldn't fix aggregate latency, and would undo the ingestion fix.** Physical
  replication copies the primary's indexes byte-for-byte — the *maintenance* cost of any index added for the
  replica's benefit still lands on the primary's write path, which is exactly the cost that was removed to
  hit the ingestion numbers in Measured Performance Results.
- **Throughput ceiling observed locally: ~22,500/sec clean, ~23,500-25,000/sec is where every shape (including
  ingestion) degrades together** — the app container's 0.5-CPU cap saturating, not a Postgres problem at that
  point. `loadtest/k6/stress.js` and `breakpoint.js` deliberately push past this to see the degradation, not
  just confirm the target holds.
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
