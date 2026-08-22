import { useEffect, useState } from "react";
import { Panel } from "../components/Blueprint";
import { getDeadLetters, replayDeadLetter } from "../api";
import type { DeadLetterRow, ReplayResponse } from "../types";

const mono = "ui-monospace, Consolas, monospace";

export default function DeadLetterPage() {
  const [rows, setRows] = useState<DeadLetterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [replayResult, setReplayResult] = useState<ReplayResponse | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await getDeadLetters();
      setRows(resp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const replayAll = async () => {
    setReplaying(true);
    setError(null);
    try {
      const result = await replayDeadLetter();
      setReplayResult(result);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReplaying(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Dead letter</h3>
        <span style={{ font: `400 12px/1 ${mono}`, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>
          GET /admin/dead-letter · POST /admin/dead-letter/replay
        </span>
      </div>
      <p className="text-muted" style={{ fontSize: 13, maxWidth: "78ch" }}>
        Batches the flush gave up on. Replay retries every queued row in its own transaction; a row is only
        removed on success, so anything that fails again stays queued.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "24px 0 22px" }}>
        <button className="btn btn-primary" style={{ borderRadius: 6 }} onClick={replayAll} disabled={replaying || loading}>
          {replaying ? "Replaying…" : "Replay all"}
        </button>
        <span className={`tag ${replayResult ? "tag-accent" : "tag-neutral"}`}>
          {replayResult ? `replayed: ${replayResult.replayed} · stillFailed: ${replayResult.stillFailed}` : `${rows.length} rows queued`}
        </span>
      </div>

      {error && <p style={{ fontSize: 13, color: "var(--color-accent-900)" }}>failed to load: {error}</p>}

      {loading && !error && (
        <p className="text-muted" style={{ fontSize: 13 }}>
          loading…
        </p>
      )}

      {!loading && !error && (
        <Panel>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 260 }}>id</th>
                <th style={{ width: 200 }}>failed_at</th>
                <th style={{ width: 90 }}>entries</th>
                <th>reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td style={{ font: `400 12.5px/1.4 ${mono}` }}>{d.id}</td>
                  <td style={{ font: `400 12.5px/1.4 ${mono}`, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
                    {d.failedAt}
                  </td>
                  <td style={{ font: `400 12.5px/1.4 ${mono}` }}>{d.entries.length}</td>
                  <td style={{ font: `400 12.5px/1.4 ${mono}`, color: "var(--color-accent-900)" }}>{d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-muted" style={{ font: `400 11px/1 ${mono}`, marginTop: 14 }}>
            read-only listing — replay is the only action that mutates the queue
          </div>
        </Panel>
      )}
    </div>
  );
}
