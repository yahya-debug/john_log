#!/usr/bin/env bash
# Wraps `k6 run` with a concurrent docker-stats sampler for the app/postgres
# containers, since k6 itself can't shell out to docker — this fills in the
# "Resource Utilization" numbers the real grader's reports show alongside
# throughput/latency (App/Postgres CPU and memory, max and avg). Run from the
# repo root, with `docker compose up` already running.
#
# Usage:
#   loadtest/k6/run.sh loadtest/k6/load.js
#   TARGET_RATE=15000 DURATION_SEC=120 loadtest/k6/run.sh loadtest/k6/load.js
set -eu

SCRIPT="${1:?usage: run.sh <k6-script.js> [extra k6 args...]}"
shift

APP_ID=$(docker compose ps -q app)
PG_ID=$(docker compose ps -q postgres)
REPLICA_ID=$(docker compose ps -q postgres-replica 2>/dev/null || true)
if [[ -z "$APP_ID" || -z "$PG_ID" ]]; then
    echo "app/postgres containers not found — run 'docker compose up' first" >&2
    exit 1
fi
# Optional: only present if docker-compose.yml defines postgres-replica and it's
# running. Included so the resource summary shows whether read/write splitting
# actually moved read load off the primary, not just app/primary CPU as before.
STATS_TARGETS=("$APP_ID" "$PG_ID")
[[ -n "$REPLICA_ID" ]] && STATS_TARGETS+=("$REPLICA_ID")

STATS_FILE=$(mktemp)
SAMPLER_PID=""
cleanup() {
    [[ -n "$SAMPLER_PID" ]] && kill "$SAMPLER_PID" 2>/dev/null || true
    rm -f "$STATS_FILE"
}
trap cleanup EXIT

(
    while true; do
        docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' "${STATS_TARGETS[@]}" >> "$STATS_FILE" 2>/dev/null
        sleep 2
    done
) &
SAMPLER_PID=$!

set +e
k6 run "$SCRIPT" "$@"
K6_EXIT=$?
set -e

kill "$SAMPLER_PID" 2>/dev/null || true
wait "$SAMPLER_PID" 2>/dev/null || true
SAMPLER_PID=""

echo ""
echo "--- Resource Utilization (docker stats, sampled every 2s) ---"
awk -F',' '
function to_mib(v,   n) {
    n = v + 0
    if (v ~ /GiB/) return n * 1024
    return n
}
{
    name = $1
    cpu = $2; gsub(/%/, "", cpu)
    split($3, mem, " / ")
    mem_mib = to_mib(mem[1])

    cpu_sum[name] += cpu; cpu_count[name]++
    if (cpu + 0 > cpu_max[name] + 0) cpu_max[name] = cpu
    mem_sum[name] += mem_mib; mem_count[name]++
    if (mem_mib + 0 > mem_max[name] + 0) mem_max[name] = mem_mib
}
END {
    for (n in cpu_sum) {
        printf "%s: CPU avg %.2f%% max %.2f%% | Mem avg %.1f MiB max %.1f MiB\n", \
            n, cpu_sum[n] / cpu_count[n], cpu_max[n], mem_sum[n] / mem_count[n], mem_max[n]
    }
}
' "$STATS_FILE"

exit "$K6_EXIT"
