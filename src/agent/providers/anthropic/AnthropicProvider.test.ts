import { describe, expect, it } from "vitest";

import { AnthropicProvider } from "./AnthropicProvider.js";

describe("AnthropicProvider capabilities", () => {
  const provider = new AnthropicProvider();

  it("reports 1M context for Sonnet and Opus", () => {
    expect(provider.getCapabilities("claude-sonnet-4-6").contextWindow).toBe(
      1_000_000,
    );
    expect(provider.getCapabilities("claude-opus-4-6").contextWindow).toBe(
      1_000_000,
    );
  });

  it("keeps Haiku at 200k context", () => {
    expect(
      provider.getCapabilities("claude-haiku-4-5-20251001").contextWindow,
    ).toBe(200_000);
  });

  it("keeps max output tokens at 128k for exposed models", () => {
    expect(provider.getCapabilities("claude-sonnet-4-6").maxOutputTokens).toBe(
      128_000,
    );
    expect(provider.getCapabilities("claude-opus-4-6").maxOutputTokens).toBe(
      128_000,
    );
    expect(
      provider.getCapabilities("claude-haiku-4-5-20251001").maxOutputTokens,
    ).toBe(128_000);
  });
});
