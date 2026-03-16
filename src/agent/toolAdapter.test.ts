import { describe, it, expect, vi } from "vitest";
import {
  getAgentTools,
  dispatchToolCall,
  READ_ONLY_TOOLS,
  type ToolDispatchContext,
} from "./toolAdapter.js";

// Mock all tool handlers so dispatchToolCall tests don't hit VS Code APIs
vi.mock("../tools/readFile.js", () => ({
  handleReadFile: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "file content" }] }),
}));
vi.mock("../tools/listFiles.js", () => ({
  handleListFiles: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "files" }] }),
}));
vi.mock("../tools/searchFiles.js", () => ({
  handleSearchFiles: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "matches" }] }),
}));
vi.mock("../tools/writeFile.js", () => ({
  handleWriteFile: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "written" }] }),
}));
vi.mock("../tools/applyDiff.js", () => ({
  handleApplyDiff: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "patched" }] }),
}));
vi.mock("../tools/findAndReplace.js", () => ({
  handleFindAndReplace: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "replaced" }] }),
}));
vi.mock("../tools/executeCommand.js", () => ({
  handleExecuteCommand: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "output" }] }),
}));
vi.mock("../tools/getTerminalOutput.js", () => ({
  handleGetTerminalOutput: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "terminal" }] }),
}));
vi.mock("../tools/closeTerminals.js", () => ({
  handleCloseTerminals: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "closed" }] }),
}));
vi.mock("../tools/openFile.js", () => ({
  handleOpenFile: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "opened" }] }),
}));
vi.mock("../tools/showNotification.js", () => ({
  handleShowNotification: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "shown" }] }),
}));
vi.mock("../tools/getDiagnostics.js", () => ({
  handleGetDiagnostics: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "diags" }] }),
}));
vi.mock("../tools/goToDefinition.js", () => ({
  handleGoToDefinition: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "def" }] }),
}));
vi.mock("../tools/goToImplementation.js", () => ({
  handleGoToImplementation: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "impl" }] }),
}));
vi.mock("../tools/goToTypeDefinition.js", () => ({
  handleGoToTypeDefinition: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "typedef" }] }),
}));
vi.mock("../tools/getReferences.js", () => ({
  handleGetReferences: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "refs" }] }),
}));
vi.mock("../tools/getSymbols.js", () => ({
  handleGetSymbols: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "symbols" }] }),
}));
vi.mock("../tools/getHover.js", () => ({
  handleGetHover: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "hover" }] }),
}));
vi.mock("../tools/getCompletions.js", () => ({
  handleGetCompletions: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "completions" }] }),
}));
vi.mock("../tools/codeActions.js", () => ({
  handleGetCodeActions: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "actions" }] }),
  handleApplyCodeAction: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "applied" }] }),
}));
vi.mock("../tools/getCallHierarchy.js", () => ({
  handleGetCallHierarchy: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "calls" }] }),
}));
vi.mock("../tools/getTypeHierarchy.js", () => ({
  handleGetTypeHierarchy: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "types" }] }),
}));
vi.mock("../tools/getInlayHints.js", () => ({
  handleGetInlayHints: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "hints" }] }),
}));
vi.mock("../tools/renameSymbol.js", () => ({
  handleRenameSymbol: vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "renamed" }] }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOnApprovalRequest = vi.fn();
const mockCtx: ToolDispatchContext = {
  approvalManager: {} as any,
  approvalPanel: {} as any,
  sessionId: "test-session",
  extensionUri: {} as any,
  onApprovalRequest: mockOnApprovalRequest,
};

describe("READ_ONLY_TOOLS", () => {
  it("includes expected read-only tools", () => {
    expect(READ_ONLY_TOOLS.has("read_file")).toBe(true);
    expect(READ_ONLY_TOOLS.has("list_files")).toBe(true);
    expect(READ_ONLY_TOOLS.has("search_files")).toBe(true);
    expect(READ_ONLY_TOOLS.has("get_diagnostics")).toBe(true);
    expect(READ_ONLY_TOOLS.has("get_hover")).toBe(true);
    expect(READ_ONLY_TOOLS.has("get_symbols")).toBe(true);
    expect(READ_ONLY_TOOLS.has("go_to_definition")).toBe(true);
    expect(READ_ONLY_TOOLS.has("codebase_search")).toBe(true);
  });

  it("does not include write tools", () => {
    expect(READ_ONLY_TOOLS.has("write_file")).toBe(false);
    expect(READ_ONLY_TOOLS.has("apply_diff")).toBe(false);
    expect(READ_ONLY_TOOLS.has("find_and_replace")).toBe(false);
    expect(READ_ONLY_TOOLS.has("execute_command")).toBe(false);
    expect(READ_ONLY_TOOLS.has("rename_symbol")).toBe(false);
  });
});

describe("getAgentTools", () => {
  it("returns an array of tools", () => {
    const tools = getAgentTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  it("every tool has name, description, and input_schema", () => {
    for (const tool of getAgentTools()) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect((tool.description ?? "").length).toBeGreaterThan(0);
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe("object");
    }
  });

  it("does not include handshake", () => {
    const names = getAgentTools().map((t) => t.name);
    expect(names).not.toContain("handshake");
  });

  it("gates feedback tools by build type", () => {
    const names = getAgentTools().map((t) => t.name);
    if (__DEV_BUILD__) {
      expect(names).toContain("send_feedback");
      expect(names).toContain("get_feedback");
      expect(names).toContain("delete_feedback");
    } else {
      expect(names).not.toContain("send_feedback");
      expect(names).not.toContain("get_feedback");
      expect(names).not.toContain("delete_feedback");
    }
  });

  it("includes the core file tools", () => {
    const names = getAgentTools().map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("apply_diff");
    expect(names).toContain("execute_command");
    expect(names).toContain("get_diagnostics");
  });

  it("restricts tools when toolProfile is set to 'review'", () => {
    const reviewTools = getAgentTools(undefined, undefined, true, "review");
    const names = reviewTools.map((t) => t.name);
    // Should include read-only review tools
    expect(names).toContain("read_file");
    expect(names).toContain("search_files");
    expect(names).toContain("codebase_search");
    expect(names).toContain("get_diagnostics");
    expect(names).toContain("get_hover");
    expect(names).toContain("get_symbols");
    expect(names).toContain("get_references");
    // Should NOT include write tools, command tools, or MCP meta tools
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("apply_diff");
    expect(names).not.toContain("execute_command");
    expect(names).not.toContain("find_and_replace");
    expect(names).not.toContain("list_mcp_resources");
    expect(names).not.toContain("ask_user");
  });

  it("does not restrict tools when toolProfile is undefined", () => {
    const allTools = getAgentTools(undefined, undefined, true);
    const reviewTools = getAgentTools(undefined, undefined, true, "review");
    expect(allTools.length).toBeGreaterThan(reviewTools.length);
  });

  it("returns tools with valid JSON Schema input_schema (properties + type)", () => {
    for (const tool of getAgentTools()) {
      // Schema must be an object type with properties
      expect(tool.input_schema.type).toBe("object");
    }
  });
});

describe("spawn_background_agent tool", () => {
  it("schema includes routing params but not guardrail params", () => {
    const spawnTool = getAgentTools().find(
      (t) => t.name === "spawn_background_agent",
    );
    expect(spawnTool).toBeDefined();
    const props = (spawnTool?.input_schema.properties ?? {}) as Record<
      string,
      unknown
    >;
    expect(props.mode).toBeDefined();
    expect(props.model).toBeDefined();
    expect(props.provider).toBeDefined();
    expect(props.taskClass).toBeDefined();
    expect(props.modelTier).toBeDefined();
    // Guardrail params removed — background agents run without limits
    expect(props.timeoutSeconds).toBeUndefined();
    expect(props.tokenBudget).toBeUndefined();
    expect(props.maxToolCalls).toBeUndefined();
  });

  it("dispatches structured request and returns structured result", async () => {
    const onSpawnBackground = vi.fn().mockResolvedValue({
      sessionId: "bg-123",
      resolvedMode: "review",
      resolvedModel: "claude-sonnet-4-6",
      resolvedProvider: "anthropic",
      taskClass: "review_code",
      routingReason: "routed by opposite provider strategy",
      fallbackUsed: false,
    });

    const result = await dispatchToolCall(
      "spawn_background_agent",
      {
        task: "Review patch",
        message: "Review the recent changes",
        mode: "review",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        taskClass: "review_code",
        modelTier: "deep_reasoning",
      },
      { ...mockCtx, onSpawnBackground },
    );

    expect(onSpawnBackground).toHaveBeenCalledWith({
      task: "Review patch",
      message: "Review the recent changes",
      mode: "review",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      taskClass: "review_code",
      modelTier: "deep_reasoning",
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      sessionId: "bg-123",
      resolvedMode: "review",
      taskClass: "review_code",
      fallbackUsed: false,
    });
  });

  it("kill_background_agent tool exists in schema", () => {
    const killTool = getAgentTools().find(
      (t) => t.name === "kill_background_agent",
    );
    expect(killTool).toBeDefined();
    const props = (killTool?.input_schema.properties ?? {}) as Record<
      string,
      unknown
    >;
    expect(props.sessionId).toBeDefined();
    expect(props.reason).toBeDefined();
  });

  it("dispatches kill_background_agent to onKillBackground callback", async () => {
    const onKillBackground = vi.fn().mockReturnValue({
      killed: true,
      partialOutput: "some partial work",
    });

    const result = await dispatchToolCall(
      "kill_background_agent",
      { sessionId: "bg-456", reason: "taking too long" },
      { ...mockCtx, onKillBackground },
    );

    expect(onKillBackground).toHaveBeenCalledWith("bg-456", "taking too long");
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      killed: true,
      partialOutput: "some partial work",
    });
  });
});

describe("dispatchToolCall", () => {
  it("returns an error result for unknown tool names", async () => {
    const result = await dispatchToolCall("not_a_real_tool", {}, mockCtx);
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      error: expect.stringContaining("not_a_real_tool"),
    });
  });

  it("dispatches read_file to handleReadFile", async () => {
    const { handleReadFile } = await import("../tools/readFile.js");
    const result = await dispatchToolCall(
      "read_file",
      { path: "src/foo.ts" },
      mockCtx,
    );
    expect(handleReadFile).toHaveBeenCalledWith(
      { path: "src/foo.ts" },
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "file content",
    });
  });

  it("dispatches execute_command to handleExecuteCommand", async () => {
    const { handleExecuteCommand } = await import("../tools/executeCommand.js");
    const result = await dispatchToolCall(
      "execute_command",
      { command: "ls" },
      mockCtx,
    );
    expect(handleExecuteCommand).toHaveBeenCalledWith(
      { command: "ls" },
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      mockCtx.trackerCtx,
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: "output" });
  });

  it("dispatches write_file to handleWriteFile", async () => {
    const { handleWriteFile } = await import("../tools/writeFile.js");
    await dispatchToolCall(
      "write_file",
      { path: "foo.ts", content: "hello" },
      mockCtx,
    );
    expect(handleWriteFile).toHaveBeenCalledWith(
      { path: "foo.ts", content: "hello" },
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      mockCtx.onApprovalRequest,
      mockCtx.mode,
    );
  });

  it("dispatches show_notification to handleShowNotification", async () => {
    const { handleShowNotification } =
      await import("../tools/showNotification.js");
    const result = await dispatchToolCall(
      "show_notification",
      { message: "hi" },
      mockCtx,
    );
    expect(handleShowNotification).toHaveBeenCalledWith({ message: "hi" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "shown" });
  });

  it("dispatches find_and_replace with extensionUri", async () => {
    const { handleFindAndReplace } = await import("../tools/findAndReplace.js");
    await dispatchToolCall(
      "find_and_replace",
      { path: "**/*.ts", search: "old", replace: "new" },
      mockCtx,
    );
    expect(handleFindAndReplace).toHaveBeenCalledWith(
      { path: "**/*.ts", search: "old", replace: "new" },
      mockCtx.approvalManager,
      mockCtx.approvalPanel,
      mockCtx.sessionId,
      mockCtx.extensionUri,
      mockCtx.onApprovalRequest,
    );
  });

  it("dispatches get_terminal_output without ctx (params only)", async () => {
    const { handleGetTerminalOutput } =
      await import("../tools/getTerminalOutput.js");
    await dispatchToolCall(
      "get_terminal_output",
      { terminal_id: "t1" },
      mockCtx,
    );
    expect(handleGetTerminalOutput).toHaveBeenCalledWith({ terminal_id: "t1" });
  });
});
