import { describe, it, expect } from "vitest";
import { getToolCallVisualState } from "./ToolCallBlock";

describe("getToolCallVisualState", () => {
  it("marks incomplete tool calls as running", () => {
    const state = getToolCallVisualState({
      name: "apply_diff",
      complete: false,
      result: "",
    });

    expect(state).toEqual({
      statusClass: "tool-running",
      statusIconClass: "codicon-loading codicon-modifier-spin",
      cmdExitBadge: null,
    });
  });

  it("marks error-shaped payloads as error", () => {
    const state = getToolCallVisualState({
      name: "apply_diff",
      complete: true,
      result: JSON.stringify({
        error: "All search/replace blocks failed",
        failed_blocks: ["Block 0: Search content not found"],
        path: "src/agent/webview/App.tsx",
      }),
    });

    expect(state.statusClass).toBe("tool-error");
    expect(state.statusIconClass).toBe("codicon-error");
  });

  it("marks execute_command non-zero exit as warning with badge", () => {
    const state = getToolCallVisualState({
      name: "execute_command",
      complete: true,
      result: JSON.stringify({ exit_code: 2, output: "failed" }),
    });

    expect(state.statusClass).toBe("tool-warning");
    expect(state.statusIconClass).toBe("codicon-warning");
    expect(state.cmdExitBadge).toBe("2");
  });

  it("does not warn on execute_command exit_code 0", () => {
    const state = getToolCallVisualState({
      name: "execute_command",
      complete: true,
      result: JSON.stringify({ exit_code: 0, output: "ok" }),
    });

    expect(state.statusClass).toBe("tool-success");
    expect(state.statusIconClass).toBe("codicon-check");
    expect(state.cmdExitBadge).toBe(null);
  });

  it("marks partial results as warning", () => {
    const state = getToolCallVisualState({
      name: "apply_diff",
      complete: true,
      result: JSON.stringify({
        status: "accepted",
        partial: true,
        failed_blocks: [1],
      }),
    });

    expect(state.statusClass).toBe("tool-warning");
    expect(state.statusIconClass).toBe("codicon-warning");
  });
});
