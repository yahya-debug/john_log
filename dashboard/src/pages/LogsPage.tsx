import { useState } from "react";
import { Panel } from "../components/Blueprint";
import { getLogs } from "../api";
import type { Level, LogEntry } from "../types";
import { levelBg } from "../styles/tokens";

const mono = "ui-monospace, Consolas, monospace";
const LEVEL_OPTS: { value: "" | Level; label: string }[] = [
  { value: "", label: "any" },
  { value: "debug", label: "debug" },
  { value: "info", label: "info" },
  { value: "warn", label: "warn" },
  { value: "error", label: "error" },
];

function levelTagColors(level: Level): { bg: string; fg: string } {
  return { bg: levelBg[level], fg: level === "debug" ? "var(--color-neutral-800)" : "var(--color-accent-900)" };
}

export default function LogsPage() {
  const [service, setService] = useState("");
  const [level, setLevel] = useState<"" | Level>("");
  const [q, setQ] = useState("");
  const [attrUserId, setAttrUserId] = useState("");

  const [rows, setRows] = useState<LogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasQueried, setHasQueried] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filters = () => ({
    service: service || undefined,
    level: level || undefined,
    q: q || undefined,
    attr: attrUserId ? { user_id: attrUserId } : undefined,
  });

  const runQuery = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await getLogs(filters());
      setRows(resp.logs);
      setNextCursor(resp.next_cursor);
      setHasQueried(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await getLogs({ ...filters(), cursor: nextCursor });
      setRows((prev) => [...prev, ...resp.logs]);
      setNextCursor(resp.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Logs</h3>
        <span style={{ font: `400 12px/1 ${mono}`, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>
          GET /logs
        </span>
      </div>
      <p className="text-muted" style={{ fontSize: 13, maxWidth: "78ch" }}>
        Keyset pagination — the response carries next_cursor; pass it back to continue. Default limit 100, max
        1000.
      </p>

      <Panel style={{ padding: "18px 20px", margin: "24px 0 26px", display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 20 }}>
        <div className="field" style={{ width: 160 }}>
          <label>service</label>
          <input className="input" placeholder="any" value={service} onChange={(e) => setService(e.target.value)} />
        </div>
        <div className="field">
          <label>level</label>
          <div className="seg">
            {LEVEL_OPTS.map((l) => (
              <label key={l.value} className="seg-opt">
                <input type="radio" name="loglevel" checked={level === l.value} onChange={() => setLevel(l.value)} />
                {l.label}
              </label>
            ))}
          </div>
        </div>
        <div className="field" style={{ width: 190 }}>
          <label>q</label>
          <input className="input" placeholder="message substring" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="field" style={{ width: 190 }}>
          <label>attr.user_id</label>
          <input className="input" placeholder="exact value" value={attrUserId} onChange={(e) => setAttrUserId(e.target.value)} />
        </div>
        <div className="field" style={{ width: 90 }}>
          <label>limit</label>
          <input className="input" value="100" readOnly />
        </div>
        <div style={{ marginLeft: "auto" }}>
          <button className="btn btn-primary" style={{ borderRadius: 6 }} onClick={runQuery} disabled={loading}>
            {loading && !hasQueried ? "Querying…" : "Query"}
          </button>
        </div>
      </Panel>

      {error && <p style={{ fontSize: 13, color: "var(--color-accent-900)" }}>failed to load: {error}</p>}

      {!hasQueried && !error && (
        <p className="text-muted" style={{ fontSize: 13 }}>
          no query run yet — press Query
        </p>
      )}

      {hasQueried && (
        <Panel>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
            <h5 style={{ margin: 0 }}>logs[]</h5>
            <span className="text-muted" style={{ font: `400 11px/1 ${mono}` }}>
              {rows.length} loaded{nextCursor ? " · more available" : " · end of results"}
            </span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 210 }}>timestamp</th>
                <th style={{ width: 80 }}>level</th>
                <th style={{ width: 120 }}>service</th>
                <th>message</th>
                <th style={{ width: 230 }}>attributes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const colors = levelTagColors(r.level);
                const attrs = Object.entries(r.attributes)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" ");
                return (
                  <tr key={r.id}>
                    <td style={{ font: `400 12.5px/1.4 ${mono}`, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
                      {r.timestamp}
                    </td>
                    <td>
                      <span className="tag" style={{ background: colors.bg, color: colors.fg, fontFamily: mono }}>
                        {r.level}
                      </span>
                    </td>
                    <td style={{ font: `400 12.5px/1.4 ${mono}` }}>{r.service}</td>
                    <td style={{ fontSize: 13.5 }}>{r.message}</td>
                    <td style={{ font: `400 11.5px/1.4 ${mono}`, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                      {attrs}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              marginTop: 16,
              paddingTop: 14,
              borderTop: "1px solid var(--color-divider)",
            }}
          >
            <span className="text-muted" style={{ font: `400 11.5px/1.5 ${mono}`, wordBreak: "break-all" }}>
              next_cursor: {nextCursor ?? "null"}
            </span>
            <button className="btn btn-secondary" onClick={loadMore} disabled={!nextCursor || loading}>
              {loading && hasQueried ? "Loading…" : "Load more"}
            </button>
          </div>
        </Panel>
      )}
    </div>
  );
}
