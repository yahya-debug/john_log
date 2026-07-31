# John Log

A high-throughput log ingestion and query service: applications POST structured
logs to an HTTP API, they're validated and written to a day-partitioned
Postgres table, and made queryable with filters, cursor pagination, and
time-bucketed aggregation.

## Status

Core service is implemented and running via `docker compose up`:

- `POST /logs`, `GET /logs`, `GET /logs/aggregate`, `GET /health` — implemented per the contract below
- Migrations run automatically on boot; the database is created automatically if it doesn't exist
- Daily partitioning + a retention job that creates future partitions, drops expired ones, and reconciles
  any stray rows sitting in `logs_default` — see [Partitioning & retention](#partitioning--retention-srcretention)
- A manual-only admin endpoint (`POST /admin/logs/backfill`) for inserting historical data that normal
  ingestion rejects — see the same section
- Load-tested at 500 logs/sec sustained with concurrent aggregate queries — see [Load testing](#load-testing)
- GitHub Actions CI (`.github/workflows/ci.yml`): lint + typecheck + build + full test suite against a real
  Postgres service container, plus a separate job that builds and boots the actual `docker-compose.yml` stack
  and smoke-tests ingestion against it

**Ingestion currently writes synchronously to Postgres on the request path** — `amqplib` is a dependency but
nothing publishes to or consumes from a queue; there's no worker process. That queue+worker split was the
original design (see the architecture diagram below) but was not built, because the load test shows the
synchronous path already meets the brief's performance targets with large headroom (see results) — adding a
queue now would be complexity without a corresponding problem to fix. If ingestion ever needs to sustain a
materially higher rate, or write latency needs to stop being on the request's critical path, that's the
trigger to build it.

## Architecture

```
src/
├── index.ts               # entry point: mounts App(), /health, listens on PORT
├── config.ts                # env var parsing
├── db/
│   ├── schema.ts             # Drizzle schema: logs table, partitioned by day
│   ├── db.ts                 # Drizzle + postgres.js client; auto-creates the DB if missing
│   ├── migrate.ts            # runs drizzle migrations on boot
│   ├── logs.ts                # insert / query / aggregate SQL
│   ├── stats.ts                # per-partition row counts/sizes, rates, retention config (GET /admin/stats)
│   └── migrations/            # drizzle-kit generated SQL
├── http/
│   ├── app.ts                 # express() wiring: middleware, routes, migration + retention bootstrap
│   ├── routes/                 # logs.ts, aggregate.ts, admin.ts
│   └── middleware/              # JSON body error handling
├── ingestion/
│   └── validate.ts              # per-entry validation, accept/reject-by-index, retention-window floor
├── query/
│   ├── filters.ts                # shared WHERE-condition builder (service/level/since/until/q/attr.*)
│   ├── cursor.ts                  # opaque base64 (timestamp, id) keyset cursor
│   ├── logsQuery.ts                # GET /logs orchestration
│   ├── aggregateQuery.ts            # GET /logs/aggregate orchestration
│   └── validate.ts                  # query-param validation middleware
└── retention/
    ├── partitions.ts                # create future partitions, drop expired ones, backfill/reconcile logs_default
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

### Deploying to GCP (GKE + Cloud SQL)

Manifests live in `k8s/`. The app runs as a `Deployment` (`k8s/deployment.yaml`) with a
[Cloud SQL Auth Proxy](https://github.com/GoogleCloudSQL/cloud-sql-proxy) sidecar in the same pod, so the app
container always talks to Postgres over `127.0.0.1:5432` regardless of the Cloud SQL instance's real address —
`DB_CONNECTION` (in `k8s/secret.example.yaml`) points there. No separate migration `Job` is needed: the app
runs migrations on boot exactly like it does under `docker compose` (`src/http/app.ts` → `runMigration()`),
so a rolling deploy just re-runs that same idempotent step in each new pod.

**One-time GCP setup** (needs `gcloud` authenticated to your project):

```bash
PROJECT_ID=<your-project-id>
REGION=us-central1

gcloud config set project "$PROJECT_ID"
gcloud services enable container.googleapis.com sqladmin.googleapis.com \
  artifactregistry.googleapis.com sqlcomponent.googleapis.com

# Artifact Registry repo for the app image
gcloud artifacts repositories create john-log \
  --repository-format=docker --location="$REGION"

# GKE Autopilot — no node pools to manage, fastest path to a working cluster
gcloud container clusters create-auto john-log-cluster --region "$REGION"

# Cloud SQL Postgres instance + database
gcloud sql instances create john-log-db \
  --database-version=POSTGRES_16 --region="$REGION" --tier=db-f1-micro
gcloud sql databases create john_log --instance=john-log-db
gcloud sql users set-password postgres --instance=john-log-db --password=<db-password>

# Service account the cloud-sql-proxy sidecar authenticates as
gcloud iam service-accounts create john-log-cloudsql
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:john-log-cloudsql@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/cloudsql.client"
gcloud iam service-accounts keys create k8s/cloudsql-sa-key.json \
  --iam-account="john-log-cloudsql@${PROJECT_ID}.iam.gserviceaccount.com"
```

Then wire up the cluster (namespace/config first, secrets are never committed):

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml   # first fill in INSTANCE_CONNECTION_NAME from:
                                       #   gcloud sql instances describe john-log-db --format='value(connectionName)'

kubectl create secret generic cloudsql-sa-key \
  --from-file=key.json=k8s/cloudsql-sa-key.json -n john-log

cp k8s/secret.example.yaml k8s/secret.yaml   # fill in the real DB user/password, then:
kubectl apply -f k8s/secret.yaml
```

**GitHub Actions secrets** (repo Settings → Secrets and variables → Actions) needed for `.github/workflows/cd.yml`:
`GCP_PROJECT_ID`, and `GCP_SA_KEY` (a JSON key for a service account with `roles/container.developer` and
`roles/artifactregistry.writer` — separate from the cloud-sql-proxy service account above). The `cd` workflow
triggers on every successful `ci` run on `main`: it builds and pushes the image to Artifact Registry, applies
the manifests, then rolls the `Deployment` to the new image tag.

First deploy only, since `cd.yml` assumes the `Deployment` already exists to `set image` on:
```bash
kubectl apply -f k8s/deployment.yaml   # uses the placeholder image, just to create the object
kubectl apply -f k8s/service.yaml
```

`kubectl get service john-log-service -n john-log` once the `LoadBalancer` has an external IP assigned.

## API

### `GET /health`
Returns `200` once migrations have run against the database; `503` otherwise.

### `POST /logs`
Accepts `{ "logs": [...] }`. Each entry is validated independently — timestamp must be a parsable ISO string
no more than 5 minutes in the future **and no older than `RETENTION_DAYS`** (rejected with `"timestamp is
older than the retention window (N days)"` otherwise — see [Partitioning &
retention](#partitioning--retention-srcretention) for why), `level` must be one of `debug`/`info`/`warn`/`error`,
`service` and `message` must be non-empty strings, `attributes` (if present) must be a flat object of
string/number/boolean values. Bad entries never fail the batch: `200` with `{ accepted, rejected: [{ index,
reason }] }` if at least one entry was accepted, `400` with the same shape if all were rejected. Accepted
entries are inserted in a single batch `INSERT`.

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

### `POST /admin/logs/backfill` — not part of the required contract
The one way past `POST /logs`'s retention-window rejection. Same request/entry shape as `POST /logs`, but
timestamps older than `RETENTION_DAYS` are allowed through validation — though not inserted: anything still
older than the window is silently discarded rather than stored (there'd be no point; the next retention sweep
would just drop it again). Entries within the window get their target partition created on demand (see
below) and are inserted normally. Response: `{ accepted, discarded, rejected }`, `200` if anything was
inserted, `400` otherwise. Manual/operator-triggered only — nothing in the codebase calls this on a schedule.

### `GET /admin/stats` — not part of the required contract
Everything worth knowing about the current state of the store, in one response:
- `totals` — total row count plus breakdowns by `level` and by `service` (every distinct value, not a top-N)
- `partitions` — every partition of `logs`, **including `logs_default`**, each with its bound (`FOR VALUES
  FROM/TO`, or `DEFAULT`), row count, and on-disk size in bytes. `pg_total_relation_size` on a partitioned
  table itself always returns 0 — all storage lives in the child partitions — so this is computed per
  partition and summed for the totals, not asked of `logs` directly.
- `time_range` — oldest/newest stored timestamp
- `ingestion_rate` — rows in the last 1 and 5 minutes, plus a rough rows/sec figure
- `retention_config` — the actual running `RETENTION_DAYS` / `PARTITION_LOOKAHEAD_DAYS` / `RETENTION_CRON`
- `database_size_bytes` — sum of every partition's on-disk size

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

### Proving it with `EXPLAIN` (run against the ~3M-row dev database)

`GET /logs?service=checkout` — every partition scan in the plan uses the composite index, not a sequential scan:
```
Index Scan using logs_2026_07_28_service_timestamp_idx on logs_2026_07_28
  Index Cond: (service = 'checkout'::text)
```

`GET /logs?level=error` — same shape, via `idx_logs_level_timestamp`:
```
Index Scan using logs_2026_07_28_level_timestamp_idx on logs_2026_07_28
  Index Cond: (level = 'error'::text)
```

`GET /logs?attr.user_id=42` — the GIN index turns the JSONB containment check into a `Bitmap Index Scan`
instead of evaluating `@>` against every row:
```
Bitmap Heap Scan on logs_2026_07_28
  ->  Bitmap Index Scan on logs_2026_07_28_attributes_idx
        Index Cond: (attributes @> '{"user_id": "42"}'::jsonb)
```

`GET /logs?q=declined` — same `Bitmap Index Scan` shape, via the trigram index, which is what makes a
leading-wildcard `ILIKE '%declined%'` (a plain B-tree can't help with this at all) reasonably fast:
```
Bitmap Heap Scan on logs_2026_07_21
  ->  Bitmap Index Scan on logs_2026_07_21_message_idx
        Index Cond: (message ~~* '%declined%'::text)
```

`GET /logs/aggregate?since=2026-07-28T00:00:00Z&until=2026-07-29T00:00:00Z&bucket=1h` — the one-day range
prunes to a *single* partition at planning time; the other 17 don't appear in the plan at all, not even as
skipped branches:
```
HashAggregate (actual time=96.326..96.447 rows=144)
  Group Key: date_bin(...), logs.service
  ->  Seq Scan on logs_2026_07_28 logs  (actual time=0.038..48.461 rows=463328)
        Filter: (("timestamp" >= ...) AND ("timestamp" < ...))
Execution Time: 97.320 ms
```
The `Seq Scan` here is correct, not a missed index: the query aggregates ~463k of ~463k rows in that one
partition (a 100% selectivity date-range aggregate), where a full scan of the one pruned-to partition beats
an index scan. What's being verified is the pruning — one partition touched instead of eighteen.

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
- `reconcileDefaultPartition(RETENTION_DAYS)` — sweeps every distinct date currently sitting in
  `logs_default` and resolves each one: deletes it outright if it's already past the retention window (no
  point creating a partition just to drop it again tomorrow), otherwise backfills it into its own partition
  via `backfillPartitionForDate`.

**Why `logs_default` ever has anything in it, given the 5-minute-future check on ingestion:** that check has
no floor — nothing rejected backdated timestamps until the retention-window rule below was added. A client
replaying buffered logs after an outage, clock skew, or (in this repo's case) the load-test seed script
backdating rows for realism could all land data on a date with no matching partition, since partitions only
ever get created forward from "today."

**`backfillPartitionForDate(date)` — how it actually creates a partition Postgres would otherwise refuse:**
Postgres validates a default partition's contents against every sibling partition's bounds, including a
brand new one — so `CREATE TABLE ... PARTITION OF logs FOR VALUES FROM (...) TO (...)` is rejected outright
if `logs_default` already holds rows in that range (`updated partition constraint for default partition
"logs_default" would be violated by some row`). The fix is to detach `logs_default` first (there's briefly no
default partition for anything to conflict with), create the partition, move the matching rows out of the
now-standalone `logs_default` and back through `logs` — routing them into the partition that now exists —
and *then* reattach `logs_default`. That ordering matters: reattaching runs the same validation again, so
reattaching before moving the matching rows out fails with the identical error, just on the way back in
rather than the way in. The whole sequence runs inside one transaction gated by a transaction-scoped
`pg_advisory_xact_lock`, for two reasons found the hard way while building this: a failed step rolls the
detach back too instead of leaving `logs_default` permanently orphaned, and two callers racing on
`logs_default` at once (e.g. the daily cron and a manual admin backfill overlapping) serialize instead of one
of them hitting "relation logs_default is not a partition of relation logs".

**Ingestion validation + the admin backfill endpoint are the other half of this.** `src/ingestion/validate.ts`
now rejects any `POST /logs` entry older than `RETENTION_DAYS` outright, so normal traffic can no longer add
to the `logs_default` backlog going forward. The only sanctioned way to insert genuinely old data is
`POST /admin/logs/backfill` (manual/operator-triggered only, never scheduled), which reuses
`backfillPartitionForDate` to create the destination partition before inserting, and — matching
`reconcileDefaultPartition`'s "past-retention data isn't worth keeping" rule — discards rather than inserts
anything still older than the window.

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

## Testing

`tests/unit/` (111 tests) covers pure logic and orchestration with no live DB required — entry/batch
validation (including the retention-window rule and `allowStale`), cursor encode/decode, query-param
validation middleware, the `commandCondition`/`combineConditions` SQL builders (rendered through `PgDialect`
to assert on actual query text/params without a connection), `runQuery`/`runAggregate` orchestration, and the
HTTP routes (`logs`, `aggregate`, `admin` — including `/admin/stats`) with the DB layer mocked out via `vi.mock`.

`tests/integration/` (48 tests) runs against a real Postgres (`DB_CONNECTION` from `.env`) with no mocks:
`insertLogs`/`queryLogs`/`aggregateLogs` end-to-end, `ensureFuturePartitions`/`dropOldPartitions`/
`backfillPartitionForDate`/`reconcileDefaultDate`/`reconcileDefaultPartition` against the real partition
catalog, `getStats` against real per-partition data, and the full `POST /logs` → `GET /logs` → `GET
/logs/aggregate` → `GET /admin/stats` round trip — including walking cursor pagination page-by-page — through
the real `App()`. Each test file tags its rows with a unique `service` value and deletes them in `afterAll`,
so the suite is safe to run against a database that already holds real or seeded data.

`npm test` runs everything, `npm run test:unit` / `npm run test:integration` run one or the other (the latter
needs Postgres reachable — `docker compose up -d postgres` is enough, the app container isn't required).

Two concurrency bugs surfaced by actually running this suite, at two different levels:

1. **In the implementation itself**: `tests/integration/http/app.test.ts` constructs a real `App()`, which
   fires `retain()` as a side effect, and vitest runs test files in parallel by default — so it raced
   `tests/integration/retention/partitions.test.ts` calling `backfillPartitionForDate` directly, both
   detaching the same `logs_default` at once. Fixed in `src/retention/partitions.ts` itself (transaction +
   `pg_advisory_xact_lock`), not by changing how tests run, since the same collision could happen for real
   between the daily cron and a manual admin backfill.
2. **In test isolation, not the implementation**: even serialized against Postgres, `retain()`'s
   `reconcileDefaultPartition` sweeps *every* distinct date in `logs_default` — so `App()`'s side effect in
   one test file could consume synthetic stray rows another file had just inserted for its own scenario,
   before that file got to assert on them. That one genuinely is a test-suite property, not a bug in the
   running service (a real deployment only ever has one `retain()` and no test files inserting competing
   fixtures into the same table) — `vitest.config.ts` sets `fileParallelism: false` because of it.

## Known limitations

- No worker process — ingestion writes synchronously on the request path. See [Status](#status) for why a
  queue/worker split wasn't built, and what would trigger building it.
- `POST /admin/logs/backfill` has no authentication — it's gated only by not being part of the required
  contract and not being called from anywhere automated. Fine for this project's scope; a real deployment
  would want to put it behind an API key or similar before exposing it.
- `reconcileDefaultPartition` processes one distinct date per `backfillPartitionForDate` call — each one
  briefly detaches/reattaches `logs_default` (see [Partitioning &
  retention](#partitioning--retention-srcretention)). Fine for the handful of dates this repo actually
  produces, but if `logs_default` ever accumulated stray data across dozens/hundreds of distinct dates, that's
  the same number of detach/reattach cycles in one daily run — batching multiple dates into a single
  detach/reattach pair would be the next optimization if that ever becomes real.
