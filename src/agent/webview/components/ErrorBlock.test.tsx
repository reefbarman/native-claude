import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";

import { ErrorBlock } from "./ErrorBlock";

describe("ErrorBlock", () => {
  it("shows sign-in-another-account and retry for oauth usage-limit exhausted errors", () => {
    const onRetry = vi.fn();
    const onSignInAnotherAccount = vi.fn();

    render(
      <ErrorBlock
        error="Codex API error 429: The usage limit has been reached."
        retryable
        code="oauth_usage_limit_exhausted"
        actions={{ signInAnotherAccount: true }}
        onRetry={onRetry}
        onSignInAnotherAccount={onSignInAnotherAccount}
      />,
    );

    expect(
      screen.getByText(/all signed-in codex accounts have hit usage limits/i),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /sign in another account/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(onSignInAnotherAccount).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows sign in for auth-required errors", () => {
    const onSignIn = vi.fn();

    render(
      <ErrorBlock
        error="OpenAI/Codex authentication is required"
        retryable
        actions={{ signIn: true }}
        onSignIn={onSignIn}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("uses action metadata to show sign-in-another-account even without explicit code", () => {
    const onSignInAnotherAccount = vi.fn();

    render(
      <ErrorBlock
        error="Codex API error 429"
        retryable
        actions={{ signInAnotherAccount: true }}
        onSignInAnotherAccount={onSignInAnotherAccount}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /sign in another account/i }),
    );

    expect(onSignInAnotherAccount).toHaveBeenCalledTimes(1);
  });

  it("shows condense action for context-window exceeded errors", () => {
    const onCondense = vi.fn();

    render(
      <ErrorBlock
        error="Codex API error unknown: Your input exceeds the context window of this model."
        retryable
        code="context_window_exceeded"
        actions={{ condense: true }}
        onCondense={onCondense}
      />,
    );

    expect(
      screen.getByText(/conversation exceeded the model context window/i),
    ).toBeTruthy();

    const condenseButton = screen.getByRole("button", { name: /condense/i });
    const icon = condenseButton.querySelector(".codicon-collapse-all");

    expect(icon).toBeTruthy();

    fireEvent.click(condenseButton);

    expect(onCondense).toHaveBeenCalledTimes(1);
  });
});
