import { describe, expect, it } from "vitest";

import {
  clampCondenseThreshold,
  getDefaultAutoCondenseThreshold,
  getEffectiveAutoCondenseThreshold,
  normalizeModelThresholdMap,
} from "./modelCondenseThresholds.js";

describe("modelCondenseThresholds", () => {
  it("defaults Anthropic Sonnet and Opus models to 0.6", () => {
    expect(getDefaultAutoCondenseThreshold("claude-sonnet-4-6")).toBe(0.6);
    expect(getDefaultAutoCondenseThreshold("claude-opus-4-6")).toBe(0.6);
  });

  it("defaults non-Sonnet/Opus models to 0.9", () => {
    expect(getDefaultAutoCondenseThreshold("claude-haiku-4-5-20251001")).toBe(
      0.9,
    );
    expect(getDefaultAutoCondenseThreshold("gpt-5.4")).toBe(0.9);
  });

  it("prefers explicit per-model overrides", () => {
    expect(
      getEffectiveAutoCondenseThreshold("claude-sonnet-4-6", {
        "claude-sonnet-4-6": 0.72,
      }),
    ).toBe(0.72);
  });

  it("normalizes and clamps stored threshold maps", () => {
    expect(
      normalizeModelThresholdMap({
        "claude-sonnet-4-6": 1.4,
        "gpt-5.4": 0.02,
        ignored: "bad",
      }),
    ).toEqual({
      "claude-sonnet-4-6": 1,
      "gpt-5.4": 0.1,
    });
  });

  it("clamps invalid raw threshold values", () => {
    expect(clampCondenseThreshold(Number.NaN)).toBe(0.9);
    expect(clampCondenseThreshold(0)).toBe(0.1);
    expect(clampCondenseThreshold(2)).toBe(1);
  });
});
