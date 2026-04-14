import { useEffect, useMemo, useState } from "preact/hooks";

import type { ChatMessage } from "../types";

interface WarningRowProps {
  message: ChatMessage;
  onRetry?: () => void;
}

function formatCountdownLabel(message: ChatMessage, nowMs: number): string {
  const retryAt = message.warningRetry?.retryAt;
  if (!retryAt) {
    return "API error (auto-repaired)";
  }

  const remainingSeconds = Math.max(0, Math.ceil((retryAt - nowMs) / 1000));
  if (remainingSeconds === 0) {
    return "API error (auto-repaired) — retrying now…";
  }

  return `API error (auto-repaired) — retrying in ${remainingSeconds}s`;
}

export function WarningRow({ message, onRetry }: WarningRowProps) {
  const retryAt = message.warningRetry?.retryAt;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!retryAt) return;
    setNowMs(Date.now());

    const timer = setInterval(() => {
      const next = Date.now();
      setNowMs(next);
      if (next >= retryAt) {
        clearInterval(timer);
      }
    }, 250);

    return () => clearInterval(timer);
  }, [retryAt]);

  const summaryLabel = useMemo(
    () => formatCountdownLabel(message, nowMs),
    [message, nowMs],
  );

  return (
    <div class="condense-row condense-row-error">
      <i class="codicon codicon-warning" />
      <details class="warning-row-details">
        <summary class="condense-row-label">{summaryLabel}</summary>
        <pre class="warning-row-body">{message.warningMessage}</pre>
      </details>
      {message.error && onRetry && (
        <button class="error-retry-btn" onClick={onRetry}>
          <i class="codicon codicon-refresh" />
          Retry
        </button>
      )}
    </div>
  );
}
