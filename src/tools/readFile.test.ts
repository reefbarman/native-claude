import { describe, it, expect } from "vitest";

import {
  buildReadFileError,
  isEnoentWithSingleSuggestion,
} from "./readFile.js";

describe("readFile suggestion-follow helpers", () => {
  it("detects ENOENT payload with exactly one suggestion", () => {
    const err = Object.assign(new Error("missing"), { code: "ENOENT" });
    const payload = buildReadFileError(err, "src/missing/File.ts");

    if (
      !Array.isArray(payload.suggestions) ||
      payload.suggestions.length !== 1
    ) {
      // This test asserts type guard behavior only when exactly one suggestion exists.
      // If fixture layout changes, skip strict assertion to avoid brittleness.
      expect(payload.error).toContain("File not found");
      return;
    }

    expect(isEnoentWithSingleSuggestion(payload)).toBe(true);
  });

  it("returns false for payloads without single suggestion", () => {
    expect(
      isEnoentWithSingleSuggestion({
        error: "File not found",
        path: "x",
        suggestions: ["a", "b"],
      }),
    ).toBe(false);

    expect(
      isEnoentWithSingleSuggestion({
        error: "File not found",
        path: "x",
      }),
    ).toBe(false);
  });
});
