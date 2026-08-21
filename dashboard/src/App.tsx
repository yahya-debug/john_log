import { useState } from "react";
import { Blueprint } from "./components/Blueprint";
import StatsPage from "./pages/StatsPage";
import type { TabIdentifiers } from "./types"

const TABS: {id: TabIdentifiers; label: string}[] = [
    { id: 'stats', label: "Stats" },
    { id: 'ingest', label: "Ingest" },
    { id: 'aggregate', label: "Aggregate" },
    { id: 'logs', label: "Logs" },
    { id: 'tail', label: "Tail" },
    { id: 'dead', label: "Dead letter" }
]

function App() {
  const [tab, setTab] = useState<TabIdentifiers>('stats')

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--color-bg)",
        fontFamily: "var(--font-body)",
        fontSize: 15,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "18px 34px 0 34px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <Blueprint
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 38,
              height: 38,
              color: "var(--color-accent-700)",
            }}
          >
            <svg
              width="23"
              height="23"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-label="John Log"
            >
              <path d="M2.6 11C5.4 7.1 8.2 5.2 11 5.2S16.6 7.1 19.4 11C16.6 14.9 13.8 16.8 11 16.8S5.4 14.9 2.6 11Z" />
              <circle cx="11" cy="11" r="2.4" />
              <circle cx="11" cy="11" r="8.4" />
              <path d="M17 17L21.6 21.6" />
            </svg>
          </Blueprint>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 20, letterSpacing: ".02em" }}>
            JOHN&nbsp;LOG
          </div>
        </div>

        <div
          style={{
            font: "400 11px/1 ui-monospace, Consolas, monospace",
            letterSpacing: ".08em",
            color: "color-mix(in srgb, var(--color-text) 50%, transparent)",
            textTransform: "uppercase",
          }}
        >
          operator dashboard
        </div>

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            font: "400 12px/1 ui-monospace, Consolas, monospace",
            color: "color-mix(in srgb, var(--color-text) 60%, transparent)",
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              background: "var(--color-accent)",
              animation: "jlpulse 2.2s ease-in-out infinite",
            }}
          />
          <span>{window.location.origin}</span>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          padding: "18px 34px 0 34px",
          borderBottom: "1px solid var(--color-divider)",
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            className="tab-btn"
            onClick={() => setTab(t.id)}
            style={{
              appearance: "none",
              background: "transparent",
              border: 0,
              borderBottom: `2px solid ${tab === t.id ? "var(--color-accent)" : "transparent"}`,
              padding: "8px 16px 12px 0",
              marginRight: 22,
              cursor: "pointer",
              fontFamily: "var(--font-heading)",
              fontWeight: 600,
              fontSize: 16,
              letterSpacing: ".01em",
              color:
                tab === t.id
                  ? "var(--color-text)"
                  : "color-mix(in srgb, var(--color-text) 52%, transparent)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "stats" && <div style={{ padding: "28px 34px 60px" }}><StatsPage /></div>}
      {tab === "ingest" && <div style={{ padding: "28px 34px 60px" }}>ingest</div>}
      {tab === "aggregate" && <div style={{ padding: "28px 34px 60px" }}>aggregate</div>}
      {tab === "logs" && <div style={{ padding: "28px 34px 60px" }}>logs</div>}
      {tab === "tail" && <div style={{ padding: "28px 34px 60px" }}>tail</div>}
      {tab === "dead" && <div style={{ padding: "28px 34px 60px" }}>dead letter</div>}
    </div>
  );
}

export default App
