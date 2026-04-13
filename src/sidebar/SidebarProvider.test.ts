import { describe, it, expect, vi, beforeEach } from "vitest";

type MessageHandler = (message: Record<string, unknown>) => void;

const commandExec = vi.fn();

const mockVscode = {
  window: {
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showTextDocument: vi.fn(),
    createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() })),
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn(),
    })),
  },
  commands: {
    executeCommand: commandExec,
  },
  Uri: {
    joinPath: (...parts: Array<{ path?: string } | string>) => ({
      path: parts
        .map((p) => (typeof p === "string" ? p : (p.path ?? "")))
        .join("/"),
    }),
    file: (fsPath: string) => ({ fsPath }),
  },
  ConfigurationTarget: {
    Global: 1,
  },
};

vi.mock("vscode", () => mockVscode);

describe("SidebarProvider write approval sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("setWriteApproval session updates both legacy and agent approval tracks", async () => {
    const { SidebarProvider } = await import("./SidebarProvider.js");

    const provider = new SidebarProvider({ path: "/ext" } as never);

    const resetWriteApproval = vi.fn();
    const resetAgentWriteApproval = vi.fn();
    const setWriteApproval = vi.fn();
    const setAgentWriteApproval = vi.fn();

    provider.setApprovalManager({
      onDidChange: () => ({ dispose: vi.fn() }),
      getActiveSessions: () => [
        {
          id: "session-a",
          writeApproved: false,
          agentWriteApproved: false,
          commandRuleCount: 0,
          pathRuleCount: 0,
          writeRuleCount: 0,
          lastActivity: Date.now(),
        },
        {
          id: "session-b",
          writeApproved: false,
          agentWriteApproved: false,
          commandRuleCount: 0,
          pathRuleCount: 0,
          writeRuleCount: 0,
          lastActivity: Date.now(),
        },
      ],
      getAgentWriteApprovalState: () => "prompt",
      getWriteApprovalState: () => "prompt",
      getCommandRules: () => ({ session: [], project: [], global: [] }),
      getPathRules: () => ({ session: [], project: [], global: [] }),
      getWriteRules: () => ({
        session: [],
        project: [],
        global: [],
        settings: [],
      }),
      resetWriteApproval,
      resetAgentWriteApproval,
      setWriteApproval,
      setAgentWriteApproval,
    } as never);

    let onDidReceiveMessage: MessageHandler | undefined;

    provider.resolveWebviewView(
      {
        webview: {
          options: {},
          html: "",
          postMessage: vi.fn(),
          onDidReceiveMessage: (cb: MessageHandler) => {
            onDidReceiveMessage = cb;
            return { dispose: vi.fn() };
          },
          asWebviewUri: (uri: unknown) => uri,
        },
        visible: true,
        onDidChangeVisibility: vi.fn(),
        onDidDispose: vi.fn(),
      } as never,
      {} as never,
      {} as never,
    );

    expect(onDidReceiveMessage).toBeTypeOf("function");

    onDidReceiveMessage!({ command: "setWriteApproval", mode: "session" });

    expect(resetWriteApproval).toHaveBeenCalledTimes(1);
    expect(resetAgentWriteApproval).toHaveBeenCalledTimes(1);

    expect(setWriteApproval).toHaveBeenCalledTimes(2);
    expect(setWriteApproval).toHaveBeenNthCalledWith(1, "session-a", "session");
    expect(setWriteApproval).toHaveBeenNthCalledWith(2, "session-b", "session");

    expect(setAgentWriteApproval).toHaveBeenCalledTimes(2);
    expect(setAgentWriteApproval).toHaveBeenNthCalledWith(
      1,
      "session-a",
      "session",
    );
    expect(setAgentWriteApproval).toHaveBeenNthCalledWith(
      2,
      "session-b",
      "session",
    );
  });
});
