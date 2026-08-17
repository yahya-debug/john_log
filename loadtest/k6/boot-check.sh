#!/usr/bin/env bash
# Reproduces the exact failure a real submission hit: "Service failed to start:
# health check did not respond within 2 minutes." None of the k6 scenarios in
# this directory catch that — they all assume the stack is already up and
# healthy before they start. This is a fresh-boot check, not a load test: it
# does `docker compose down -v && up --build` (matching a real grading run,
# not a dev volume already warmed up) and polls GET /health, failing if it
# doesn't return 200 within the same budget the real grader enforced.
#
# The bug this actually caught: adding the read-replica service made `app`
# wait on *both* postgres and postgres-replica reaching healthy before it
# would even start — serializing the app's own boot behind the replica's full
# pg_basebackup clone. Fixed by only depending on the primary (see
# docker-compose.yml's app service) since nothing at startup touches the
# replica. This script is what would have caught that before submitting,
# instead of finding out from the real grader.
#
# Usage:
#   loadtest/k6/boot-check.sh
#   BOOT_TIMEOUT_SEC=90 loadtest/k6/boot-check.sh
set -eu

TIMEOUT_SEC="${BOOT_TIMEOUT_SEC:-120}"  # matches the real grader's own 2-minute budget
BASE_URL="${BASE_URL:-http://localhost:8080}"

echo "boot-check: fresh docker compose down -v && up --build (not a warm dev volume — a real grading run starts from nothing)"
docker compose down -v
docker compose up --build -d

START=$(date +%s)
DEADLINE=$((START + TIMEOUT_SEC))

while true; do
    NOW=$(date +%s)
    if [[ $NOW -ge $DEADLINE ]]; then
        echo ""
        echo "FAIL: GET ${BASE_URL}/health did not return 200 within ${TIMEOUT_SEC}s"
        echo "(this is the exact failure mode the real load generator reported)"
        echo ""
        docker compose ps
        exit 1
    fi

    CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/health" 2>/dev/null || echo "000")
    if [[ "$CODE" == "200" ]]; then
        ELAPSED=$((NOW - START))
        echo ""
        echo "PASS: /health returned 200 after ${ELAPSED}s (budget: ${TIMEOUT_SEC}s)"
        docker compose ps
        exit 0
    fi

    sleep 1
done
