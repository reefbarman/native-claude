import { useState, useEffect } from "preact/hooks";
import type { SidebarState, PostCommand } from "../types.js";
import { CollapsibleSection } from "./common/CollapsibleSection.js";

interface Props {
  state: SidebarState;
  postCommand: PostCommand;
}

const STALE_DIM_MS = 60_000; // 1 minute — dim the row

/** Format an epoch-ms timestamp as a relative "last seen" string. */
function formatLastSeen(lastActivity: number, now: number): string {
  const elapsed = Math.max(0, now - lastActivity);
  if (elapsed < 1_000) return "just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

export function ServerStatus({ state, postCommand }: Props) {
  const { serverRunning, port, authEnabled, masterBypass, connectedAgents } =
    state;

  const agentCount = connectedAgents?.length ?? 0;

  // Tick every second so relative times stay fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    if (agentCount === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [agentCount]);

  const now = Date.now();

  return (
    <CollapsibleSection
      title="Server Status"
      titleExtra={
        serverRunning && agentCount > 0 ? (
          <span class="badge badge-ok">{agentCount}</span>
        ) : undefined
      }
    >
      <div class="status-header">
        <span class={`dot ${serverRunning ? "running" : "stopped"}`} />
        <span class="status-text">
          {serverRunning ? `Running on port ${port}` : "Stopped"}
        </span>
      </div>
      <div class="info-row">
        <span class="label">Auth:</span>
        <span class="value">{authEnabled ? "Enabled" : "Disabled"}</span>
      </div>
      <div class="info-row">
        <span class="label">Master Bypass:</span>
        <span class="value">{masterBypass ? "ON" : "Off"}</span>
      </div>
      <div class="button-group">
        {serverRunning ? (
          <button
            class="btn btn-secondary"
            onClick={() => postCommand("stopServer")}
          >
            Stop Server
          </button>
        ) : (
          <button
            class="btn btn-primary"
            onClick={() => postCommand("startServer")}
          >
            Start Server
          </button>
        )}
      </div>
      {serverRunning && (
        <div class="connected-agents">
          <div class="subsection-label">Connected Agents</div>
          {agentCount === 0 ? (
            <p class="help-text">No agents connected.</p>
          ) : (
            connectedAgents!.map((a) => {
              const isStale = now - a.lastActivity > STALE_DIM_MS;
              return (
                <div
                  key={a.sessionId}
                  class={`connected-agent-row${isStale ? " stale" : ""}`}
                  title={`Session: ${a.sessionId}`}
                >
                  <span class={`agent-dot ${a.trustState}`} />
                  <span class="agent-name">
                    {a.agentDisplayName ??
                      a.clientName ??
                      `Session ${a.sessionId.substring(0, 8)}...`}
                  </span>
                  {a.clientVersion && (
                    <span class="agent-version">v{a.clientVersion}</span>
                  )}
                  <span class="agent-last-seen">
                    {formatLastSeen(a.lastActivity, now)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </CollapsibleSection>
  );
}
