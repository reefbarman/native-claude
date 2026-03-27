interface ErrorBlockProps {
  error: string;
  retryable: boolean;
  code?: string;
  actions?: {
    signIn?: boolean;
    signInAnotherAccount?: boolean;
    condense?: boolean;
  };
  onRetry?: () => void;
  onSignIn?: () => void;
  onSignInAnotherAccount?: () => void;
  onCondense?: () => void;
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
  code,
  actions,
  onRetry,
  onSignIn,
  onSignInAnotherAccount,
  onCondense,
}: ErrorBlockProps) {
  const authError = isAuthError(error) || Boolean(actions?.signIn);
  const oauthExhausted =
    code === "oauth_usage_limit_exhausted" ||
    Boolean(actions?.signInAnotherAccount);
  const contextWindowExceeded =
    code === "context_window_exceeded" || Boolean(actions?.condense);

  return (
    <div class="error-block">
      <div class="error-icon">
        <i class="codicon codicon-error" />
      </div>
      <div class="error-body">
        <span class="error-message">{error}</span>
        {oauthExhausted && onSignInAnotherAccount ? (
          <span class="error-hint">
            All signed-in Codex accounts have hit usage limits. Add another
            account or retry later.
          </span>
        ) : authError && onSignIn ? (
          <span class="error-hint">
            Sign in to authenticate your API access.
          </span>
        ) : contextWindowExceeded && onCondense ? (
          <span class="error-hint">
            Conversation exceeded the model context window. Condense and retry.
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
          {oauthExhausted && onSignInAnotherAccount && (
            <button class="error-sign-in-btn" onClick={onSignInAnotherAccount}>
              <i class="codicon codicon-account-add" />
              Sign in another account
            </button>
          )}
          {contextWindowExceeded && onCondense && (
            <button class="error-retry-btn" onClick={onCondense}>
              <i class="codicon codicon-collapse-all" />
              Condense
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
