#!/bin/bash
# Postgres starts with empty folder, this tells it to create brand new database
# replica needs a copy of our primary one
# pg_basebackup takes a full copy
# -R flag tells it to keep following the primary
set -e

REPL_USER="${REPLICATION_USER:-replicator}"
REPL_PASSWORD="${REPLICATION_PASSWORD:-replicator_pw}"

if [ -z "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
    echo "replica: empty data directory, cloning from primary ($PRIMARY_HOST) via pg_basebackup"
    until PGPASSWORD="$REPL_PASSWORD" pg_basebackup \
        -h "$PRIMARY_HOST" -U "$REPL_USER" \
        -D "$PGDATA" -Fp -Xs -P -R -w; do
        echo "replica: primary not ready yet (or basebackup failed), retrying in 2s..."
        sleep 2
    done
    chmod 0700 "$PGDATA"
    echo "replica: basebackup complete, starting in standby mode"
fi

exec docker-entrypoint.sh "$@"
