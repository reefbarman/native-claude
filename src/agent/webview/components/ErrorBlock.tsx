interface ErrorBlockProps {
  error: string;
  retryable: boolean;
  onRetry?: () => void;
  onSignIn?: () => void;
}

function isAuthError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("authentication_error") ||
    lower.includes("invalid x-api-key") ||
    lower.includes("invalid api key") ||
    (lower.includes("401") && !lower.includes("tool"))
  );
}

export function ErrorBlock({
  error,
  retryable,
  onRetry,
  onSignIn,
}: ErrorBlockProps) {
  const authError = isAuthError(error);

  return (
    <div class="error-block">
      <div class="error-icon">
        <i class="codicon codicon-error" />
      </div>
      <div class="error-body">
        <span class="error-message">{error}</span>
        {authError && onSignIn ? (
          <span class="error-hint">
            Sign in to authenticate your API access.
          </span>
        ) : retryable ? (
          <span class="error-hint">
            This error may be transient. Try again.
          </span>
        ) : onRetry ? (
          <span class="error-hint">Retry to run the last request again.</span>
        ) : null}
        <div class="error-actions">
          {authError && onSignIn && (
            <button class="error-sign-in-btn" onClick={onSignIn}>
              <i class="codicon codicon-key" />
              Sign in
            </button>
          )}
          {onRetry && (
            <button class="error-retry-btn" onClick={onRetry}>
              <i class="codicon codicon-refresh" />
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
