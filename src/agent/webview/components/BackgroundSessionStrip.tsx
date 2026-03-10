import { useState, useEffect } from "preact/hooks";

export interface BgSessionInfoProps {
  id: string;
  task: string;
  status:
    | "streaming"
    | "tool_executing"
    | "awaiting_approval"
    | "idle"
    | "error"
    | "cancelled"
    | "pending";
  currentTool?: string;
  resolvedMode?: string;
  resolvedModel?: string;
  resolvedProvider?: string;
  taskClass?: string;
  routingReason?: string;
  fallbackUsed?: boolean;
  streamingText?: string;
  resultText?: string;
  errorMessage?: string;
  completedAt?: number;
  fullTranscript?: string;
}

interface Props {
  sessions: BgSessionInfoProps[];
  onStop: (sessionId: string) => void;
  onOpenTranscript?: (sessionId: string) => void;
}

const ACTIVE_STATUSES = new Set<BgSessionInfoProps["status"]>([
  "pending",
  "streaming",
  "tool_executing",
  "awaiting_approval",
]);

function formatElapsed(startMs: number, now: number): string {
  const secs = Math.floor((now - startMs) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
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

function statusText(
  status: BgSessionInfoProps["status"],
  currentTool?: string,
): string {
  switch (status) {
    case "pending":
      return "Starting…";
    case "streaming":
      return currentTool ? currentTool : "Thinking…";
    case "tool_executing":
      return currentTool ? currentTool : "Running…";
    case "awaiting_approval":
      return "Awaiting approval";
    case "idle":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "error":
      return "Error";
  }
}

export function BackgroundSessionStrip({
  sessions,
  onStop,
  onOpenTranscript,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  // Auto-dismiss: hide completed sessions 10 seconds after completion
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [startedAt, setStartedAt] = useState<Map<string, number>>(new Map());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const now = Date.now();
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const s of sessions) {
      if (
        (s.status === "idle" ||
          s.status === "error" ||
          s.status === "cancelled") &&
        s.completedAt &&
        !dismissed.has(s.id)
      ) {
        const elapsed = now - s.completedAt;
        const remaining = Math.max(0, 10_000 - elapsed);
        if (remaining === 0) {
          // Already past 10s — dismiss immediately
          setDismissed((prev) => new Set(prev).add(s.id));
        } else {
          timers.push(
            setTimeout(() => {
              setDismissed((prev) => new Set(prev).add(s.id));
            }, remaining),
          );
        }
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [sessions, dismissed]);

  // Record start time the first time we see each active session
  useEffect(() => {
    const active = sessions.filter((s) => ACTIVE_STATUSES.has(s.status));
    if (active.length === 0) return;
    setStartedAt((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const s of active) {
        if (!next.has(s.id)) {
          next.set(s.id, Date.now());
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  // Tick every second while any session is active
  useEffect(() => {
    if (!sessions.some((s) => ACTIVE_STATUSES.has(s.status))) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [sessions]);

  const visibleSessions = sessions.filter((s) => !dismissed.has(s.id));
  if (visibleSessions.length === 0) return null;

  const runningCount = visibleSessions.filter(
    (s) => s.status === "streaming" || s.status === "tool_executing",
  ).length;
  const doneCount = visibleSessions.filter(
    (s) =>
      s.status === "idle" || s.status === "error" || s.status === "cancelled",
  ).length;

  return (
    <div class="bg-session-strip">
      <button
        class="bg-session-strip-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <i class="codicon codicon-server-process" />
        <span class="bg-session-strip-title">
          Background Agents {doneCount}/{visibleSessions.length}
        </span>
        {runningCount > 0 && (
          <span class="bg-session-strip-active">{runningCount} running</span>
        )}
        <i
          class={`codicon codicon-chevron-${collapsed ? "right" : "down"} bg-session-strip-chevron`}
        />
      </button>
      {!collapsed && (
        <div class="bg-session-strip-body">
          {visibleSessions.map((s) => (
            <div
              key={s.id}
              class={`bg-session-card bg-session-${s.status}${
                s.completedAt ? " bg-session-fading" : ""
              }`}
            >
              <i class={`codicon ${statusIcon(s.status)} bg-session-icon`} />
              <span class="bg-session-task" title={s.task}>
                {s.task}
              </span>
              <span
                class="bg-session-status"
                title={statusText(s.status, s.currentTool)}
              >
                {statusText(s.status, s.currentTool)}
              </span>
              {ACTIVE_STATUSES.has(s.status) && startedAt.has(s.id) && (
                <span class="bg-session-timer">
                  {formatElapsed(startedAt.get(s.id)!, now)}
                </span>
              )}
              {(s.status === "pending" ||
                s.status === "streaming" ||
                s.status === "tool_executing") && (
                <button
                  class="icon-button bg-session-stop"
                  onClick={() => onStop(s.id)}
                  title="Stop background agent"
                >
                  <i class="codicon codicon-close" />
                </button>
              )}
              <button
                class="icon-button bg-session-transcript"
                onClick={() => onOpenTranscript?.(s.id)}
                title="View transcript"
              >
                <i class="codicon codicon-open-preview" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
