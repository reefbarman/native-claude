import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./types.js";

const mocks = vi.hoisted(() => {
  const createSession = vi.fn(async (opts: any) => ({
    id: "session-1",
    mode: opts.mode,
    model: opts.config.model,
    providerId: opts.providerId,
    autoCondenseThreshold: opts.config.autoCondenseThreshold,
    title: "New Chat",
    background: Boolean(opts.background),
    status: "idle",
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    lastCacheReadTokens: 0,
    currentTool: undefined,
    addUserMessage: vi.fn(),
    appendRuntimeError: vi.fn(),
    consumePendingInterjection: vi.fn(() => null),
    queuePendingModeResume: vi.fn(),
    consumePendingModeResume: vi.fn(() => null),
    setPendingMedia: vi.fn(),
    autoTitle: vi.fn(),
    getAllMessages: vi.fn(() => []),
    rebuildSystemPrompt: vi.fn(async () => {}),
  }));

  return {
    createSession,
    getConfiguration: vi.fn(),
  };
});

vi.mock("vscode", async () => {
  const actual = await vi.importActual<typeof import("../__mocks__/vscode.js")>(
    "../__mocks__/vscode.js",
  );
  return {
    ...actual,
    workspace: {
      ...actual.workspace,
      getConfiguration: (...args: unknown[]) => mocks.getConfiguration(...args),
    },
  };
});

vi.mock("./AgentSession.js", () => ({
  AgentSession: {
    create: (opts: unknown) => mocks.createSession(opts),
  },
}));

import { AgentSessionManager } from "./AgentSessionManager.js";

describe("AgentSessionManager condense thresholds", () => {
  const makeConfig = (): AgentConfig => ({
    model: "claude-sonnet-4-6",
    maxTokens: 8192,
    thinkingBudget: 0,
    showThinking: false,
    autoCondense: true,
    autoCondenseThreshold: 0.9,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockReturnValue({
      get: (key: string) => {
        if (key === "modelCondenseThresholds") {
          return {
            "claude-sonnet-4-6": 0.72,
            "gpt-5.4": 0.83,
          };
        }
        return undefined;
      },
      inspect: () => undefined,
    });
  });

  it("uses persisted per-model thresholds when creating a session", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");

    await mgr.createSession("code");

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "claude-sonnet-4-6",
          autoCondenseThreshold: 0.72,
        }),
      }),
    );
  });

  it("applies persisted per-model thresholds when switching models", async () => {
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");
    const session = await mgr.createSession("code");

    await mgr.setModel("gpt-5.4");

    expect(mgr.getConfig().autoCondenseThreshold).toBe(0.83);
    expect(session.model).toBe("gpt-5.4");
    expect(session.autoCondenseThreshold).toBe(0.83);
  });

  it("falls back to model-family defaults when there is no stored override", async () => {
    mocks.getConfiguration.mockReturnValue({
      get: () => ({}),
      inspect: () => undefined,
    });
    const mgr = new AgentSessionManager(makeConfig(), "/tmp");

    await mgr.createSession("code");

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "claude-sonnet-4-6",
          autoCondenseThreshold: 0.6,
        }),
      }),
    );
  });

  it("falls back to default threshold resolution when config access fails", async () => {
    mocks.getConfiguration.mockImplementation(() => {
      throw new Error("boom");
    });
    const log = vi.fn();
    const mgr = new AgentSessionManager(
      makeConfig(),
      "/tmp",
      undefined,
      false,
      undefined,
      log,
    );

    await mgr.createSession("code");

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "claude-sonnet-4-6",
          autoCondenseThreshold: 0.6,
        }),
      }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to resolve configured condense threshold for claude-sonnet-4-6",
      ),
    );
  });
});
