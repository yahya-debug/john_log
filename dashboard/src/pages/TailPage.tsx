import { useEffect, useRef, useState } from "react";
import { Blueprint } from "../components/Blueprint";
import { tailURL } from "../api";
import type { Level, TailEntry } from "../types";
import { levelColor } from "../styles/tokens";

const mono = "ui-monospace, Consolas, monospace";
const LEVEL_OPTS: { value: "" | Level; label: string }[] = [
  { value: "", label: "any" },
  { value: "debug", label: "debug" },
  { value: "info", label: "info" },
  { value: "warn", label: "warn" },
  { value: "error", label: "error" },
];

type Row = TailEntry & { key: number };

export default function TailPage() {
  const [service, setService] = useState("");
  const [level, setLevel] = useState<"" | Level>("");
  const [connected, setConnected] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const keyRef = useRef(0);

  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  const connect = () => {
    const es = new EventSource(tailURL({ service: service || undefined, level: level || undefined }));
    es.onmessage = (ev) => {
      try {
        const entry: TailEntry = JSON.parse(ev.data);
        keyRef.current += 1;
        setRows((prev) => [...prev, { ...entry, key: keyRef.current }].slice(-120));
      } catch {
        // ignore malformed events
      }
    };
    esRef.current = es;
    setConnected(true);
  };

  const disconnect = () => {
    esRef.current?.close();
    esRef.current = null;
    setConnected(false);
  };

  const toggleTail = () => (connected ? disconnect() : connect());

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Live tail</h3>
        <span style={{ font: `400 12px/1 ${mono}`, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>
          GET /admin/logs/tail · text/event-stream
        </span>
      </div>
      <p className="text-muted" style={{ fontSize: 13, maxWidth: "78ch" }}>
        Fed off the write buffer's post-flush event, so only entries that actually committed appear. Filters are
        service and level only; a tailed entry has no id.
      </p>

      <Blueprint style={{ padding: "16px 20px", margin: "24px 0 22px", display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 20 }}>
        <div className="field" style={{ width: 160 }}>
          <label>service</label>
          <input
            className="input"
            placeholder="any"
            value={service}
            onChange={(e) => setService(e.target.value)}
            disabled={connected}
          />
        </div>
        <div className="field">
          <label>level</label>
          <div className="seg">
            {LEVEL_OPTS.map((l) => (
              <label key={l.value} className="seg-opt">
                <input
                  type="radio"
                  name="taillevel"
                  checked={level === l.value}
                  onChange={() => setLevel(l.value)}
                  disabled={connected}
                />
                {l.label}
              </label>
            ))}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              font: `400 12px/1 ${mono}`,
              color: "color-mix(in srgb, var(--color-text) 60%, transparent)",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                background: connected ? "var(--color-accent)" : "var(--color-neutral-400)",
                animation: connected ? "jlpulse 1.4s ease-in-out infinite" : "none",
              }}
            />
            {connected ? "streaming" : "closed"}
          </span>
          <button className="btn btn-primary" style={{ borderRadius: 6 }} onClick={toggleTail}>
            {connected ? "Disconnect" : "Connect"}
          </button>
        </div>
      </Blueprint>

      <Blueprint style={{ padding: 0, background: "var(--color-surface)" }}>
        <div style={{ display: "flex", flexDirection: "column-reverse", height: 520, overflow: "auto", padding: "14px 18px" }}>
          {rows.map((r) => (
            <div
              key={r.key}
              style={{
                display: "grid",
                gridTemplateColumns: "190px 62px 110px 1fr",
                gap: 14,
                padding: "5px 0",
                borderBottom: "1px solid color-mix(in srgb, var(--color-text) 6%, transparent)",
                font: `400 12.5px/1.5 ${mono}`,
              }}
            >
              <span style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{r.timestamp}</span>
              <span style={{ color: levelColor[r.level], textTransform: "uppercase" }}>{r.level}</span>
              <span>{r.service}</span>
              <span style={{ color: "color-mix(in srgb, var(--color-text) 85%, transparent)" }}>{r.message}</span>
            </div>
          ))}
        </div>
      </Blueprint>
      <div className="text-muted" style={{ font: `400 11px/1 ${mono}`, marginTop: 10 }}>
        {rows.length} events received · heartbeat every 15s · newest at top
      </div>
    </div>
  );
}
