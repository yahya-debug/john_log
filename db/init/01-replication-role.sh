#!/bin/bash
# RUNS once, creates the login that allows the replica to copy data
set -e

REPL_USER="${REPLICATION_USER:-replicator}"
REPL_PASSWORD="${REPLICATION_PASSWORD:-replicator_pw}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${REPL_USER}') THEN
            CREATE ROLE ${REPL_USER} WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}';
        END IF;
    END
    \$\$;
EOSQL

# permission rule, Postgres will refuse replica if this is not done, even with right credentianls
echo "host replication ${REPL_USER} all md5" >> "$PGDATA/pg_hba.conf"
