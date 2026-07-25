# John Log

A high-throughput log ingestion and query service: logs are accepted over HTTP, queued through RabbitMQ, batch-written to Postgres by a worker, and made queryable with filtering, full-text-ish search, and aggregation.

> **Status:** this repository currently contains the database layer only — the `logs` table schema and its first Drizzle migration. The API, worker, ingestion pipeline, and load tests described below are the designed target architecture (see `tree.txt`) and are not yet implemented in `src/`. Sections are marked accordingly so this doc stays accurate as the rest of the service gets built.

## Architecture

```
src/
├── index.ts            # API entry point (Express, port 8080)          [planned]
├── worker.ts            # Worker entry point (RabbitMQ consumer)        [planned]
├── config/               # env var parsing/validation                   [planned]
├── db/
│   ├── schema.ts         # Drizzle schema: logs table                   ✅ implemented
│   ├── client.ts         # Drizzle + pg.Pool instance                   [planned]
│   ├── migrate.ts        # runs migrations on boot                      [planned]
│   └── migrations/       # drizzle-kit generated SQL                    ✅ implemented
├── http/routes/          # health, logs, aggregate, stats               [planned]
├── ingestion/            # validation, RabbitMQ publisher                [planned]
├── query/                # filter/cursor/aggregate query builders        [planned]
├── worker/                # queue consumer + batch inserter              [planned]
└── retention/             # partition create/drop, cron job              [planned]
```

Logs flow: `POST /logs` → validated → published to RabbitMQ → worker batches and bulk-inserts into a daily-partitioned Postgres table → queried via `GET /logs` and `GET /logs/aggregate`.

## Setup

**Prerequisites:** Node.js, a Postgres instance (with the `pg_trgm` extension available for the planned trigram index).

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure the database connection. Create a `.env` file with:
   ```
   DB_CONNECTION=postgres://user:password@host:5432/dbname
   ```
   This is read by `drizzle.config.ts` and (once implemented) `src/config/env.ts`.
3. Run migrations:
   ```bash
   npm run db:migrate
   ```
   > ⚠️ The current migration (`src/db/migrations/0000_colossal_sharon_ventura.sql`) has a quoting bug: `PARTITION BY RANGE ('timestamp')` and `PRIMARY KEY ('id', 'timestamp')` use single-quoted string literals instead of column identifiers, which Postgres will reject. This needs to be fixed (unquoted/double-quoted `timestamp`/`id`) before the migration will apply cleanly.
4. After changing `src/db/schema.ts`, regenerate a migration with:
   ```bash
   npm run db:generate
   ```
5. Build:
   ```bash
   npm run build
   ```
6. Tests:
   ```bash
   npm test
   ```
   (runs `vitest --run`; no test files exist in the repo yet — `tests/` from the architecture doc hasn't been created.)

There is currently no `start`/`dev` script since `src/index.ts` and `src/worker.ts` don't exist yet.

## API (planned)

None of these routes are implemented yet — this is the designed surface based on the query builders described in the architecture (`query/filters.ts`, `query/cursor.ts`, `query/aggregateQuery.ts`).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness/readiness check, gated on migrations having run |
| `POST` | `/logs` | Ingest one or more log entries; validated then published to RabbitMQ |
| `GET` | `/logs` | Query logs with filters, keyset-paginated |
| `GET` | `/logs/aggregate` | Bucketed aggregation (e.g. counts per interval, grouped by a field) |
| `GET` | `/stats` | Operational stats: queue depth, current ingestion rate |

**`GET /logs` query parameters (planned):**
- `service` — exact match on `service`
- `level` — exact match on `level` (`debug` \| `info` \| `warn` \| `error`)
- `since`, `until` — timestamp range bounds
- `attr.<key>` — filter on a top-level key inside the `attributes` JSONB column (e.g. `attr.user_id=123`)
- `q` — substring search against `message`
- `cursor` — opaque base64 cursor encoding `(timestamp, id)` for keyset pagination

**`GET /logs/aggregate` query parameters (planned):**
- Same filter parameters as `GET /logs`
- `bucket` — time bucket size for the aggregation window
- `group_by` — field to group counts by within each bucket

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

Primary key is composite (`id`, `timestamp`), since Postgres requires the partition key to be part of every unique/primary key on a partitioned table.

We store logs in a single `logs` table, partitioned by day on `timestamp`, with arbitrary log attributes kept in a `JSONB` column rather than a normalized `log_attributes` join table — a normalized design would multiply insert volume by attribute count and require a join on every filtered read, both working directly against the project's 500 logs/sec ingestion and sub-1s aggregation targets. `level` is constrained via a `CHECK` constraint rather than a native Postgres enum, since enums complicate schema evolution under partitioning. Indexing is built backward from the required query patterns rather than applied generically: composite B-tree indexes on `(service, timestamp)` and `(level, timestamp)` serve single-filter lookups in the required sort order, targeted expression indexes cover the attribute keys we expect to be queried most (`user_id`, `request_id`, `region`), a GIN index with `jsonb_path_ops` provides indexed fallback coverage for any other attribute key so correctness doesn't depend on guessing which keys will be tested, and a trigram GIN index on `message` accelerates the substring search a plain B-tree can't help with. Daily partitioning additionally makes retention a near-instant `DROP TABLE` per partition rather than a row-by-row `DELETE`, and enables partition pruning on the time-ranged queries the aggregation endpoint always requires.

**Currently implemented** (in the `0000` migration): `idx_logs_service_timestamp` on `(service, timestamp DESC)`, `idx_logs_level_timestamp` on `(level, timestamp DESC)`, and `idx_logs_timestamp` on `(timestamp DESC)`.

**Not yet migrated** (roadmap per the rationale above): expression indexes on frequently-filtered `attributes` keys (`user_id`, `request_id`, `region`), a `GIN (attributes jsonb_path_ops)` index for other attribute keys, a trigram `GIN` index on `message` (requires `CREATE EXTENSION pg_trgm`), and the partition management (`retention/partitions.ts`) that creates/drops daily partitions.

## Load testing (planned, not yet run)

The architecture calls for two k6 scripts:
- `loadtest/ingest.js` — sustained `POST /logs` at a target rate
- `loadtest/mixed.js` — ingestion running concurrently with querying

Target: 500 logs/sec sustained ingestion, sub-1s response on the aggregation endpoint. No `loadtest/` directory exists in this repo yet, so **no load test results are available to report**. This section will be filled in with real numbers once the API and worker are implemented and the load test scripts are run against them.
