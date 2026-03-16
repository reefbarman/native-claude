import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener<T> = (value: T) => void;

class MockEventEmitter<T> {
  private listeners = new Set<Listener<T>>();

  event = (listener: Listener<T>) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

const mockPostMessage = vi.fn();
const mockOutputChannel = {
  appendLine: vi.fn(),
  info: vi.fn(),
  dispose: vi.fn(),
};

vi.mock("../extension.js", () => ({
  DIFF_VIEW_URI_SCHEME: "agentlink-diff",
}));

const mockGetConfiguration = vi.fn(() => ({
  get: vi.fn((key: string, fallback?: unknown) => {
    if (key === "modelCondenseThresholds") {
      return { "claude-sonnet-4-6": 0.8 };
    }
    return fallback;
  }),
  inspect: vi.fn(() => undefined),
  update: vi.fn(),
}));

vi.mock("vscode", () => ({
  EventEmitter: MockEventEmitter,
  window: {
    createOutputChannel: vi.fn(() => mockOutputChannel),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    activeTextEditor: undefined,
  },
  workspace: {
    getConfiguration: mockGetConfiguration,
    workspaceFolders: [],
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    createFileSystemWatcher: vi.fn(() => ({
      onDidChange: vi.fn(),
      onDidCreate: vi.fn(),
      onDidDelete: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  Uri: {
    joinPath: vi.fn(() => ({ fsPath: "/tmp/dist" })),
    file: vi.fn((fsPath: string) => ({ fsPath })),
  },
  ViewColumn: { Beside: 2 },
}));

describe("ChatViewProvider session state sync", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetConfiguration.mockClear();
  });

  it("pushes a fresh stateUpdate when sessions change", async () => {
    const { ChatViewProvider } = await import("./ChatViewProvider.js");

    const provider = new ChatViewProvider(
      { fsPath: "/tmp/ext" } as never,
      { get: vi.fn(), update: vi.fn() } as never,
    );

    const fakeView = {
      webview: {
        postMessage: mockPostMessage,
      },
    };

    (provider as unknown as { view: unknown }).view = fakeView;
    (provider as unknown as { webviewReady: boolean }).webviewReady = true;

    const foreground = {
      id: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "tool_executing",
    };

    const manager: {
      getForegroundSession: () => typeof foreground;
      getConfig: () => { model: string; autoCondenseThreshold: number };
      getSessionInfos: () => Array<{
        id: string;
        status: string;
        title: string;
        mode: string;
        model: string;
        lastActiveAt: number;
      }>;
      getBgSessionInfos: () => unknown[];
      onEvent?: unknown;
      onBgQuestionAnswered?: unknown;
      onSessionsChanged?: () => void;
    } = {
      getForegroundSession: vi.fn(() => foreground),
      getConfig: vi.fn(() => ({
        model: "claude-sonnet-4-6",
        autoCondenseThreshold: 0.8,
      })),
      getSessionInfos: vi.fn(() => [
        {
          id: "session-1",
          status: "tool_executing",
          title: "Test",
          mode: "code",
          model: "claude-sonnet-4-6",
          lastActiveAt: Date.now(),
        },
      ]),
      getBgSessionInfos: vi.fn(() => []),
      onEvent: undefined,
      onBgQuestionAnswered: undefined,
      onSessionsChanged: undefined,
    };

    provider.setSessionManager(manager as never);
    manager.onSessionsChanged?.();

    expect(mockPostMessage).toHaveBeenCalledTimes(3);

    expect(mockPostMessage.mock.calls[0]?.[0]).toEqual({
      type: "stateUpdate",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        streaming: true,
        condenseThreshold: 0.8,
        agentWriteApproval: undefined,
      },
    });

    expect(mockPostMessage.mock.calls[1]?.[0]).toEqual({
      type: "agentSessionUpdate",
      sessions: [
        expect.objectContaining({
          id: "session-1",
          status: "tool_executing",
          title: "Test",
          mode: "code",
          model: "claude-sonnet-4-6",
        }),
      ],
    });

    expect(mockPostMessage.mock.calls[2]?.[0]).toEqual({
      type: "agentBgSessionsUpdate",
      sessions: [],
    });
  });
});
