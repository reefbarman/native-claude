import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDispatchContext } from "./toolAdapter.js";

const mocks = vi.hoisted(() => {
  let seq = 0;
  return {
    setToolContext: vi.fn(),
    runBehavior: vi.fn<() => AsyncGenerator<unknown>>(),
    resolveBackgroundRoute: vi.fn(
      async (_registry: unknown, request: any, _foreground: unknown) => ({
        resolvedMode: request.mode ?? "review",
        resolvedModel: request.model ?? "claude-sonnet-4-6",
        resolvedProvider: request.provider ?? "anthropic",
        taskClass: request.taskClass ?? "general",
        routingReason: "test route",
        fallbackUsed: false,
      }),
    ),
    createSession: vi.fn(async (opts: any) => {
      seq += 1;
      let pendingModeResume: {
        mode: string;
        reason?: string;
        followUp?: string;
      } | null = null;
      return {
        id: `bg-${seq}`,
        mode: opts.mode,
        model: opts.config.model,
        providerId: opts.providerId,
        title: "New Chat",
        background: Boolean(opts.background),
        status: "idle",
        currentTool: undefined,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        addUserMessage: vi.fn(),
        appendRuntimeError: vi.fn(),
        consumePendingInterjection: vi.fn(() => null),
        queuePendingModeResume: vi.fn((mode: string, opts?: any) => {
          pendingModeResume = {
            mode,
            reason: opts?.reason,
            followUp: opts?.followUp,
          };
        }),
        consumePendingModeResume: vi.fn(() => {
          const pending = pendingModeResume;
          pendingModeResume = null;
          return pending;
        }),
        setPendingMedia: vi.fn(),
        autoTitle: vi.fn(),
        getAllMessages: vi.fn(() => []),
        abort: vi.fn(),
        getLastAssistantText: vi.fn(() => "background result"),
        getFullAssistantTranscript: vi.fn(() => "background transcript"),
      };
    }),
  };
});

vi.mock("./backgroundModelRouter.js", () => ({
  resolveBackgroundRoute: (
    registry: unknown,
    request: unknown,
    foreground: unknown,
  ) => mocks.resolveBackgroundRoute(registry, request, foreground),
}));

vi.mock("./AgentEngine.js", () => ({
  AgentEngine: class MockAgentEngine {
    setToolContext = mocks.setToolContext;
    run(..._args: unknown[]) {
      return mocks.runBehavior();
    }
  },
}));

vi.mock("./AgentSession.js", () => ({
  AgentSession: {
    create: (opts: unknown) => mocks.createSession(opts),
  },
}));

import { AgentSessionManager } from "./AgentSessionManager.js";

describe("AgentSessionManager background agents", () => {
  const config = {
    model: "claude-sonnet-4-6",
    maxTokens: 8192,
    thinkingBudget: 0,
    showThinking: false,
    autoCondense: true,
    autoCondenseThreshold: 0.9,
  };

  const toolCtx: ToolDispatchContext = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    approvalManager: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    approvalPanel: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extensionUri: {} as any,
    sessionId: "fg",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "done" };
      })(),
    );
  });

  it("rejects spawn when max concurrent limit is reached", async () => {
    const mgr = new AgentSessionManager(
      config,
      "/tmp",
      undefined,
      false,
      undefined,
      undefined,
      { maxConcurrent: 0 },
    );
    mgr.setToolContext(toolCtx);

    await expect(
      mgr.spawnBackground({ task: "t", message: "m" }),
    ).rejects.toThrow(/concurrency limit reached/);
  });

  it("tracks tool calls and token usage without enforcing limits", async () => {
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "tool_start", toolCallId: "tc-1", toolName: "search" };
        yield { type: "tool_start", toolCallId: "tc-2", toolName: "read" };
        yield {
          type: "api_request",
          requestId: "r1",
          model: "claude-sonnet-4-6",
          inputTokens: 5000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          durationMs: 10,
          timeToFirstToken: 2,
        };
        yield { type: "done" };
      })(),
    );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    await mgr.spawnBackground({
      task: "no limits",
      message: "run",
    });

    await new Promise((r) => setTimeout(r, 0));
    const info = mgr.getBgSessionInfos()[0];
    // Agent should complete normally — no guardrails to trigger
    expect(info).toBeDefined();
    expect(info.errorMessage).toBeUndefined();
  });

  it("exposes route summaries for debug payloads", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    await mgr.spawnBackground({
      task: "route summary",
      message: "run",
      taskClass: "review_code",
    });

    await new Promise((r) => setTimeout(r, 0));
    const summaries = mgr.getRecentBgRoutingSummaries();
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0]).toContain("mode=");
    expect(summaries[0]).toContain("provider=");
    expect(summaries[0]).toContain("model=");
  });

  it("killBackground stops a running session and returns partial output", async () => {
    // Use a long-running generator so the session stays "streaming"
    let yieldControl: () => void = () => {};
    mocks.runBehavior.mockReturnValue(
      (async function* () {
        yield { type: "text_delta", text: "partial work" };
        await new Promise<void>((resolve) => {
          yieldControl = resolve;
        });
        yield { type: "done" };
      })(),
    );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const result = await mgr.spawnBackground({
      task: "killable task",
      message: "do work",
    });

    // Give async generator time to start
    await new Promise((r) => setTimeout(r, 10));

    const killResult = mgr.killBackground(result.sessionId, "taking too long");
    expect(killResult.killed).toBe(true);
    expect(killResult.partialOutput).toBeDefined();

    // Cleanup: resolve the pending promise so the generator can exit
    yieldControl();
  });

  it("killBackground returns false for non-existent session", () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const result = mgr.killBackground("nonexistent");
    expect(result.killed).toBe(false);
  });

  it("resumes the foreground session when a background result returns after it stopped", async () => {
    mocks.runBehavior
      .mockReturnValueOnce(
        (async function* () {
          yield { type: "done" };
        })(),
      )
      .mockReturnValueOnce(
        (async function* () {
          yield { type: "done" };
        })(),
      );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const fg = await mgr.createSession("code");
    const sendMessageSpy = vi.spyOn(mgr, "sendMessage");

    const result = await mgr.spawnBackground({
      task: "inspect failing tests",
      message: "run the investigation",
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(sendMessageSpy).toHaveBeenCalledWith(
      fg.id,
      expect.stringContaining(
        `The background agent for "inspect failing tests" has returned while you were stopped.`,
      ),
      fg.mode,
    );
    expect(sendMessageSpy).toHaveBeenCalledWith(
      fg.id,
      expect.stringContaining(
        `<background_result task="inspect failing tests" sessionId="${result.sessionId}">`,
      ),
      fg.mode,
    );
  });

  it("does not resume the foreground session if it is still running", async () => {
    let releaseForeground: (() => void) | undefined;
    mocks.runBehavior
      .mockReturnValueOnce(
        (async function* () {
          await new Promise<void>((resolve) => {
            releaseForeground = resolve;
          });
          yield { type: "done" };
        })(),
      )
      .mockReturnValueOnce(
        (async function* () {
          yield { type: "done" };
        })(),
      );

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const fg = await mgr.createSession("code");
    const sendPromise = mgr.sendMessage(fg.id, "keep working", fg.mode);
    await new Promise((r) => setTimeout(r, 0));

    const sendMessageSpy = vi.spyOn(mgr, "sendMessage");

    await mgr.spawnBackground({
      task: "inspect failing tests",
      message: "run the investigation",
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(sendMessageSpy).not.toHaveBeenCalledWith(
      fg.id,
      expect.stringContaining("The background agent for"),
      fg.mode,
    );

    releaseForeground?.();
    await sendPromise;
  });

  it("auto-continues once after a queued mode switch resume", async () => {
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(toolCtx);

    const fg = await mgr.createSession("architect");
    const addUserMessageSpy = vi.spyOn(fg, "addUserMessage");

    mgr.queueModeSwitchResume(fg.id, "code", {
      reason: "Implementation should happen in code mode",
      followUp: "start with the concrete fix",
    });

    await mgr.sendMessage(fg.id, "plan the fix", fg.mode);

    expect(addUserMessageSpy).toHaveBeenNthCalledWith(1, "plan the fix");
    expect(addUserMessageSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("You just switched this session to code mode."),
    );
    expect(addUserMessageSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "Continue immediately in the new mode and start the next concrete implementation step now.",
      ),
    );
    expect(addUserMessageSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "Switch reason: Implementation should happen in code mode",
      ),
    );
    expect(addUserMessageSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("User follow-up: start with the concrete fix"),
    );
    expect(fg.consumePendingModeResume()).toBeNull();
    expect(mocks.runBehavior).toHaveBeenCalledTimes(2);
  });
});
