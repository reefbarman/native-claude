import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentConfig } from "./types.js";
import { AgentEngine } from "./AgentEngine.js";
import { AgentSession } from "./AgentSession.js";
import { ProviderRegistry } from "./providers/index.js";
import type {
  ModelProvider,
  ProviderStreamEvent,
  ModelCapabilities,
  ModelInfo,
  StreamRequest,
  CompleteRequest,
  CompleteResult,
} from "./providers/types.js";

const mocks = vi.hoisted(() => ({
  mockBuildSystemPrompt: vi.fn().mockResolvedValue("mock system prompt"),
  mockSummarizeConversation: vi.fn(),
  mockGetEffectiveHistory: vi.fn((messages: unknown[]) => messages),
  mockInjectSyntheticToolResults: vi.fn((messages: unknown[]) => messages),
}));

vi.mock("./systemPrompt.js", () => ({
  buildSystemPrompt: mocks.mockBuildSystemPrompt,
}));

vi.mock("./condense.js", () => ({
  summarizeConversation: mocks.mockSummarizeConversation,
  getEffectiveHistory: mocks.mockGetEffectiveHistory,
  injectSyntheticToolResults: mocks.mockInjectSyntheticToolResults,
}));

const TEST_MODEL = "claude-sonnet-4-6";

const testConfig: AgentConfig = {
  model: TEST_MODEL,
  maxTokens: 8192,
  thinkingBudget: 0,
  showThinking: false,
  autoCondense: true,
  autoCondenseThreshold: 0.9,
};

/**
 * Build a mock stream of ProviderStreamEvents for a simple text response.
 */
function makeProviderStream(opts?: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  text?: string;
}): ProviderStreamEvent[] {
  const inputTokens = opts?.inputTokens ?? 100;
  const outputTokens = opts?.outputTokens ?? 40;
  const cacheReadTokens = opts?.cacheReadTokens ?? 0;
  const cacheCreationTokens = opts?.cacheCreationTokens ?? 0;
  const text = opts?.text ?? "ok";
  return [
    { type: "text_delta", text },
    {
      type: "content_blocks",
      blocks: [{ type: "text", text }],
    },
    {
      type: "usage",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    },
    { type: "done" },
  ];
}

const TEST_CAPABILITIES: ModelCapabilities = {
  supportsThinking: false,
  supportsCaching: true,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
};

/**
 * Create a mock ModelProvider that yields from a configurable event list.
 */
function makeMockProvider(
  streamEvents?: ProviderStreamEvent[],
): ModelProvider & { setStreamEvents: (e: ProviderStreamEvent[]) => void } {
  let events = streamEvents ?? makeProviderStream();
  return {
    id: "mock",
    displayName: "Mock",
    condenseModel: "mock-fast",
    async isAuthenticated() {
      return true;
    },
    getCapabilities() {
      return TEST_CAPABILITIES;
    },
    listModels(): ModelInfo[] {
      return [
        {
          id: TEST_MODEL,
          displayName: "Claude Sonnet 4.6",
          provider: "mock",
          capabilities: TEST_CAPABILITIES,
        },
      ];
    },
    async *stream(_request: StreamRequest) {
      for (const event of events) {
        yield event;
      }
    },
    async complete(_request: CompleteRequest): Promise<CompleteResult> {
      return { text: "ok" };
    },
    setStreamEvents(e: ProviderStreamEvent[]) {
      events = e;
    },
  };
}

function makeRegistry(provider?: ModelProvider): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(provider ?? makeMockProvider());
  return registry;
}

async function makeSession(
  config: AgentConfig = testConfig,
): Promise<AgentSession> {
  return AgentSession.create({
    mode: "code",
    config,
    cwd: "/test",
  });
}

async function collectEvents(
  iter: AsyncGenerator<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

describe("AgentEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("auto-condense threshold behavior", () => {
    it("triggers auto-condense at 90% usage by default", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 173_000; // ~90% of effective window (200k - 8192 = 191808)
      session.lastCacheReadTokens = 0;

      const engine = new AgentEngine(makeRegistry());
      const condenseSpy = vi
        .spyOn(engine, "condenseSession")
        .mockImplementation(async function* () {
          yield { type: "condense_start", isAutomatic: true };
          yield {
            type: "condense",
            summary: "summary",
            prevInputTokens: 180_000,
            newInputTokens: 20_000,
          };
        });

      const events = await collectEvents(engine.run(session));
      expect(condenseSpy).toHaveBeenCalledTimes(1);
      expect(events.some((e) => e.type === "condense")).toBe(true);
    });

    it("does not auto-condense below threshold", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 170_000; // ~88.6% of effective window, below 90% threshold
      session.lastCacheReadTokens = 0;

      const engine = new AgentEngine(makeRegistry());
      const condenseSpy = vi.spyOn(engine, "condenseSession");

      await collectEvents(engine.run(session));
      expect(condenseSpy).not.toHaveBeenCalled();
    });

    it("uses cache-aware threshold and delays condense when cache hit ratio is high", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 180_000; // ~93.8% of effective window
      session.lastCacheReadTokens = 90_000; // 50% cache-hit ratio => threshold 95%, no condense

      const engine = new AgentEngine(makeRegistry());
      const condenseSpy = vi.spyOn(engine, "condenseSession");

      await collectEvents(engine.run(session));
      expect(condenseSpy).not.toHaveBeenCalled();
    });

    it("caps cache-aware threshold at 95%", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 183_000; // ~95.4% of effective window (191808), above 95% cap
      session.lastCacheReadTokens = 183_000; // ratio=1 would push above 100%, but cap is 95%

      const engine = new AgentEngine(makeRegistry());
      const condenseSpy = vi
        .spyOn(engine, "condenseSession")
        .mockImplementation(async function* () {
          yield { type: "condense_start", isAutomatic: true };
          yield {
            type: "condense",
            summary: "summary",
            prevInputTokens: 190_000,
            newInputTokens: 20_000,
          };
        });

      await collectEvents(engine.run(session));
      expect(condenseSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("token accounting", () => {
    it("reports api_request inputTokens as uncached + cache_read + cache_creation", async () => {
      const provider = makeMockProvider(
        makeProviderStream({
          inputTokens: 50,
          outputTokens: 25,
          cacheReadTokens: 9000,
          cacheCreationTokens: 1000,
        }),
      );

      const session = await makeSession();
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));
      const apiRequest = events.find((e) => e.type === "api_request");
      expect(apiRequest).toBeDefined();
      if (!apiRequest || apiRequest.type !== "api_request") return;

      expect(apiRequest.inputTokens).toBe(10_050);
      expect(apiRequest.cacheReadTokens).toBe(9000);
      expect(apiRequest.cacheCreationTokens).toBe(1000);
      expect(session.lastInputTokens).toBe(10_050);
      expect(session.totalInputTokens).toBe(50);
      expect(session.totalCacheReadTokens).toBe(9000);
      expect(session.totalCacheCreationTokens).toBe(1000);
    });

    it("auto-retries Codex processing errors and still marks exhausted failures retryable", async () => {
      let attempts = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        attempts += 1;
        yield* [];
        throw new Error(
          "Codex API error: An error occurred while processing your request. Please include the request ID req-123 in your message.",
        );
      };

      const timerSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((fn: TimerHandler) => {
          if (typeof fn === "function") fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      try {
        const session = await makeSession();
        session.addUserMessage("hello");
        const engine = new AgentEngine(makeRegistry(provider));

        const events = await collectEvents(engine.run(session));
        const warnings = events.filter((e) => e.type === "warning");
        const errorEvent = events.find((e) => e.type === "error");

        expect(attempts).toBe(4);
        expect(warnings).toHaveLength(3);
        expect(errorEvent).toBeDefined();
        expect(errorEvent).toMatchObject({
          type: "error",
          retryable: true,
        });
      } finally {
        timerSpy.mockRestore();
      }
    });
  });

  describe("condenseSession", () => {
    it("clears lastOutputTokens and lastCacheReadTokens after successful condense", async () => {
      mocks.mockSummarizeConversation.mockResolvedValue({
        messages: [{ role: "user", content: "summary", isSummary: true }],
        summary: "summary",
        prevInputTokens: 180_000,
        newInputTokens: 12_000,
      });

      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 180_000;
      session.lastOutputTokens = 5_000;
      session.lastCacheReadTokens = 100_000;

      const engine = new AgentEngine(makeRegistry());
      const events = await collectEvents(engine.condenseSession(session, true));

      expect(events.some((e) => e.type === "condense")).toBe(true);
      expect(session.lastInputTokens).toBe(12_000);
      expect(session.lastOutputTokens).toBe(0);
      expect(session.lastCacheReadTokens).toBe(0);
    });
  });
});
