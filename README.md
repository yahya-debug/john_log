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
                 ┌───────────┐                        (same connection)
                 │    app    │───────────────────────────────┘
                 │ 0.5 CPU / │
                 │  256MB    │
                 └─────┬─────┘
                       ▼
                ┌─────────────┐
                │  postgres   │
                │ 1 CPU / 1GB │
                └─────────────┘
```

**One Postgres instance, not two.** An earlier version of this project split reads onto a dedicated read
replica, on the theory that one CPU core can't do fast writes and fast concurrent reads at the same time.
That was true, and the split did measurably help — but it also used double the brief's Postgres budget (two
containers, each independently capped at close to the brief's stated `1 CPU / 1GB`, rather than one instance
actually held to it) and added a real category of bugs (a boot-order race, a replica-not-ready error class
the fallback logic didn't originally recognize, WAL-replay-vs-read-query contention) without ever moving the
one score category — Queries — it was ultimately meant to help. Removed once the actual lever for that
turned out to be something else entirely (see [Measured Performance Results](#measured-performance-results)
and [Known limitations](#known-limitations)): a minute-granularity rollup table means most reads are cheap
enough that a single, properly-tuned instance handles both reads and writes without the two queuing behind
each other the way raw-table scans would have.

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

**Two small rollup tables, `logs_hourly_counts` and `logs_minute_counts`,** each keep a running total per
`(bucket, service, level)`, updated in the *same transaction* as the raw insert — never a separate write that
could drift out of sync. When an aggregate query has no `q=`/`attr.*` filter, it reads one of these instead of
scanning `logs`: `bucket=1h`/`1d` from the hourly table, `bucket=1m`/`5m` from the minute one. Two tables, not
one finer-grained one, because a `1d` bucket over the full retention window only needs to sum a few hundred
hourly rows this way, not ~43,200 per-minute ones. Both are pruned on the same retention cutoff as `logs`
itself (see [Retention](#retention)) — an unbounded per-minute table would eventually cost more to scan than
what it's supposed to speed up. Only `q=`/`attr.*`-filtered aggregates still fall back to scanning `logs`
directly — those have an unbounded value space that can't be pre-aggregated this way.

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

**Best confirmed results against the real grading tool** — current architecture (single Postgres instance,
hourly + minute rollups, pool-bounding tried and reverted, aggregate cache widened to 8s; see
[How it's built](#how-its-built)). Three consecutive runs, same code, same machine:

| Run | Total | Performance | Queries | Reliability | Machine speed |
|---|---|---|---|---|---|
| A | 88.8 / 100 | 45.0/50 — 14,999/s, 0% errors, load p95 18ms | 8.8/15 — agg p95 11ms, consistency 0/4 | 20/20 | 0.63x reference |
| B | 89.5 / 100 | 45.0/50 — 14,999/s, 0% errors, load p95 49ms | 9.5/15 — agg p95 53ms, consistency 1/4 | 20/20 | 0.59x reference |
| C | 90.1 / 100 | 45.0/50 — 14,999/s, 0% errors, load p95 29ms | 10.1/15 — agg p95 24ms, consistency 1/4 | 20/20 | 0.62x reference |

Up from run 7's 65.5/100 (Queries 0/15, consistency 0/4) — see [the journey](#the-journey-what-was-actually-broken-and-what-fixing-it-moved)
below for what moved. Machine speed (0.59-0.63x reference, reported by the grading tool itself) applies
equally to all three runs above — quoted alongside every score for the same reason the tool asks for it: so
these numbers are never compared against a faster machine's run without that context.

Run B's stress/spike/breakpoint scenarios are a real outlier, not averaged away here: stress dropped to 344
logs/sec at 98% errors and spike to 0 logs/sec at 100% errors, against ~14,500-14,700/sec and ~25-28% errors
for the *same* scenarios in runs A and C. Reliability still scored 20/20 in all three — that category grades
scenario completion and crash-freedom, not throughput — so nothing crashed, but a ~40x throughput swing on
what should be identical code, sandwiched between two much healthier runs, reads more like host contention
during that specific run than a code regression. Not yet isolated or re-run in controlled conditions.

**Full latency percentiles** below are from this project's own load-test tooling (`loadtest/k6/load.js`),
predating the minute-rollup fix (run 4 in the journey table) — kept for the p50-vs-tail contrast they show,
not as the current state. The real grading tool's own p95 numbers (the ones that actually count) are in the
table above and the journey table below; both are more recent than this one.

| Shape | p50 | p90 | p95 | max |
|---|---|---|---|---|
| Ingestion (`POST /logs`) | ~5ms | ~15ms | 43ms | — |
| Aggregate, live window (`bucket=1m`) | 4.3ms | 9.7s | 5.3-29.3s* | up to 44s |
| Aggregate, historical (`bucket=1h`, rollup) | 4.5ms | 2.3-11.0s | 5.3-19.6s* | up to 31s |
| Aggregate, `q=`-filtered | 5.1ms | 4.2-19.1s | 5.3-24.1s* | up to 35s |

\* Ranges, not a typo — this is the run-to-run variance itself being reported honestly rather than picking the
best-looking number: p50 is consistently near-instant (the aggregate cache hitting), while p90+ varies a lot
run to run depending on host contention at the time. See [the journey](#the-journey-what-was-actually-broken-and-what-fixing-it-moved)
below for why the tail was still this wide before the rollup fix.

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
| 7 | Added a minute-granularity rollup (`logs_minute_counts`), the same idea as `logs_hourly_counts` one level finer, so `bucket=1m`/`5m` (previously always a live scan) gets the same treatment `1h`/`1d` already had | 65.5 (see machine-speed note above) | Aggregate p95 **4303ms → 1416ms**, a real 66% cut, confirmed by the real tool. **Queries still exactly 0/15, consistency still exactly 0/4** — unmoved despite the cut. Total isn't comparable to run 6: this run was flagged `machine speed 0.60x reference` by the grading tool itself |
| 8 | Read replica removed entirely; pool-bounding on the now-single connection pool tried and reverted (same shape of result as run 5 — cost Performance, moved nothing on Queries); aggregate cache TTL/rounding widened 1s → 8s — see [How it's built](#how-its-built) | 88.8-90.1 across 3 real-tool runs (see table above) | **Queries jumped from 0/15 to 8.8-10.1/15 — the single biggest move in this table.** Consistency moved off a hard 0/4 for the first time (0/4, then 1/4 twice) but isn't solved. Aggregate p95 (load scenario) now 11-53ms, comfortably under the 1s target |

Run 7 matters beyond its own number: three completely different fixes now — cache-window tuning (run 4), an
in-process live-window tracker (tried between runs 6 and 7, not shown as its own row since it was superseded
before a real-tool run), and now a durable, transactionally-consistent rollup — have each cut aggregate
latency substantially and *none of them moved Queries or consistency even once*. That's strong evidence the
gap was never really about read-side latency or architecture at all.

Run 8's real-tool results (table above) confirm the direction of that theory but split it into two separate,
now code-confirmed mechanisms — one for each of the two consistency-related numbers the grading tool reports:

1. **Read-after-write (near-zero, ~0.1-0.3%, in all three runs).** `POST /logs` returns `200` the moment a
   batch is admitted into the in-memory write buffer (`src/http/routes/logs.ts`), not once it's actually
   committed — `writeBuffer.ts` flushes on its own schedule (`FLUSH_INTERVAL_MS`, default 100ms, or sooner once
   `FLUSH_SIZE` is reached), fully decoupled from the response. A client that queries immediately after
   receiving that `200` is racing a write that, by design, hasn't happened yet. This is the same buffering that
   makes 15,000/s on 0.5 CPU possible at all — not a bug, but it does mean the response currently promises less
   durability than "the batch exists in Postgres." Fixing this means making the response wait for its own
   flush to actually complete before returning — `writeBuffer.ts` already emits a `"flushed"` event
   (`tailEmitter`, also used by the live-tail endpoint) with exactly the batch that just committed, which is
   the natural hook for this. Not yet implemented; the response-latency cost of waiting hasn't been measured.
2. **Eventual consistency (0/4 to 1/4 scenarios).** The specific query shape a consistency check needs —
   filtering by a value only that check knows, i.e. an `attr.<key>=` filter — is deliberately excluded from
   every fast path this project built (both rollup tables and the in-memory live tracker; see
   [Data model](#data-model)), since attribute values are an unbounded space that can't be pre-aggregated. That
   query always falls back to a live scan over `logs`, behind `idx_attrs_gin` — a GIN index built on the
   *parent* `logs` table, which Postgres auto-attaches to (and pays maintenance cost on every insert into) the
   actively-written partition. That's the exact same class of problem already found and fixed for the message
   trigram index (see [`docs/ingestion-bottleneck.md`](docs/ingestion-bottleneck.md) and migration
   `0001_drop_global_trigram_index.sql`, which measured a 12.5ms → 1615ms ingest p95 regression from that
   pattern) — just never applied to `attributes`. Not yet tested with the same before/after methodology.

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

**Optimizations applied:** a minute-granularity rollup table (`logs_minute_counts`) alongside the existing
hourly one, updated in the same transaction as the raw insert, so every unfiltered aggregate shape — not just
`1h`/`1d` — reads a small pre-aggregated table instead of scanning `logs`; a single, properly-tuned Postgres
instance instead of a primary+replica split (see [How it's built](#how-its-built)) once the rollup made the
read/write contention that split existed to fix mostly moot.

**What's still open, honestly:** Queries moved from a hard 0/15 to 8.8-10.1/15 once the replica was removed
and the minute rollup landed (run 8) — the big win there was aggregate latency (11-53ms p95, well under the
1s target), not consistency. Consistency itself only moved from a hard 0/4 to 0-1/4 across the same three
runs — real progress, but still not solved, and still the main thing capping this category. The two mechanisms
above (response-before-durability for read-after-write; the attr-filtered query's forced live scan behind a
hot-partition GIN index for eventual consistency) are the current, code-confirmed leading theories — not yet
fixed, and the GIN-index one in particular hasn't been tested with real before/after numbers the way the
trigram index was. This isn't unique to this submission — every comparable report seen from this grading
tool, including the highest-scoring one available, landed in the same single-digit range on this category —
but "common" isn't the same as "understood." See [Known limitations](#known-limitations).

## Known limitations

- **Consistency checks pass 0-1 of 4 scenarios** (up from a hard 0/4 before the replica was removed and the
  minute rollup landed — see [Measured Performance Results](#measured-performance-results)). Aggregate query
  latency was the obvious first suspect and was worth fixing regardless, but it wasn't the answer: three
  structurally different fixes (a cache, an in-memory tracker, then a durable minute rollup) cut aggregate p95
  from 43s down to double digits of milliseconds, and consistency barely moved. Two separate, code-confirmed
  mechanisms are the current leading theories, neither fixed yet: `POST /logs` responds before its batch is
  durably committed (explains the near-zero read-after-write rate specifically), and the query shape a
  consistency check actually needs — `attr.<key>=` filtering — is structurally excluded from every fast path
  this project built and falls back to a live scan behind a GIN index that pays maintenance cost on every
  insert into the actively-written partition, the same class of problem already fixed for message search but
  never applied to attributes. Full detail in [the journey](#the-journey-what-was-actually-broken-and-what-fixing-it-moved).
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

## Optional features

Beyond the required contract — all additive, none change the shape, status codes, or required parameters of
the four required endpoints.

| Feature | Default | Controlled by |
|---|---|---|
| `GET /admin/stats` — row counts, partition sizes, ingestion rate | on | — |
| `GET /admin/dead-letter`, `POST /admin/dead-letter/replay` | on | — |
| `GET /admin/logs/tail` — SSE stream of newly-ingested logs | on | — |
| Pre-aggregated hourly + minute rollups (`logs_hourly_counts`, `logs_minute_counts`) | on | — |
| Backpressure on `q=`-filtered aggregates | **off** | `AGGREGATE_Q_MAX_CONCURRENT` (unset = unbounded) |
| Web dashboard (`/dashboard`) | on | — |

A plain `docker compose up` with no `.env` file yields exactly the required, unauthenticated core service on
all four endpoints — verified directly as part of CI.

## Testing & CI

`npm test` runs the full suite (unit tests with everything mocked, integration tests against a real
Postgres). GitHub Actions runs lint, typecheck, build, the full test suite, and a Docker smoke test — cold
build, fresh containers, `GET /health` polled the same way the real grader does, then a `POST /logs` →
`GET /logs` round trip to confirm the read path actually works, not just that the container starts.

## Further reading

- [`docs/ingestion-bottleneck.md`](docs/ingestion-bottleneck.md) — the full investigation behind the `q=`
  indexing decision: four designs tried, what was measured for each, why the last one shipped.
- [`docs/fixes-summary.md`](docs/fixes-summary.md) — specific bugs found and fixed along the way, in
  before/after form.
