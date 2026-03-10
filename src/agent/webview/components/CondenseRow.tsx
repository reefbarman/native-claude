import { useEffect, useState } from "preact/hooks";
import type { ChatMessage } from "../types";

interface CondenseRowProps {
  message: ChatMessage;
}

function formatK(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Spinner shown while condensing is in progress, with a live elapsed-time counter. */
function CondensingSpinner() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(interval);
  }, []);

  return (
    <div class="condense-row condense-row-condensing">
      <div class="condense-row-line" />
      <div class="condense-row-badge">
        <i class="codicon codicon-loading codicon-modifier-spin" />
        <span class="condense-row-label">Condensing context…</span>
        <span class="condense-row-detail">{elapsed}s</span>
      </div>
      <div class="condense-row-line" />
    </div>
  );
}

export function CondenseRow({ message }: CondenseRowProps) {
  const info = message.condenseInfo;
  const isError = !!info?.errorMessage;

  if (info?.condensing) {
    return <CondensingSpinner />;
  }

  if (isError) {
    return (
      <div class="condense-row condense-row-error">
        <i class="codicon codicon-warning" />
        <span class="condense-row-label">Context condensing failed</span>
        <span class="condense-row-detail">{info!.errorMessage}</span>
      </div>
    );
  }

  const saved = info
    ? Math.max(0, info.prevInputTokens - info.newInputTokens)
    : 0;
  const savedPct =
    info && info.prevInputTokens > 0
      ? Math.round((saved / info.prevInputTokens) * 100)
      : 0;

  return (
    <div class="condense-row">
      <div class="condense-row-line" />
      <div class="condense-row-badge">
        <i class="codicon codicon-fold" />
        <span class="condense-row-label">Context condensed</span>
        {info && (
          <span class="condense-row-detail condense-row-stats">
            {formatK(info.prevInputTokens)} → {formatK(info.newInputTokens)}{" "}
            tokens
            {savedPct > 0 && (
              <span class="condense-row-saved"> (−{savedPct}%)</span>
            )}
            {info.durationMs !== undefined && (
              <span class="condense-row-duration">
                {" · "}
                {formatDuration(info.durationMs)}
              </span>
            )}
          </span>
        )}
      </div>
      {info?.validationWarnings && info.validationWarnings.length > 0 && (
        <div class="condense-row-detail" style={{ marginTop: "4px" }}>
          <i class="codicon codicon-warning" />{" "}
          {info.validationWarnings.join(" · ")}
        </div>
      )}
      <div class="condense-row-line" />
    </div>
  );
}
