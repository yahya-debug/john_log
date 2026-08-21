import { useEffect, useState } from "react";
import { Panel } from "../components/Blueprint";
import { getStats } from "../api";
import type { Level, Stats } from "../types";
import { levelColor } from "../styles/tokens";
import { fmt, bytes } from "../format";

const LEVELS: Level[] = ["debug", "info", "warn", "error"];
const mono = "ui-monospace, Consolas, monospace";

export default function StatsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Store overview</h3>
        <span style={{ font: `400 12px/1 ${mono}`, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>
          GET /admin/stats
        </span>
      </div>
      <p className="text-muted" style={{ fontSize: 13, maxWidth: "70ch" }}>
        Per-partition sizes, exact totals by level and service, the stored time range and the retention config
        driving all of it.
      </p>

      {error && (
        <p style={{ fontSize: 13, color: "var(--color-accent-900)" }}>failed to load stats: {error}</p>
      )}
      {!error && !stats && <p className="text-muted" style={{ fontSize: 13 }}>loading…</p>}

      {stats && <StatsBody stats={stats} />}
    </div>
  );
}

function StatsBody({ stats }: { stats: Stats }) {
  const levelMax = Math.max(1, ...LEVELS.map((l) => stats.totals.by_level[l] ?? 0));
  const levelBars = LEVELS.map((l) => {
    const count = stats.totals.by_level[l] ?? 0;
    return { name: l, count: fmt(count), pct: Math.round((count / levelMax) * 100), color: levelColor[l] };
  });

  const serviceEntries = Object.entries(stats.totals.by_service).sort((a, b) => b[1] - a[1]);
  const svcMax = Math.max(1, ...serviceEntries.map(([, v]) => v));
  const serviceBars = serviceEntries.map(([name, count]) => ({
    name,
    count: fmt(count),
    pct: Math.round((count / svcMax) * 100),
  }));

//   Key Performance Indicators — the four tiles on the Stats screen (totals.rows, per_second_1m, database_size_bytes, partitions) are the numbers summarizing store health
  const kpis = [
    { label: "totals.rows", value: fmt(stats.totals.rows), note: "exact · summed from by_level" },
    {
      label: "per_second_1m",
      value: stats.ingestion_rate.per_second_1m.toFixed(1),
      note: `${fmt(stats.ingestion_rate.last_1m)} in the last minute`,
    },
    { label: "database_size_bytes", value: bytes(stats.database_size_bytes), note: "summed per partition" },
    { label: "partitions", value: String(stats.partitions.length), note: "incl. logs_default" },
  ];

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 26, margin: "24px 0 34px" }}>
        {kpis.map((k) => (
          <Panel key={k.label} style={{ padding: "18px 18px 16px" }}>
            <div
              style={{
                font: `400 10px/1 var(--font-body)`,
                letterSpacing: ".12em",
                textTransform: "uppercase",
                color: "var(--color-accent-700)",
              }}
            >
              {k.label}
            </div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 38, lineHeight: 1.05, marginTop: 10 }}>
              {k.value}
            </div>
            <div
              style={{
                font: `400 11px/1.4 ${mono}`,
                color: "color-mix(in srgb, var(--color-text) 55%, transparent)",
                marginTop: 6,
              }}
            >
              {k.note}
            </div>
          </Panel>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 26, marginBottom: 34 }}>
        <Panel>
          <h5 style={{ margin: "0 0 4px" }}>totals.by_level</h5>
          <div className="text-muted" style={{ font: `400 11px/1 ${mono}`, marginBottom: 16 }}>
            exact — summed from the GROUP BY
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {levelBars.map((l) => (
              <div key={l.name} style={{ display: "grid", gridTemplateColumns: "64px 1fr 96px", alignItems: "center", gap: 12 }}>
                <span style={{ font: `400 12px/1 ${mono}`, letterSpacing: ".06em", textTransform: "uppercase" }}>
                  {l.name}
                </span>
                <span style={{ height: 10, background: "color-mix(in srgb, var(--color-text) 7%, transparent)", display: "block" }}>
                  <span style={{ display: "block", height: 10, width: `${l.pct}%`, background: l.color }} />
                </span>
                <span style={{ font: `400 12px/1 ${mono}`, textAlign: "right" }}>{l.count}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <h5 style={{ margin: "0 0 4px" }}>totals.by_service</h5>
          <div className="text-muted" style={{ font: `400 11px/1 ${mono}`, marginBottom: 16 }}>
            ordered by count desc
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {serviceBars.map((s) => (
              <div key={s.name} style={{ display: "grid", gridTemplateColumns: "110px 1fr 96px", alignItems: "center", gap: 12 }}>
                <span style={{ font: `400 12px/1 ${mono}` }}>{s.name}</span>
                <span style={{ height: 10, background: "color-mix(in srgb, var(--color-text) 7%, transparent)", display: "block" }}>
                  <span style={{ display: "block", height: 10, width: `${s.pct}%`, background: "var(--color-accent-500)" }} />
                </span>
                <span style={{ font: `400 12px/1 ${mono}`, textAlign: "right" }}>{s.count}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 26 }}>
        <Panel>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 14 }}>
            <h5 style={{ margin: 0 }}>partitions[]</h5>
            <span className="text-muted" style={{ font: `400 11px/1 ${mono}` }}>
              rows_estimate from pg_stat_user_tables.n_live_tup
            </span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>name</th>
                <th>bound</th>
                <th style={{ textAlign: "right" }}>rows_estimate</th>
                <th style={{ textAlign: "right" }}>size</th>
              </tr>
            </thead>
            <tbody>
              {stats.partitions.map((p) => (
                <tr key={p.name}>
                  <td style={{ font: `400 12.5px/1.4 ${mono}` }}>{p.name}</td>
                  <td style={{ font: `400 11.5px/1.4 ${mono}`, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                    {p.bound ?? "DEFAULT"}
                  </td>
                  <td style={{ font: `400 12.5px/1.4 ${mono}`, textAlign: "right" }}>{fmt(p.rows_estimate)}</td>
                  <td style={{ font: `400 12.5px/1.4 ${mono}`, textAlign: "right" }}>{bytes(p.size_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
          <Panel>
            <h5 style={{ margin: "0 0 14px" }}>time_range</h5>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, font: `400 12px/1.4 ${mono}` }}>
              <div>
                <div className="text-muted" style={{ fontSize: 10.5, letterSpacing: ".08em", textTransform: "uppercase" }}>
                  oldest
                </div>
                {stats.time_range.oldest ?? "n/a"}
              </div>
              <div>
                <div className="text-muted" style={{ fontSize: 10.5, letterSpacing: ".08em", textTransform: "uppercase" }}>
                  newest
                </div>
                {stats.time_range.newest ?? "n/a"}
              </div>
            </div>
          </Panel>
          <Panel>
            <h5 style={{ margin: "0 0 14px" }}>retention_config</h5>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, font: `400 12px/1.4 ${mono}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <span className="text-muted">retention_days</span>
                <span>{stats.retention_config.retention_days}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <span className="text-muted">partition_lookahead_days</span>
                <span>{stats.retention_config.partition_lookahead_days}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <span className="text-muted">retention_cron</span>
                <span>{stats.retention_config.retention_cron}</span>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
