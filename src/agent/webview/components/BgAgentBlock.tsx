import { useState } from "preact/hooks";
import type { BgSessionInfoProps } from "./BackgroundSessionStrip";

interface BgAgentBlockProps {
  sessionId: string;
  task: string;
  /** The full prompt/message sent to the background agent. */
  message?: string;
  resolvedModel?: string;
  resolvedProvider?: string;
  resolvedMode?: string;
  taskClass?: string;
  routingReason?: string;
  /** Live bg session info — undefined if the session no longer exists. */
  bgSession?: BgSessionInfoProps;
  onStop?: (sessionId: string) => void;
}

function statusLabel(
  status: BgSessionInfoProps["status"],
  currentTool?: string,
): string {
  switch (status) {
    case "pending":
      return "starting…";
    case "streaming":
      return currentTool ? currentTool : "thinking…";
    case "tool_executing":
      return currentTool ? currentTool : "executing…";
    case "awaiting_approval":
      return "awaiting approval";
    case "idle":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "error":
      return "failed";
  }
}

function statusIcon(status: BgSessionInfoProps["status"]): string {
  switch (status) {
    case "pending":
    case "streaming":
    case "tool_executing":
      return "codicon-loading codicon-modifier-spin";
    case "awaiting_approval":
      return "codicon-bell";
    case "idle":
      return "codicon-check";
    case "cancelled":
      return "codicon-circle-slash";
    case "error":
      return "codicon-error";
  }
}

export function BgAgentBlock({
  sessionId,
  task,
  message,
  resolvedModel,
  resolvedProvider,
  resolvedMode,
  taskClass,
  routingReason,
  bgSession,
  onStop,
}: BgAgentBlockProps) {
  const [expanded, setExpanded] = useState(false);

  // Default to "pending" when bgSession info hasn't arrived yet
  const status = bgSession?.status ?? "pending";
  const isRunning =
    status === "pending" ||
    status === "streaming" ||
    status === "tool_executing";
  const isDone = status === "idle" || status === "cancelled";
  const isError = status === "error";

  const statusClass = isError
    ? "tool-error"
    : isDone
      ? "tool-success"
      : "tool-running";

  return (
    <div class={`tool-call-block ${statusClass}`}>
      <button
        class="tool-call-header"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <i
          class={`codicon codicon-chevron-${expanded ? "down" : "right"} tool-call-chevron`}
        />
        <i class={`codicon tool-call-status-icon ${statusIcon(status)}`} />
        <span class="tool-call-name">Background Agent</span>
        <span class="tool-call-summary">{task}</span>
        {resolvedModel && (
          <span class="tool-call-meta">
            {resolvedProvider ? `${resolvedProvider}/` : ""}
            {resolvedModel}
          </span>
        )}
        {isRunning && (
          <span class="bg-agent-current-tool">
            {statusLabel(status, bgSession?.currentTool)}
          </span>
        )}
        {isRunning && onStop && (
          <span
            class="bg-agent-stop-inline"
            onClick={(e) => {
              e.stopPropagation();
              onStop(sessionId);
            }}
            role="button"
            title="Stop background agent"
          >
            <i class="codicon codicon-close" />
          </span>
        )}
      </button>

      {expanded && (
        <div class="tool-call-details">
          <div class="tool-call-section">
            <div class="tool-call-section-label">Task</div>
            <pre class="tool-call-code">{task}</pre>
          </div>
          {resolvedMode && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Mode</div>
              <pre class="tool-call-code">{resolvedMode}</pre>
            </div>
          )}
          {(resolvedModel || resolvedProvider) && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Model</div>
              <pre class="tool-call-code">
                {resolvedProvider ? `${resolvedProvider} / ` : ""}
                {resolvedModel}
              </pre>
            </div>
          )}
          {taskClass && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Task class</div>
              <pre class="tool-call-code">{taskClass}</pre>
            </div>
          )}
          {routingReason && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Routing reason</div>
              <pre class="tool-call-code">{routingReason}</pre>
            </div>
          )}
          {message && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Message</div>
              <pre class="tool-call-code">{message}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
