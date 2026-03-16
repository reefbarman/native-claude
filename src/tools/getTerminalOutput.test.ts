import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetBackgroundState = vi.fn();
const mockInterruptTerminal = vi.fn();

vi.mock("../integrations/TerminalManager.js", () => ({
  getTerminalManager: () => ({
    log: undefined,
    getBackgroundState: mockGetBackgroundState,
    interruptTerminal: mockInterruptTerminal,
  }),
}));

describe("handleGetTerminalOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns verification_hint when output capture is unavailable", async () => {
    mockGetBackgroundState.mockReturnValue({
      is_running: true,
      exit_code: null,
      output: "",
      output_captured: false,
    });

    const { handleGetTerminalOutput } = await import("./getTerminalOutput.js");
    const result = await handleGetTerminalOutput({ terminal_id: "term_42" });
    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    if (textItem.type !== "text") throw new Error("Expected text result");
    const payload = JSON.parse(textItem.text);

    expect(payload.output_captured).toBe(false);
    expect(payload.output).toContain("Output capture unavailable");
    expect(payload.verification_hint).toContain("term_42");
    expect(payload.verification_hint).toContain("rather than re-running it");
  });
});
