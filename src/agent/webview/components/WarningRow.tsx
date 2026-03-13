import type { ChatMessage } from "../types";

interface WarningRowProps {
  message: ChatMessage;
  onRetry?: () => void;
}

export function WarningRow({ message, onRetry }: WarningRowProps) {
  return (
    <div class="condense-row condense-row-error">
      <i class="codicon codicon-warning" />
      <details class="warning-row-details">
        <summary class="condense-row-label">API error (auto-repaired)</summary>
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
