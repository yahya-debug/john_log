import { useState } from "react";
import { Panel } from "../components/Blueprint";
import { postLogs } from "../api";
import type { IngestResponse } from "../types";

const mono = "ui-monospace, Consolas, monospace";

const SAMPLE_BATCH = `{
  "logs": [
    {
      "timestamp": "2026-08-14T05:42:10.114Z",
      "level": "info",
      "service": "checkout-api",
      "message": "checkout session created",
      "attributes": { "user_id": "8812", "region": "eu-west-1" }
    },
    {
      "timestamp": "2026-08-14T05:42:10.221Z",
      "level": "error",
      "service": "billing",
      "message": "payment intent failed",
      "attributes": { "user_id": "8812", "code": "card_declined" }
    }
  ]
}`;

const BAD_BATCH = `{
  "logs": [
    {
      "timestamp": "2026-08-14T05:42:10.114Z",
      "level": "info",
      "service": "checkout-api",
      "message": "checkout session created"
    },
    {
      "timestamp": "2026-08-14T05:42:10.300Z",
      "level": "critical",
      "service": "worker",
      "message": "job crashed"
    },
    {
      "timestamp": "not-a-date",
      "level": "warn",
      "service": "gateway",
      "message": "slow upstream"
    },
    {
      "timestamp": "2026-08-14T05:42:11.000Z",
      "level": "info",
      "service": "  ",
      "message": "orphan entry"
    }
  ]
}`;

type Result = {
  status: number;
  body: IngestResponse | { error: string };
};

function isIngestResponse(body: Result["body"]): body is IngestResponse {
  return "rejected" in body;
}

function statusTag(status: number): { text: string; cls: string } {
  if (status === 200) return { text: "200 OK", cls: "tag-accent" };
  if (status === 400) return { text: "400 Bad Request", cls: "tag-outline" };
  if (status === 429) return { text: "429 Too Many Requests", cls: "tag-outline" };
  return { text: `${status}`, cls: "tag-outline" };
}

export default function IngestPage() {
  const [body, setBody] = useState(SAMPLE_BATCH);
  const [result, setResult] = useState<Result | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const loadBadBatch = () => {
    setBody(BAD_BATCH);
    setResult(null);
    setParseError(null);
  };

  const sendBatch = async () => {
    setParseError(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      setParseError("malformed JSON in request body");
      return;
    }

    const logs = (parsed as { logs?: unknown }).logs;
    if (!Array.isArray(logs)) {
      setParseError("request body must be { logs: [...] }");
      return;
    }

    setSending(true);
    try {
      const res = await postLogs(logs);
      setResult(res);
    } catch (e) {
      setResult({ status: 429, body: { error: e instanceof Error ? e.message : String(e) } });
    } finally {
      setSending(false);
    }
  };

  const status = result ? statusTag(result.status) : { text: "no request sent yet", cls: "tag-neutral" };
  const rejected = result && isIngestResponse(result.body) ? result.body.rejected : [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Ingest</h3>
        <span style={{ font: `400 12px/1 ${mono}`, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>
          POST /logs
        </span>
      </div>
      <p className="text-muted" style={{ fontSize: 13, maxWidth: "78ch" }}>
        A batch is validated entry by entry, then admitted to the in-memory write buffer only if the whole batch
        fits. Anything turned away gets 429 + Retry-After rather than a 200 it can't honour.
      </p>

      <Panel style={{ marginTop: 24, maxWidth: 760 }}>
        <h5 style={{ margin: "0 0 14px" }}>Send a batch</h5>
        <div className="field" style={{ marginBottom: 12 }}>
          <label>request body</label>
          <textarea
            className="input"
            style={{ minHeight: 250, font: `400 12px/1.6 ${mono}` }}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button className="btn btn-primary" style={{ borderRadius: 6 }} onClick={sendBatch} disabled={sending}>
            {sending ? "Sending…" : "Send batch"}
          </button>
          <button className="btn btn-secondary" onClick={loadBadBatch}>
            Insert an invalid entry
          </button>
        </div>
        {parseError && (
          <p style={{ color: "var(--color-accent-900)", fontSize: 13, marginTop: 10 }}>{parseError}</p>
        )}

        <div style={{ marginTop: 20, borderTop: "1px solid var(--color-divider)", paddingTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span
              style={{
                font: "400 10.5px/1 var(--font-body)",
                letterSpacing: ".12em",
                textTransform: "uppercase",
                color: "var(--color-accent-700)",
              }}
            >
              response
            </span>
            <span className={`tag ${status.cls}`}>{status.text}</span>
          </div>

          {rejected.length > 0 && (
            <table className="table" style={{ marginBottom: 14 }}>
              <thead>
                <tr>
                  <th style={{ width: 60 }}>index</th>
                  <th>reason</th>
                </tr>
              </thead>
              <tbody>
                {rejected.map((r) => (
                  <tr key={r.index}>
                    <td style={{ font: `400 12.5px/1.4 ${mono}` }}>{r.index}</td>
                    <td style={{ font: `400 12.5px/1.4 ${mono}`, color: "var(--color-accent-900)" }}>{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {result && (
            <pre
              style={{
                margin: 0,
                padding: 14,
                background: "#ffffff",
                border: "1px solid var(--color-divider)",
                borderRadius: 6,
                font: `400 12px/1.6 ${mono}`,
                whiteSpace: "pre-wrap",
                overflow: "auto",
                maxHeight: 200,
              }}
            >
              {JSON.stringify(result.body, null, 2)}
            </pre>
          )}
        </div>
      </Panel>
    </div>
  );
}
