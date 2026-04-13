import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetBackgroundState = vi.fn();
const mockInterruptTerminal = vi.fn();
const mockGetRecentlyClosedTerminals = vi.fn();

vi.mock("../integrations/TerminalManager.js", () => ({
  getTerminalManager: () => ({
    log: undefined,
    getBackgroundState: mockGetBackgroundState,
    interruptTerminal: mockInterruptTerminal,
    getRecentlyClosedTerminals: mockGetRecentlyClosedTerminals,
  }),
}));

describe("handleGetTerminalOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRecentlyClosedTerminals.mockReturnValue([]);
  });

  it("returns terminal recovery metadata when terminal id is missing", async () => {
    mockGetBackgroundState.mockReturnValue(undefined);
    mockGetRecentlyClosedTerminals.mockReturnValue([
      { id: "term_5", name: "snapshot-run", closedAt: Date.now() - 1000 },
    ]);

    const { handleGetTerminalOutput } = await import("./getTerminalOutput.js");
    const result = await handleGetTerminalOutput({ terminal_id: "term_42" });
    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    if (textItem.type !== "text") throw new Error("Expected text result");
    const payload = JSON.parse(textItem.text);

    expect(payload.error).toContain('Terminal "term_42" not found');
    expect(payload.hint).toContain("terminal_name");
    expect(payload.recently_closed_terminals).toHaveLength(1);
    expect(payload.recently_closed_terminals[0].terminal_id).toBe("term_5");
    expect(payload.recently_closed_terminals[0].terminal_name).toBe(
      "snapshot-run",
    );
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
