import { describe, expect, it } from "vitest";
import { resolveBackgroundRoute } from "./backgroundModelRouter.js";
import { ProviderRegistry } from "./providers/index.js";
import type {
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  StreamRequest,
  CompleteRequest,
  CompleteResult,
  ProviderStreamEvent,
} from "./providers/types.js";
import type { SpawnBackgroundRequest } from "./backgroundTypes.js";

const CAPS: ModelCapabilities = {
  supportsThinking: true,
  supportsCaching: true,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
};

function makeProvider(
  id: string,
  models: ModelInfo[],
  authenticated = true,
): ModelProvider {
  return {
    id,
    displayName: id,
    condenseModel: models[0]?.id ?? `${id}-condense`,
    async isAuthenticated() {
      return authenticated;
    },
    getCapabilities() {
      return CAPS;
    },
    listModels() {
      return models.filter((m) => m.provider === id);
    },
    async *stream(
      _request: StreamRequest,
    ): AsyncGenerator<ProviderStreamEvent> {
      yield { type: "done" };
    },
    async complete(_request: CompleteRequest): Promise<CompleteResult> {
      return { text: "ok" };
    },
  };
}

function makeModel(
  id: string,
  provider: string,
  overrides?: Partial<ModelCapabilities>,
): ModelInfo {
  return {
    id,
    displayName: id,
    provider,
    capabilities: { ...CAPS, ...overrides },
  };
}

function makeRegistry(providers: ModelProvider[]): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return registry;
}

describe("resolveBackgroundRoute", () => {
  it("defaults general task class to foreground model", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const registry = makeRegistry([makeProvider("anthropic", [anthModel])]);

    const request: SpawnBackgroundRequest = {
      task: "Investigate",
      message: "Look into this issue",
      taskClass: "general",
    };

    const route = await resolveBackgroundRoute(registry, request, {
      mode: "code",
      model: "claude-sonnet-4-6",
    });

    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("defaulted to foreground model");
  });

  it("review task prefers opposite provider when available", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [anthModel]),
      makeProvider("codex", [codexModel]),
    ]);

    const request: SpawnBackgroundRequest = {
      task: "Review PR",
      message: "Do a critical review",
      taskClass: "review_code",
    };

    const route = await resolveBackgroundRoute(registry, request, {
      mode: "code",
      model: "claude-sonnet-4-6",
    });

    expect(route.resolvedProvider).toBe("codex");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("opposite");
  });

  it("prefers sonnet for routine anthropic review fallbacks", async () => {
    const sonnet = makeModel("claude-sonnet-4-6", "anthropic");
    const opus = makeModel("claude-opus-4-6", "anthropic");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("anthropic", [sonnet, opus], true),
      makeProvider("codex", [codexModel], false),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review patch",
        message: "Quick review of these changes",
        taskClass: "review_code",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.resolvedModel).toBe("claude-sonnet-4-6");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=balanced");
  });

  it("prefers opus for complex anthropic review fallbacks", async () => {
    const sonnet = makeModel("claude-sonnet-4-6", "anthropic");
    const opus = makeModel("claude-opus-4-6", "anthropic");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("anthropic", [sonnet, opus], true),
      makeProvider("codex", [codexModel], false),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review critical auth refactor",
        message:
          "Do a thorough multi-file review focused on correctness, security, and edge cases.",
        taskClass: "review_code",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedProvider).toBe("anthropic");
    expect(route.resolvedModel).toBe("claude-opus-4-6");
    expect(route.fallbackUsed).toBe(false);
    expect(route.routingReason).toContain("tier=deep_reasoning");
  });

  it("honors explicit modelTier override for review tasks", async () => {
    const sonnet = makeModel("claude-sonnet-4-6", "anthropic");
    const opus = makeModel("claude-opus-4-6", "anthropic");
    const codexModel = makeModel("gpt-5-mini", "codex", {
      supportsThinking: false,
    });
    const registry = makeRegistry([
      makeProvider("anthropic", [sonnet, opus], true),
      makeProvider("codex", [codexModel], false),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review patch",
        message: "Quick review",
        taskClass: "review_code",
        modelTier: "deep_reasoning",
      },
      { mode: "code", model: "gpt-5" },
    );

    expect(route.resolvedModel).toBe("claude-opus-4-6");
    expect(route.routingReason).toContain("tier=deep_reasoning");
  });

  it("falls back when opposite provider is unavailable/auth-missing", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [anthModel], true),
      makeProvider("codex", [codexModel], false),
    ]);

    const request: SpawnBackgroundRequest = {
      task: "Review PR",
      message: "Do a critical review",
      taskClass: "review_code",
    };

    const route = await resolveBackgroundRoute(registry, request, {
      mode: "code",
      model: "claude-sonnet-4-6",
    });

    expect(route.fallbackUsed).toBe(true);
    expect(route.routingReason.toLowerCase()).toContain("fallback");
  });

  it("explicit model override wins and may ignore provider override mismatch", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [anthModel]),
      makeProvider("codex", [codexModel]),
    ]);

    const request: SpawnBackgroundRequest = {
      task: "Review PR",
      message: "Do a critical review",
      model: "gpt-5",
      provider: "anthropic",
    };

    const route = await resolveBackgroundRoute(registry, request, {
      mode: "code",
      model: "claude-sonnet-4-6",
    });

    expect(route.resolvedModel).toBe("gpt-5");
    expect(route.resolvedProvider).toBe("codex");
    expect(route.fallbackUsed).toBe(true);
    expect(route.routingReason).toContain("ignored requested provider");
  });

  it("returns thinkingBudget and maxToolCalls from review_code task class", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [anthModel]),
      makeProvider("codex", [codexModel]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review",
        message: "Review changes",
        taskClass: "review_code",
      },
      { mode: "code", model: "claude-sonnet-4-6" },
    );

    expect(route.thinkingBudget).toBe(4096);
    expect(route.maxToolCalls).toBe(10);
    expect(route.maxApiTurns).toBe(5);
    expect(route.toolProfile).toBe("review");
  });

  it("returns zero thinkingBudget for review_plan task class", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const codexModel = makeModel("gpt-5", "codex");
    const registry = makeRegistry([
      makeProvider("anthropic", [anthModel]),
      makeProvider("codex", [codexModel]),
    ]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "Review plan",
        message: "Review the plan",
        taskClass: "review_plan",
      },
      { mode: "architect", model: "claude-sonnet-4-6" },
    );

    expect(route.thinkingBudget).toBe(0);
    expect(route.maxToolCalls).toBe(5);
    expect(route.maxApiTurns).toBe(3);
    expect(route.toolProfile).toBe("review");
  });

  it("does not return overrides for general task class", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const registry = makeRegistry([makeProvider("anthropic", [anthModel])]);

    const route = await resolveBackgroundRoute(
      registry,
      {
        task: "General task",
        message: "Do something",
        taskClass: "general",
      },
      { mode: "code", model: "claude-sonnet-4-6" },
    );

    expect(route.thinkingBudget).toBeUndefined();
    expect(route.maxToolCalls).toBeUndefined();
    expect(route.maxApiTurns).toBeUndefined();
    expect(route.toolProfile).toBeUndefined();
  });

  it("throws for unavailable explicit model", async () => {
    const anthModel = makeModel("claude-sonnet-4-6", "anthropic");
    const registry = makeRegistry([makeProvider("anthropic", [anthModel])]);

    const request: SpawnBackgroundRequest = {
      task: "Review",
      message: "Review",
      model: "does-not-exist",
    };

    await expect(
      resolveBackgroundRoute(registry, request, {
        mode: "code",
        model: "claude-sonnet-4-6",
      }),
    ).rejects.toThrow(/Requested model/);
  });
});
