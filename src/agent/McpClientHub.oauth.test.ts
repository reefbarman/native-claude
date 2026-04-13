import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as vscode from "vscode";

const mocks = vi.hoisted(() => ({
  showWarningMessage: vi.fn(
    async (
      _message: string,
      ..._items: string[]
    ): Promise<string | undefined> => undefined,
  ),
  showErrorMessage: vi.fn(
    async (
      _message: string,
      ..._items: string[]
    ): Promise<string | undefined> => undefined,
  ),
  showInformationMessage: vi.fn(
    async (
      _message: string,
      ..._items: string[]
    ): Promise<string | undefined> => undefined,
  ),
  createTransportConnect: vi.fn<() => Promise<void>>(async () => {
    throw new Error("not configured");
  }),
  createTransportClose: vi.fn(async () => {}),
  createTransportListTools: vi.fn(async () => ({ tools: [] })),
  createTransportListResources: vi.fn(async () => ({ resources: [] })),
  createTransportListPrompts: vi.fn(async () => ({ prompts: [] })),
  createTransportCallTool: vi.fn(async () => ({ content: [] })),
  providerStart: vi.fn(async () => {}),
  providerStop: vi.fn(() => {}),
  providerTokens: vi.fn<
    () => Promise<
      | {
          access_token: string;
          refresh_token?: string;
          token_type?: string;
          expires_in?: number;
        }
      | undefined
    >
  >(async () => undefined),
  providerInvalidateCredentials: vi.fn(async (_scope: string) => {}),
  providerClearTokens: vi.fn(async () => {}),
  providerForceReauth: vi.fn(async () => {}),
  providerDebugStateSnapshot: vi.fn(async (_label: string) => {}),
}));

vi.mock("vscode", async () => {
  const actual = await vi.importActual<typeof import("../__mocks__/vscode.js")>(
    "../__mocks__/vscode.js",
  );
  return {
    ...actual,
    window: {
      ...actual.window,
      showWarningMessage: mocks.showWarningMessage,
      showErrorMessage: mocks.showErrorMessage,
      showInformationMessage: mocks.showInformationMessage,
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(_transport: unknown): Promise<void> {
      return mocks.createTransportConnect();
    }

    async close(): Promise<void> {
      return mocks.createTransportClose();
    }

    async listTools(): Promise<{ tools: unknown[] }> {
      return mocks.createTransportListTools();
    }

    async listResources(): Promise<{ resources: unknown[] }> {
      return mocks.createTransportListResources();
    }

    async listPrompts(): Promise<{ prompts: unknown[] }> {
      return mocks.createTransportListPrompts();
    }

    setRequestHandler(): void {
      // no-op for test
    }

    async callTool(): Promise<{ content: unknown[] }> {
      return mocks.createTransportCallTool();
    }

    async readResource(): Promise<{ contents: unknown[] }> {
      return { contents: [] };
    }

    async getPrompt(): Promise<{ messages: unknown[] }> {
      return { messages: [] };
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    onclose?: () => void;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSEClientTransport {
    onclose?: () => void;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHttpClientTransport {
    onclose?: () => void;
  },
}));

vi.mock("./McpOAuthProvider.js", async () => {
  const actual = await vi.importActual<typeof import("./McpOAuthProvider.js")>(
    "./McpOAuthProvider.js",
  );
  return {
    ...actual,
    McpOAuthProvider: class MockMcpOAuthProvider {
      onLog?: (message: string) => void;
      onBeforeAuthorizationOpen?: () => boolean | Promise<boolean>;

      constructor(
        _serverName: string,
        _serverUrl: string,
        _storage: vscode.Memento,
      ) {}

      async start(): Promise<void> {
        await mocks.providerStart();
      }

      stop(): void {
        mocks.providerStop();
      }

      async tokens() {
        return mocks.providerTokens();
      }

      async invalidateCredentials(
        _scope: "all" | "client" | "tokens" | "verifier" | "discovery",
      ): Promise<void> {
        await mocks.providerInvalidateCredentials(_scope);
      }

      async clearTokens(): Promise<void> {
        await mocks.providerClearTokens();
      }

      async forceReauth(): Promise<void> {
        await mocks.providerForceReauth();
      }

      async debugStateSnapshot(_label: string): Promise<void> {
        await mocks.providerDebugStateSnapshot(_label);
      }
    },
  };
});

import { McpOAuthError } from "./McpOAuthProvider.js";
import { McpClientHub } from "./McpClientHub.js";
import type { McpServerConfig } from "./mcpConfig.js";

class FakeMemento implements vscode.Memento {
  private store = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) {
      return this.store.get(key) as T;
    }
    return defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

describe("McpClientHub OAuth recovery", () => {
  const notionCfg: McpServerConfig = {
    name: "notion",
    type: "http",
    url: "https://mcp.notion.example",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTransportConnect.mockReset();
    mocks.createTransportCallTool.mockReset();
    mocks.providerTokens.mockReset();
    mocks.providerInvalidateCredentials.mockReset();
    mocks.providerForceReauth.mockReset();
  });

  it("clears cached oauth client registration (not all credentials) on stale_client_redirect and schedules recovery", async () => {
    mocks.providerTokens.mockResolvedValue({
      access_token: "a",
      refresh_token: "r",
      token_type: "bearer",
    });
    mocks.createTransportConnect.mockRejectedValueOnce(
      new McpOAuthError(
        "stale_client_redirect",
        "stale redirect uri/client registration",
      ),
    );

    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([notionCfg]);

    expect(mocks.providerInvalidateCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.providerInvalidateCredentials).toHaveBeenCalledWith("client");
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      "AgentLink: Authentication did not succeed for 'notion' (redirect URI/client registration mismatch). Retrying once with fresh OAuth client registration…",
    );
    expect(hub.getServerInfos().find((s) => s.name === "notion")?.status).toBe(
      "error",
    );
  });

  it("stops temporary oauth provider if connect handoff does not reach connected", async () => {
    mocks.providerForceReauth.mockResolvedValue(undefined);
    mocks.createTransportConnect.mockRejectedValue(
      new Error("still unauthorized"),
    );

    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([notionCfg]);

    const stopsBeforeReauth = mocks.providerStop.mock.calls.length;
    await hub.reauthenticateServer("notion");

    expect(mocks.providerForceReauth).toHaveBeenCalledTimes(1);
    expect(mocks.providerStop.mock.calls.length).toBeGreaterThan(
      stopsBeforeReauth,
    );
    expect(hub.getServerInfos().find((s) => s.name === "notion")?.status).toBe(
      "error",
    );
  });

  it("marks server as auth-error and clears stale client registration when runtime call hits redirect mismatch", async () => {
    mocks.createTransportConnect.mockResolvedValue(undefined);
    mocks.createTransportCallTool.mockRejectedValueOnce(
      new McpOAuthError(
        "stale_client_redirect",
        'OAuth client registration for "notion" does not match the active redirect URI',
      ),
    );

    const hub = new McpClientHub(new FakeMemento());
    const statusSnapshots: Array<ReturnType<typeof hub.getServerInfos>> = [];
    hub.onStatusChange = (infos) => {
      statusSnapshots.push(infos);
    };

    await hub.connect([notionCfg]);

    await hub.callTool("notion__get_page", { id: "p" });

    expect(mocks.providerInvalidateCredentials).toHaveBeenCalledWith("client");
    expect(
      statusSnapshots.some((infos) => {
        const notion = infos.find((s) => s.name === "notion");
        return (
          notion?.status === "error" &&
          notion.error?.includes("redirect URI/client registration mismatch")
        );
      }),
    ).toBe(true);
  });

  it("enters manual reauth-required state when runtime auth indicates deferred refresh-token fallback", async () => {
    mocks.createTransportConnect.mockResolvedValue(undefined);
    mocks.createTransportCallTool.mockRejectedValueOnce(
      new McpOAuthError(
        "authorization_error",
        'OAuth authorization blocked for "notion": manual reauthentication required after refresh token failure',
      ),
    );

    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([notionCfg]);

    await hub.callTool("notion__get_page", { id: "p" });

    expect(hub.getServerInfos().find((s) => s.name === "notion")?.status).toBe(
      "error",
    );
    expect(
      hub.getServerInfos().find((s) => s.name === "notion")?.error,
    ).toContain("Use Reauthenticate to try again");

    await hub.reauthenticateServer("notion");
    expect(mocks.providerForceReauth).toHaveBeenCalledTimes(1);
  });

  it("reconnects automatically on generic runtime auth failure", async () => {
    mocks.createTransportConnect.mockResolvedValue(undefined);
    mocks.createTransportCallTool.mockRejectedValueOnce(
      new McpOAuthError("authorization_error", "oauth authorization failed"),
    );

    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([notionCfg]);

    await hub.callTool("notion__get_page", { id: "p" });

    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      "AgentLink: Authentication did not succeed for 'notion'. Reconnecting automatically…",
    );
  });
});
