import { useEffect, useState } from "react";
import { Panel } from "../components/Blueprint";
import { getAggregate } from "../api";
import type { AggregateQuery } from "../api";
import type { AggregateResponse, Level } from "../types";
import { levelColor } from "../styles/tokens";
import { fmt } from "../format";

const mono = "ui-monospace, Consolas, monospace";
const LEVELS: Level[] = ["debug", "info", "warn", "error"];
const PALETTE = [
  "var(--color-accent-900)",
  "var(--color-accent-700)",
  "var(--color-accent-500)",
  "var(--color-accent-400)",
  "var(--color-neutral-400)",
];

type Bucket = AggregateQuery["bucket"];
type GroupBy = "" | "service" | "level";

const BUCKETS: Bucket[] = ["1m", "5m", "1h", "1d"];
const GROUP_OPTS: { value: GroupBy; label: string }[] = [
  { value: "", label: "none" },
  { value: "service", label: "service" },
  { value: "level", label: "level" },
];

const STEP_MS: Record<Bucket, number> = { "1m": 60000, "5m": 300000, "1h": 3600000, "1d": 86400000 };
const DEFAULT_N: Record<Bucket, number> = { "1m": 60, "5m": 48, "1h": 24, "1d": 14 };
const MAX_BUCKETS = 2000;

function defaultRange(bucket: Bucket) {
  const until = new Date();
  const since = new Date(until.getTime() - DEFAULT_N[bucket] * STEP_MS[bucket]);
  return { since: since.toISOString(), until: until.toISOString() };
}

type LastQuery = { sinceMs: number; stepMs: number; n: number; bucket: Bucket; groupBy: GroupBy; q: string };

type Series = { name: string; color: string; points: string };

function buildSeries(resp: AggregateResponse, lq: LastQuery) {
  const { groupBy, sinceMs, stepMs, n } = lq;
  let groupNames: string[];
  if (groupBy === "level") {
    groupNames = LEVELS;
  } else if (groupBy === "service") {
    const totals = new Map<string, number>();
    for (const b of resp.buckets) {
      if (b.group == null) continue;
      totals.set(b.group, (totals.get(b.group) ?? 0) + b.count);
    }
    groupNames = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  } else {
    groupNames = ["all"];
  }

  const valuesByGroup = new Map(groupNames.map((g) => [g, new Array(n).fill(0)]));
  for (const b of resp.buckets) {
    const key = groupBy === "" ? "all" : b.group ?? "";
    const arr = valuesByGroup.get(key);
    if (!arr) continue;
    const idx = Math.round((new Date(b.start).getTime() - sinceMs) / stepMs);
    if (idx >= 0 && idx < n) arr[idx] += b.count;
  }

  const max = Math.max(1, ...[...valuesByGroup.values()].flat());
  const W = 960;
  const H = 300;
  const series: Series[] = groupNames.map((name, gi) => {
    const values = valuesByGroup.get(name)!;
    const color = groupBy === "level" ? levelColor[name as Level] : PALETTE[gi % PALETTE.length];
    const points = values
      .map((v, i) => `${(n > 1 ? (i / (n - 1)) * W : 0).toFixed(1)},${(H - (v / max) * (H - 10)).toFixed(1)}`)
      .join(" ");
    return { name, color, points };
  });

  return { series, max };
}

export default function AggregatePage() {
  const [bucket, setBucket] = useState<Bucket>("1h");
  const [groupBy, setGroupBy] = useState<GroupBy>("level");
  const [q, setQ] = useState("");

  const initial = defaultRange("1h");
  const [sinceInput, setSinceInput] = useState(initial.since);
  const [untilInput, setUntilInput] = useState(initial.until);
  const [rangeTouched, setRangeTouched] = useState(false);

  const [data, setData] = useState<AggregateResponse | null>(null);
  const [lastQuery, setLastQuery] = useState<LastQuery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bucket size implies a sensible default lookback — keep the fields in sync
  // with that until the user actually types a value of their own.
  useEffect(() => {
    if (rangeTouched) return;
    const r = defaultRange(bucket);
    setSinceInput(r.since);
    setUntilInput(r.until);
  }, [bucket, rangeTouched]);

  const onSinceChange = (v: string) => {
    setRangeTouched(true);
    setSinceInput(v);
  };
  const onUntilChange = (v: string) => {
    setRangeTouched(true);
    setUntilInput(v);
  };
  const resetRange = () => {
    setRangeTouched(false);
    const r = defaultRange(bucket);
    setSinceInput(r.since);
    setUntilInput(r.until);
  };

  const run = async () => {
    setError(null);

    const since = new Date(sinceInput);
    const until = new Date(untilInput);
    if (isNaN(since.getTime())) return setError("invalid since timestamp");
    if (isNaN(until.getTime())) return setError("invalid until timestamp");
    if (until.getTime() < since.getTime()) return setError("until must not be before since");

    const stepMs = STEP_MS[bucket];
    const n = Math.round((until.getTime() - since.getTime()) / stepMs);
    if (n <= 0) return setError("range must span at least one bucket");
    if (n > MAX_BUCKETS)
      return setError(
        `range too wide for ${bucket} buckets (${fmt(n)} buckets) — pick a coarser bucket or a shorter range`
      );

    setLoading(true);
    try {
      const resp = await getAggregate({
        since: since.toISOString(),
        until: until.toISOString(),
        bucket,
        group_by: groupBy || undefined,
        q: q || undefined,
      });
      setData(resp);
      setLastQuery({ sinceMs: since.getTime(), stepMs, n, bucket, groupBy, q });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
      setLastQuery(null);
    } finally {
      setLoading(false);
    }
  };

  const built = data && lastQuery ? buildSeries(data, lastQuery) : null;
  const rollup = (bucket === "1h" || bucket === "1d") && !q;

  const xTicks =
    lastQuery &&
    Array.from({ length: 6 }, (_, i) => {
      const idx = Math.round((i * (lastQuery.n - 1)) / 5);
      const d = new Date(lastQuery.sinceMs + idx * lastQuery.stepMs);
      return lastQuery.bucket === "1d" ? d.toISOString().slice(5, 10) : d.toISOString().slice(11, 16);
    });
  const gridY = Array.from({ length: 5 }, (_, i) => (i * 300) / 4);

  const rows = data ? [...data.buckets].sort((a, b) => a.start.localeCompare(b.start)) : [];
  const shownRows = rows.slice(0, 50);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Aggregate</h3>
        <span style={{ font: `400 12px/1 ${mono}`, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>
          GET /logs/aggregate
        </span>
      </div>
      <p className="text-muted" style={{ fontSize: 13, maxWidth: "78ch" }}>
        since and until are required. 1h and 1d buckets with no q= or attr.* filter are served from the hourly
        rollup; everything else falls back to a cached live scan.
      </p>

      <Panel style={{ padding: "18px 20px", margin: "24px 0 26px", display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 22 }}>
        <div className="field" style={{ width: 230 }}>
          <label>since</label>
          <input
            className="input"
            style={{ fontFamily: mono, fontSize: 12.5 }}
            value={sinceInput}
            onChange={(e) => onSinceChange(e.target.value)}
          />
        </div>
        <div className="field" style={{ width: 230 }}>
          <label>until</label>
          <input
            className="input"
            style={{ fontFamily: mono, fontSize: 12.5 }}
            value={untilInput}
            onChange={(e) => onUntilChange(e.target.value)}
          />
        </div>
        {rangeTouched && (
          <button className="btn btn-ghost" onClick={resetRange} type="button">
            reset to auto
          </button>
        )}
        <div className="field">
          <label>bucket</label>
          <div className="seg">
            {BUCKETS.map((b) => (
              <label key={b} className="seg-opt">
                <input type="radio" name="bucket" checked={bucket === b} onChange={() => setBucket(b)} />
                {b}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <label>group_by</label>
          <div className="seg">
            {GROUP_OPTS.map((g) => (
              <label key={g.value} className="seg-opt">
                <input
                  type="radio"
                  name="groupby"
                  checked={groupBy === g.value}
                  onChange={() => setGroupBy(g.value)}
                />
                {g.label}
              </label>
            ))}
          </div>
        </div>
        <div className="field" style={{ width: 170 }}>
          <label>q</label>
          <input
            className="input"
            placeholder="substring match"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <span className={`tag ${rollup ? "tag-accent" : "tag-outline"}`}>
            {rollup ? "likely rollup fast-path · logs_hourly_counts" : "likely live scan"}
          </span>
          <button className="btn btn-primary" style={{ borderRadius: 6 }} onClick={run} disabled={loading}>
            {loading ? "Running…" : "Run"}
          </button>
        </div>
      </Panel>

      {error && <p style={{ fontSize: 13, color: "var(--color-accent-900)" }}>{error}</p>}

      {!data && !error && (
        <p className="text-muted" style={{ fontSize: 13 }}>
          no query run yet — press Run
        </p>
      )}

      {data && built && lastQuery && xTicks && (
        <>
          <Panel style={{ padding: "22px 24px 18px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 4 }}>
              <h5 style={{ margin: 0 }}>buckets[] · count over time</h5>
              <span className="text-muted" style={{ font: `400 11px/1 ${mono}` }}>
                bucket={lastQuery.bucket} · group_by={lastQuery.groupBy || "null"}
                {lastQuery.q ? ` · q=${lastQuery.q}` : ""}
              </span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, margin: "12px 0 16px" }}>
              {built.series.map((s) => (
                <span key={s.name} style={{ display: "inline-flex", alignItems: "center", gap: 7, font: `400 12px/1 ${mono}` }}>
                  <span style={{ width: 16, height: 2, background: s.color }} />
                  {s.name}
                </span>
              ))}
            </div>
            <svg viewBox="0 0 960 300" width="100%" height="300" preserveAspectRatio="none" style={{ display: "block", overflow: "visible" }}>
              {gridY.map((y) => (
                <line key={y} x1={0} x2={960} y1={y} y2={y} stroke="rgba(29,31,32,0.10)" strokeWidth={1} />
              ))}
              {built.series.map((s) => (
                <polyline key={s.name} points={s.points} fill="none" stroke={s.color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, font: `400 11px/1 ${mono}`, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              {xTicks.map((label, i) => (
                <span key={i}>{label}</span>
              ))}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 14,
                paddingTop: 12,
                borderTop: "1px solid var(--color-divider)",
                font: `400 11.5px/1 ${mono}`,
                color: "color-mix(in srgb, var(--color-text) 60%, transparent)",
              }}
            >
              <span>{fmt(built.max)} peak per bucket</span>
              <span>{fmt(data.buckets.length)} buckets returned</span>
            </div>
          </Panel>

          <Panel style={{ marginTop: 26 }}>
            <h5 style={{ margin: "0 0 14px" }}>response · first rows</h5>
            <table className="table">
              <thead>
                <tr>
                  <th>start</th>
                  <th>group</th>
                  <th style={{ textAlign: "right" }}>count</th>
                </tr>
              </thead>
              <tbody>
                {shownRows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ font: `400 12.5px/1.4 ${mono}` }}>{r.start}</td>
                    <td style={{ font: `400 12.5px/1.4 ${mono}` }}>{r.group ?? "null"}</td>
                    <td style={{ font: `400 12.5px/1.4 ${mono}`, textAlign: "right" }}>{fmt(r.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 50 && (
              <div className="text-muted" style={{ font: `400 11px/1 ${mono}`, marginTop: 10 }}>
                showing first 50 of {fmt(rows.length)}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
