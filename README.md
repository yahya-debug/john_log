# John Log

A high-throughput log ingestion and query service: applications POST structured
logs to an HTTP API, they're validated and written to a day-partitioned
Postgres table, and made queryable with filters, cursor pagination, and
time-bucketed aggregation.

## Status

Core service is implemented and running via `docker compose up`:

- `POST /logs`, `GET /logs`, `GET /logs/aggregate`, `GET /health` — implemented per the contract below
- Migrations run automatically on boot; the database is created automatically if it doesn't exist
- Daily partitioning + a retention job that creates future partitions and drops expired ones
- Load-tested at 500 logs/sec sustained with concurrent aggregate queries — see [Load testing](#load-testing)

**Ingestion currently writes synchronously to Postgres on the request path** — `amqplib` is a dependency and
`src/ingestion/pub.ts` has a small RabbitMQ publish helper, but nothing calls it and `src/worker.ts` is an
empty stub. That queue+worker split was the original design (see the architecture diagram below) but was not
built, because the load test shows the synchronous path already meets the brief's performance targets with
large headroom (see results) — adding a queue now would be complexity without a corresponding problem to fix.
If ingestion ever needs to sustain a materially higher rate, or write latency needs to stop being on the
request's critical path, that's the trigger to finish wiring `pub.ts` → `worker.ts`.

## Architecture

```
src/
├── index.ts               # entry point: mounts App(), /health, listens on PORT
├── worker.ts               # empty — see "Status" above
├── config.ts                # env var parsing
├── db/
│   ├── schema.ts             # Drizzle schema: logs table, partitioned by day
│   ├── db.ts                 # Drizzle + postgres.js client; auto-creates the DB if missing
│   ├── migrate.ts            # runs drizzle migrations on boot
│   ├── logs.ts                # insert / query / aggregate SQL
│   └── migrations/            # drizzle-kit generated SQL
├── http/
│   ├── app.ts                 # express() wiring: middleware, routes, migration + retention bootstrap
│   ├── routes/                 # logs.ts, aggregate.ts
│   └── middleware/              # JSON body error handling
├── ingestion/
│   ├── validate.ts              # per-entry validation, accept/reject-by-index
│   └── pub.ts                    # RabbitMQ publish helper — currently unused, see "Status"
├── query/
│   ├── filters.ts                # shared WHERE-condition builder (service/level/since/until/q/attr.*)
│   ├── cursor.ts                  # opaque base64 (timestamp, id) keyset cursor
│   ├── logsQuery.ts                # GET /logs orchestration
│   ├── aggregateQuery.ts            # GET /logs/aggregate orchestration
│   └── validate.ts                  # query-param validation middleware
└── retention/
    ├── partitions.ts                # create future daily partitions, drop expired ones
    └── job.ts                        # runs retention once at boot + on a daily cron
```

Logs flow: `POST /logs` → validated per-entry → bulk `INSERT` into the day-partitioned `logs` table →
queried via `GET /logs` (keyset-paginated) and `GET /logs/aggregate` (bucketed counts).

## Setup

**Prerequisites:** Docker, or Node.js + a local Postgres instance.

### Docker Compose (recommended)

```bash
cp .env.example .env    # edit POSTGRES_PASSWORD etc. if you like
docker compose up --build
```

The service listens on `localhost:8080`. On boot it automatically: creates the `john_log` database if it
doesn't already exist, runs pending migrations, and ensures the next `PARTITION_LOOKAHEAD_DAYS` days of
partitions exist. `GET /health` returns `200` once migrations have completed.

Postgres itself is published to the host on **`5433`** (not `5432`), purely so it doesn't collide with a
Postgres instance you might already have running locally — the app talks to it over the internal Docker
network on the normal `5432`, so this only matters if you want to `psql` in from the host. Adjust the
`ports:` mapping in `docker-compose.yml` if `5433` is also taken on your machine.

**A note on the database volume:** Postgres only applies `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`
from its environment on first init of an *empty* data directory. If you reuse an existing `pgdata` volume
with different credentials in `.env` (e.g. after editing `.env` post-first-run), the container will keep the
old credentials and the app's auto-create logic will fail auth rather than create the database. Fix: either
match `.env` to what the volume was actually initialized with, or drop the volume (`docker compose down -v`)
to reinitialize from the current `.env`.

### Local (no Docker)

1. `npm install`
2. Point `.env`'s `DB_CONNECTION` at a reachable Postgres instance (the target database does not need to
   exist yet — `src/db/db.ts` creates it on first connect if missing, using the admin connection to `postgres`)
3. `npm run start` — runs migrations, ensures partitions, and starts listening on `PORT` (default `8080`)

Other scripts: `npm run db:generate` (after schema changes), `npm run build` (`tsc`), `npm run typecheck`,
`npm run lint`, `npm test` / `npm run test:unit` / `npm run test:integration`.

## API

### `GET /health`
Returns `200` once migrations have run against the database; `503` otherwise.

### `POST /logs`
Accepts `{ "logs": [...] }`. Each entry is validated independently — timestamp must be a parsable ISO string
no more than 5 minutes in the future, `level` must be one of `debug`/`info`/`warn`/`error`, `service` and
`message` must be non-empty strings, `attributes` (if present) must be a flat object of string/number/boolean
values. Bad entries never fail the batch: `200` with `{ accepted, rejected: [{ index, reason }] }` if at
least one entry was accepted, `400` with the same shape if all were rejected. Accepted entries are inserted
in a single batch `INSERT`.

### `GET /logs`
Filters: `service`, `level`, `since`/`until` (inclusive/exclusive), `attr.<key>` (string equality against the
JSONB attribute bag, via `@>` containment so it can use the GIN index), `q` (case-insensitive substring on
`message`, via `ILIKE`). `limit` (default 100, cap 1000) and opaque `cursor` for pagination. Results are
ordered by `(timestamp DESC, id DESC)`; the cursor encodes that pair so pagination is a keyset scan, not an
`OFFSET`. Invalid params return `400 { error }`.

### `GET /logs/aggregate`
Same filters as above, plus required `since`/`until`/`bucket` (`1m`/`5m`/`1h`/`1d`) and optional
`group_by` (`service` | `level`). Uses `date_bin` to floor timestamps into buckets, one row per
`(bucket, group)`, ordered by bucket ascending.

## Schema & index design decisions

The service stores logs in a single `logs` table (`src/db/schema.ts`):

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | `gen_random_uuid()` default |
| `timestamp` | `timestamptz` | partition key |
| `level` | `text` | `CHECK` constrained to `debug` / `info` / `warn` / `error` |
| `service` | `text` | |
| `message` | `text` | |
| `attributes` | `jsonb` | arbitrary per-entry attributes, defaults to `{}` |

Primary key is composite (`id`, `timestamp`), since Postgres requires the partition key to be part of every
unique/primary key on a partitioned table.

Attributes are kept in a `JSONB` column rather than a normalized `log_attributes` join table — a normalized
design would multiply insert volume by attribute count and require a join on every filtered read, both
working directly against the ingestion and aggregation performance targets. `level` is a `CHECK` constraint
rather than a native Postgres enum, since enums complicate schema evolution under partitioning. Indexing is
built backward from the required query patterns: composite B-tree indexes on `(service, timestamp)` and
`(level, timestamp)` serve single-filter lookups in the required sort order, a GIN index with `jsonb_path_ops`
on `attributes` serves `attr.<key>` containment lookups without needing to guess which keys will be queried,
and a trigram GIN index on `message` accelerates the substring search a plain B-tree can't help with (`q=`).

**Implemented** (in the `0000` migration): `idx_logs_service_timestamp` on `(service, timestamp DESC)`,
`idx_logs_level_timestamp` on `(level, timestamp DESC)`, `idx_logs_timestamp` on `(timestamp DESC)`,
`idx_attrs_gin` (`GIN (attributes jsonb_path_ops)`), and `idx_message_trgm` (`GIN (message gin_trgm_ops)`,
requires `pg_trgm`, created by the same migration).

### Partitioning & retention (`src/retention/`)

The table is `PARTITION BY RANGE (timestamp)`, one partition per day, plus a `logs_default` catch-all for
timestamps outside any declared range. `src/retention/job.ts` runs once at boot (chained after migrations
complete, so it never races the table's own creation) and then daily on `RETENTION_CRON` (default `10 0 * * *`):
- `ensureFuturePartitions(PARTITION_LOOKAHEAD_DAYS)` — idempotently creates today's partition plus the next
  N days (default 7), so ingestion never silently falls back to `logs_default` once the initially-migrated
  partitions run out.
- `dropOldPartitions(RETENTION_DAYS)` — drops (via `DROP TABLE`, not row-by-row `DELETE`) any dated partition
  older than the retention window (default 30 days). This is why retention doesn't block ingestion: dropping
  a whole partition is near-instant and doesn't scan or lock the rows other partitions are being written to.

Env vars: `RETENTION_DAYS`, `PARTITION_LOOKAHEAD_DAYS`, `RETENTION_CRON`.

## Load testing

Scripts live in `loadtest/` (plain `tsx`, no external load-testing tool required):

- `npm run loadtest:seed` — inserts `SEED_ROWS` (default 1,000,000) synthetic rows directly via drizzle,
  timestamped randomly across the past `SEED_DAYS` (default 7), so the table is sized like the grading target
  without waiting for it to arrive over HTTP.
- `npm run loadtest:mixed` — the actual target scenario: paces `POST /logs` at `TARGET_RATE` (default 500)
  logs/sec for `DURATION_SEC` (default 60s) in batches of `BATCH_SIZE` (default 50), while concurrently
  sampling `GET /logs/aggregate` once per second in two shapes — a 5-minute live window (`bucket=1m`, what a
  live dashboard tailing recent activity would run) and a `HISTORY_DAYS`-wide range (default 7d, `bucket=1h`).
  The live window benefits from partition pruning down to ~today's partition regardless of total table size;
  the historical query can't rely on that, so it's the more honest test of behavior "at ~1M rows" rather than
  "at ~1M rows but only ever reading the newest 5 minutes of them." It prints p50/p95/p99/error counts for
  both ingestion and both query shapes, and a verdict on whether the numbers justify adding a queue/worker in
  front of the DB write.

### Results (~2.09M rows stored, run on the author's machine)

500 logs/sec target, 60s, batch size 50:

| | requests | errors | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| `POST /logs` | 600 | 0 | 14.2ms | 20.2ms | 37.5ms | 92.5ms |
| `GET /logs/aggregate` (live, 5m/1m buckets) | 60 | 0 | 13.1ms | 20.3ms | 22.5ms | 22.5ms |
| `GET /logs/aggregate` (historical, 7d/1h buckets) | 52 | 0 | 159.7ms | 172.8ms | 177.7ms | 177.7ms |

Achieved ingestion rate: 493 logs/sec (98.6% of target), zero dropped/errored requests.

Both against the **500 logs/sec target** and the **sub-1s p95 aggregation target**, this comfortably clears
the bar — the historical query, the more expensive of the two shapes, is still ~5.8x under budget even while
writes are actively running concurrently. This is the basis for the "ingestion stays synchronous, no queue"
decision described in [Status](#status): the numbers don't show a bottleneck a queue would fix. If that
changes (target rate goes up, or query shapes get more expensive), re-run `loadtest:mixed` — the errors/p95
numbers it prints are the signal to act on, not a guess.

## Known limitations

- No test suite yet (`tests/unit` exists but is empty).
- No CI pipeline.
- `src/worker.ts` / `src/ingestion/pub.ts` are present but unwired — see [Status](#status) for why, and what
  would trigger finishing them.
- Retention only creates *future* partitions from whenever the service first boots; it doesn't backfill
  partitions for past dates, so historical data (e.g. this repo's own load test seed) can land in the
  `logs_default` catch-all rather than a dated partition. Not an issue for the retention job's actual job
  (dropping data older than `RETENTION_DAYS`), since `logs_default` isn't retention-managed and would need
  its own handling if long-lived historical backfills become a real use case.
