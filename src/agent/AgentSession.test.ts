import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContentBlock } from "./providers/types.js";
import { AgentSession } from "./AgentSession.js";
import type { AgentConfig } from "./types.js";
import { buildSystemPrompt } from "./systemPrompt.js";

// Mock buildSystemPrompt so create() doesn't hit the filesystem
vi.mock("./systemPrompt.js", () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue("mock system prompt"),
}));

const mockedBuildSystemPrompt = vi.mocked(buildSystemPrompt);

const testConfig: AgentConfig = {
  model: "claude-sonnet-4-6",
  maxTokens: 8192,
  thinkingBudget: 0,
  showThinking: false,
  autoCondense: true,
  autoCondenseThreshold: 0.9,
};

async function makeSession(
  opts: Partial<Parameters<typeof AgentSession.create>[0]> = {},
): Promise<AgentSession> {
  return AgentSession.create({
    mode: "code",
    config: testConfig,
    cwd: "/test",
    ...opts,
  });
}

describe("AgentSession", () => {
  beforeEach(() => {
    mockedBuildSystemPrompt.mockResolvedValue("mock system prompt");
  });

  describe("creation", () => {
    it("starts with no messages", async () => {
      const session = await makeSession();
      expect(session.getMessages()).toHaveLength(0);
      expect(session.messageCount).toBe(0);
    });

    it("assigns a unique id", async () => {
      const a = await makeSession();
      const b = await makeSession();
      expect(a.id).not.toBe(b.id);
      expect(a.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("stores the mode and model", async () => {
      const session = await makeSession({ mode: "ask" });
      expect(session.mode).toBe("ask");
      expect(session.model).toBe("claude-sonnet-4-6");
    });

    it("uses the system prompt from buildSystemPrompt", async () => {
      const session = await makeSession();
      expect(session.systemPrompt).toBe("mock system prompt");
    });

    it("defaults background to false", async () => {
      const session = await makeSession();
      expect(session.background).toBe(false);
    });

    it("sets background flag when specified", async () => {
      const session = await makeSession({ background: true });
      expect(session.background).toBe(true);
    });

    it("starts with idle status", async () => {
      const session = await makeSession();
      expect(session.status).toBe("idle");
    });

    it("starts with New Chat title", async () => {
      const session = await makeSession();
      expect(session.title).toBe("New Chat");
    });

    it("stores providerId when specified", async () => {
      const session = await makeSession({ providerId: "codex" });
      expect(session.providerId).toBe("codex");
    });

    it("providerId is undefined when not specified", async () => {
      const session = await makeSession();
      expect(session.providerId).toBeUndefined();
    });

    it("passes providerId to buildSystemPrompt on create", async () => {
      await makeSession({ providerId: "codex" });
      expect(mockedBuildSystemPrompt).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ providerId: "codex" }),
      );
    });

    it("defaults autoCondenseThreshold to 0.9 when not provided", async () => {
      const configWithoutThreshold: AgentConfig = {
        ...testConfig,
        autoCondenseThreshold: undefined as unknown as number,
      };
      const session = await AgentSession.create({
        mode: "code",
        config: configWithoutThreshold,
        cwd: "/test",
      });
      expect(session.autoCondenseThreshold).toBe(0.9);
    });
  });

  describe("messages", () => {
    it("addUserMessage appends a user message", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      const messages = session.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: "user", content: "hello" });
    });

    it("appendAssistantTurn appends an assistant message", async () => {
      const session = await makeSession();
      const blocks: ContentBlock[] = [{ type: "text", text: "response" }];
      session.appendAssistantTurn(blocks);
      const messages = session.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: "assistant", content: blocks });
    });

    it("appendToolResults appends tool results as a user message", async () => {
      const session = await makeSession();
      const results = [
        {
          type: "tool_result" as const,
          tool_use_id: "tu_123",
          content: "file contents",
        },
      ];
      session.appendToolResults(results);
      const messages = session.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: "user", content: results });
    });

    it("messageCount reflects added messages", async () => {
      const session = await makeSession();
      expect(session.messageCount).toBe(0);
      session.addUserMessage("one");
      expect(session.messageCount).toBe(1);
      session.appendAssistantTurn([{ type: "text", text: "two" }]);
      expect(session.messageCount).toBe(2);
    });

    it("getMessages returns all messages in order", async () => {
      const session = await makeSession();
      session.addUserMessage("user msg");
      session.appendAssistantTurn([{ type: "text", text: "assistant msg" }]);
      const msgs = session.getMessages();
      expect(msgs[0].role).toBe("user");
      expect(msgs[1].role).toBe("assistant");
    });

    it("keeps runtime errors in full history but excludes them from provider history", async () => {
      const session = await makeSession();
      session.addUserMessage("user msg");
      session.appendRuntimeError(
        "Codex API error: An error occurred while processing your request.",
        true,
      );

      expect(session.getAllMessages()).toHaveLength(2);
      expect(session.getAllMessages()[1]?.runtimeError).toEqual({
        message:
          "Codex API error: An error occurred while processing your request.",
        retryable: true,
      });

      const msgs = session.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toEqual({ role: "user", content: "user msg" });
    });

    it("dedupes consecutive identical runtime errors", async () => {
      const session = await makeSession();
      session.appendRuntimeError("same error", false);
      session.appendRuntimeError("same error", true);

      expect(session.getAllMessages()).toHaveLength(1);
      expect(session.getAllMessages()[0]?.runtimeError).toEqual({
        message: "same error",
        retryable: true,
      });
    });

    it("injects canonical resume context into provider history after a condense summary", async () => {
      const session = await makeSession();
      session.replaceMessages([
        {
          role: "user",
          isSummary: true,
          condenseId: "condense-1",
          preservedContext: {
            toolNames: ["read_file"],
            mcpServerNames: ["linear"],
          },
          content: [
            {
              type: "text",
              text: '<system-reminder>\n## Resume Anchor (deterministic)\n- Latest user message: "Fix issue"\n- Continue from this task: "Fix issue"\n\n## Canonical User Messages (deterministic)\n1. "Fix issue"\n\n## Pending Tasks (deterministic heuristic)\n- Fix issue\n\n## Preserved Runtime Context (reattached outside transcript)\n### Available tool names\n- read_file\n\n### MCP servers with exposed tools\n- linear\n</system-reminder>',
            },
            { type: "text", text: "## Conversation Summary\n\nSummary body" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Need a bit more context." }],
        },
        { role: "user", content: "Continue fixing the issue." },
      ]);

      const msgs = session.getMessages();
      expect(msgs).toHaveLength(4);
      expect(msgs[0]?.isSummary).toBe(true);
      expect(msgs[1]?.role).toBe("assistant");
      expect(msgs[2]?.role).toBe("user");
      expect(msgs[2]?.isResumeContext).toBe(true);
      expect(Array.isArray(msgs[2]?.content)).toBe(true);
      const injected = msgs[2]?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(injected[0]?.text).toContain("## Resume Anchor (deterministic)");
      expect(msgs[3]).toEqual({
        role: "user",
        content: "Continue fixing the issue.",
      });
    });
  });

  describe("autoTitle", () => {
    it("sets title from first user message text", async () => {
      const session = await makeSession();
      session.addUserMessage("Fix the login bug");
      session.autoTitle();
      expect(session.title).toBe("Fix the login bug");
    });

    it("truncates long messages to 80 chars", async () => {
      const session = await makeSession();
      const longMsg = "x".repeat(100);
      session.addUserMessage(longMsg);
      session.autoTitle();
      expect(session.title).toHaveLength(80);
    });

    it("does nothing when there are no messages", async () => {
      const session = await makeSession();
      session.autoTitle();
      expect(session.title).toBe("New Chat");
    });

    it("does nothing when first message has non-string content", async () => {
      const session = await makeSession();
      session.appendAssistantTurn([{ type: "text", text: "hello" }]);
      session.autoTitle();
      expect(session.title).toBe("New Chat");
    });
  });

  describe("token tracking", () => {
    it("starts at zero", async () => {
      const session = await makeSession();
      expect(session.totalInputTokens).toBe(0);
      expect(session.totalOutputTokens).toBe(0);
    });

    it("accumulates across multiple calls", async () => {
      const session = await makeSession();
      session.addUsage(100, 50);
      session.addUsage(200, 75);
      expect(session.totalInputTokens).toBe(300);
      expect(session.totalOutputTokens).toBe(125);
    });

    it("lastInputTokens includes cache tokens for context window tracking", async () => {
      const session = await makeSession();
      // Simulate an API response where most tokens were cache reads:
      // input_tokens=50 (uncached), cache_read=9000, cache_creation=1000
      session.addUsage(50, 200, 9000, 1000);
      // lastInputTokens should be the TOTAL context window usage
      expect(session.lastInputTokens).toBe(50 + 9000 + 1000);
      // totalInputTokens accumulates just the raw API input_tokens (uncached)
      expect(session.totalInputTokens).toBe(50);
      expect(session.lastCacheReadTokens).toBe(9000);
    });

    it("restoreFromStore restores cache totals and last token snapshot", async () => {
      const session = await makeSession();
      session.restoreFromStore({
        id: "session-1",
        title: "Restored",
        createdAt: 1,
        lastActiveAt: 2,
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalCacheReadTokens: 300,
        totalCacheCreationTokens: 400,
        lastInputTokens: 500,
        lastCacheReadTokens: 600,
        messages: [{ role: "user", content: "hello" }],
      });

      expect(session.totalInputTokens).toBe(100);
      expect(session.totalOutputTokens).toBe(200);
      expect(session.totalCacheReadTokens).toBe(300);
      expect(session.totalCacheCreationTokens).toBe(400);
      expect(session.lastInputTokens).toBe(500);
      expect(session.lastCacheReadTokens).toBe(600);
    });

    it("restoreFromStore defaults cache and last-token fields for older data", async () => {
      const session = await makeSession();
      session.restoreFromStore({
        id: "session-2",
        title: "Restored",
        createdAt: 1,
        lastActiveAt: 2,
        totalInputTokens: 10,
        totalOutputTokens: 20,
        messages: [{ role: "user", content: "hello" }],
      });

      expect(session.totalCacheReadTokens).toBe(0);
      expect(session.totalCacheCreationTokens).toBe(0);
      expect(session.lastInputTokens).toBe(0);
      expect(session.lastCacheReadTokens).toBe(0);
    });
  });

  describe("mode switching", () => {
    it("setMode updates mode metadata and preserves message history", async () => {
      const session = await makeSession({ mode: "code" });
      session.addUserMessage("keep this context");
      const priorMessageCount = session.messageCount;

      mockedBuildSystemPrompt.mockResolvedValueOnce("mock ask prompt");
      await session.setMode("ask");

      expect(session.mode).toBe("ask");
      expect(session.agentMode.slug).toBe("ask");
      expect(session.systemPrompt).toBe("mock ask prompt");
      expect(session.messageCount).toBe(priorMessageCount);
      expect(session.getMessages()[0]).toEqual({
        role: "user",
        content: "keep this context",
      });
    });

    it("setMode passes stored providerId to buildSystemPrompt", async () => {
      const session = await makeSession({ providerId: "codex" });
      mockedBuildSystemPrompt.mockClear();
      mockedBuildSystemPrompt.mockResolvedValueOnce("mock ask prompt");
      await session.setMode("ask");
      expect(mockedBuildSystemPrompt).toHaveBeenCalledWith(
        "ask",
        "/test",
        expect.objectContaining({ providerId: "codex" }),
      );
    });
  });

  describe("rebuildSystemPrompt", () => {
    it("passes stored providerId to buildSystemPrompt", async () => {
      const session = await makeSession({ providerId: "codex" });
      mockedBuildSystemPrompt.mockClear();
      mockedBuildSystemPrompt.mockResolvedValueOnce("rebuilt prompt");
      await session.rebuildSystemPrompt();
      expect(mockedBuildSystemPrompt).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ providerId: "codex" }),
      );
      expect(session.systemPrompt).toBe("rebuilt prompt");
    });
  });

  describe("abort", () => {
    it("starts not aborted", async () => {
      const session = await makeSession();
      expect(session.isAborted).toBe(false);
    });

    it("abortSignal is undefined before createAbortController", async () => {
      const session = await makeSession();
      expect(session.abortSignal).toBeUndefined();
    });

    it("creates an AbortController and exposes the signal", async () => {
      const session = await makeSession();
      const ac = session.createAbortController();
      expect(ac).toBeInstanceOf(AbortController);
      expect(session.abortSignal).toBe(ac.signal);
      expect(session.isAborted).toBe(false);
    });

    it("abort() signals the controller", async () => {
      const session = await makeSession();
      session.createAbortController();
      expect(session.isAborted).toBe(false);
      session.abort();
      expect(session.isAborted).toBe(true);
    });

    it("isAborted is false after abort() when no controller was created", async () => {
      const session = await makeSession();
      session.abort(); // no-op
      expect(session.isAborted).toBe(false);
    });
  });
});
