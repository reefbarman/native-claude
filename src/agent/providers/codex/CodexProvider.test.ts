import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, openAiConstructorMock } = vi.hoisted(() => {
  const createMock = vi.fn();
  const openAiConstructorMock = vi.fn();

  return { createMock, openAiConstructorMock };
});

vi.mock("openai", () => {
  class MockOpenAI {
    responses = {
      create: createMock,
    };

    constructor(options: unknown) {
      openAiConstructorMock(options);
    }
  }

  return {
    default: MockOpenAI,
    APIError: class APIError extends Error {
      status?: number;

      constructor(status: number | undefined, message: string) {
        super(message);
        this.status = status;
      }
    },
  };
});

import { CodexProvider } from "./CodexProvider.js";

function makeAuthManager(overrides?: Partial<Record<string, unknown>>) {
  return {
    resolveModelAuth: vi.fn().mockResolvedValue({
      method: "oauth",
      bearerToken: "token",
      accountId: "acct",
      canRefresh: true,
    }),
    forceRefreshModelAuth: vi.fn().mockResolvedValue({
      method: "oauth",
      bearerToken: "refreshed-token",
      accountId: "acct",
      canRefresh: true,
    }),
    isAuthenticated: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("CodexProvider.complete", () => {
  beforeEach(() => {
    createMock.mockReset();
    openAiConstructorMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses streaming mode and omits unsupported temperature", async () => {
    let requestBody: Record<string, unknown> | undefined;
    createMock.mockImplementationOnce(
      async (
        body: Record<string, unknown>,
        _options?: Record<string, unknown>,
      ) => {
        requestBody = body;
        return (async function* () {
          yield { type: "response.output_text.delta", delta: "hello" };
          yield {
            type: "response.done",
            response: {
              usage: {
                input_tokens: 12,
                output_tokens: 3,
              },
            },
          };
        })();
      },
    );

    const authManager = makeAuthManager();

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "Summarize this" }],
      maxTokens: 128,
      temperature: 0,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(openAiConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "token",
        baseURL: "https://chatgpt.com/backend-api/codex",
        defaultHeaders: expect.objectContaining({
          originator: "agentlink",
          session_id: expect.any(String),
          "ChatGPT-Account-Id": "acct",
        }),
        maxRetries: 0,
      }),
    );
    expect(requestBody).toMatchObject({
      model: "gpt-5.2-codex",
      instructions: "system",
      stream: true,
      store: false,
    });
    expect(requestBody).not.toHaveProperty("temperature");
    expect(result).toEqual({
      text: "hello",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
  });

  it("retries once on oauth auth failure", async () => {
    createMock
      .mockRejectedValueOnce(new Error("401 unauthorized"))
      .mockImplementationOnce(async () => {
        return (async function* () {
          yield { type: "response.output_text.delta", delta: "ok" };
          yield {
            type: "response.done",
            response: {
              usage: {
                input_tokens: 5,
                output_tokens: 1,
              },
            },
          };
        })();
      });

    const authManager = makeAuthManager();

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    expect(authManager.forceRefreshModelAuth).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("ok");
  });

  it("does not refresh the same oauth account repeatedly on persistent 401", async () => {
    createMock
      .mockRejectedValueOnce(new Error("401 unauthorized"))
      .mockRejectedValueOnce(new Error("401 unauthorized"));

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "oauth",
        bearerToken: "token",
        accountId: "acct",
        canRefresh: true,
        oauthAccountPoolId: "pool-1",
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue({
        method: "oauth",
        bearerToken: "refreshed-token",
        accountId: "acct",
        canRefresh: true,
        oauthAccountPoolId: "pool-1",
      }),
    });

    const provider = new CodexProvider(authManager as never);
    await expect(
      provider.complete({
        model: "gpt-5.2-codex",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 64,
      }),
    ).rejects.toThrow(/401 unauthorized/i);

    expect(authManager.forceRefreshModelAuth).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("recreates OpenAI client when oauth token changes after refresh", async () => {
    createMock
      .mockRejectedValueOnce(new Error("401 unauthorized"))
      .mockImplementationOnce(async () => {
        return (async function* () {
          yield { type: "response.output_text.delta", delta: "ok" };
          yield {
            type: "response.done",
            response: {
              usage: {
                input_tokens: 5,
                output_tokens: 1,
              },
            },
          };
        })();
      });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "oauth",
        bearerToken: "token-a",
        accountId: "acct",
        canRefresh: true,
        oauthAccountPoolId: "pool-1",
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue({
        method: "oauth",
        bearerToken: "token-b",
        accountId: "acct",
        canRefresh: true,
        oauthAccountPoolId: "pool-1",
      }),
    });

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    expect(authManager.forceRefreshModelAuth).toHaveBeenCalledTimes(1);
    expect(openAiConstructorMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("ok");
  });

  it("uses the OpenAI Responses endpoint for API-key auth", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "api" };
        yield {
          type: "response.done",
          response: {
            usage: {
              input_tokens: 7,
              output_tokens: 2,
            },
          },
        };
      })();
    });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.4",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    expect(openAiConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-test",
        baseURL: "https://api.openai.com/v1",
        defaultHeaders: expect.not.objectContaining({
          originator: expect.anything(),
        }),
        maxRetries: 0,
      }),
    );
    expect(result.text).toBe("api");
  });

  it("subtracts prompt_tokens_details.cached_tokens from OpenAI input_tokens", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "api" };
        yield {
          type: "response.done",
          response: {
            id: "resp_123",
            usage: {
              input_tokens: 1200,
              output_tokens: 40,
              prompt_tokens_details: {
                cached_tokens: 1024,
              },
            },
          },
        };
      })();
    });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.4",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    expect(result).toEqual({
      text: "api",
      usage: {
        inputTokens: 176,
        outputTokens: 40,
        cacheReadTokens: 1024,
        cacheCreationTokens: 0,
      },
      providerResponseId: "resp_123",
    });
  });

  it("clamps uncached input tokens at zero when cached_tokens exceeds reported input", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "api" };
        yield {
          type: "response.done",
          response: {
            usage: {
              input_tokens: 100,
              output_tokens: 5,
              input_tokens_details: {
                cached_tokens: 150,
              },
            },
          },
        };
      })();
    });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.4",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    expect(result).toEqual({
      text: "api",
      usage: {
        inputTokens: 0,
        outputTokens: 5,
        cacheReadTokens: 150,
        cacheCreationTokens: 0,
      },
    });
  });

  it("captures cache creation/write tokens from OpenAI usage details", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "api" };
        yield {
          type: "response.done",
          response: {
            usage: {
              input_tokens: 200,
              output_tokens: 10,
              input_tokens_details: {
                cached_tokens: 120,
                cache_creation_tokens: 30,
              },
            },
          },
        };
      })();
    });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.4",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    expect(result).toEqual({
      text: "api",
      usage: {
        inputTokens: 80,
        outputTokens: 10,
        cacheReadTokens: 120,
        cacheCreationTokens: 30,
      },
    });
  });

  it("passes prompt cache and state fields through when provided", async () => {
    let requestBody: Record<string, unknown> | undefined;
    createMock.mockImplementationOnce(async (body: Record<string, unknown>) => {
      requestBody = body;
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "ok" };
        yield {
          type: "response.done",
          response: {
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        };
      })();
    });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    await provider.complete({
      model: "gpt-5.4",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
      cache: { key: "codex:test:thread", retention: "24h" },
      state: { previousResponseId: "resp_prev", store: true },
    });

    // API-key path → public OpenAI Responses surface: all cache/state params supported
    expect(requestBody).toMatchObject({
      prompt_cache_key: "codex:test:thread",
      prompt_cache_retention: "24h",
      previous_response_id: "resp_prev",
      max_output_tokens: 64,
      store: true,
    });
  });

  it("serializes mixed text and pasted-image input with text first for gpt-5.4", async () => {
    let requestBody: Record<string, unknown> | undefined;
    createMock.mockImplementationOnce(async (body: Record<string, unknown>) => {
      requestBody = body;
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "seen" };
        yield {
          type: "response.done",
          response: {
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        };
      })();
    });

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    await provider.complete({
      model: "gpt-5.4",
      systemPrompt: "system",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what's in this image?" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "abc123",
              },
            },
          ],
        },
      ],
      maxTokens: 64,
    });

    expect(requestBody).toMatchObject({
      model: "gpt-5.4",
      max_output_tokens: 64,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "what's in this image?" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,abc123",
              detail: "auto",
            },
          ],
        },
      ],
    });
  });

  it("OAuth path omits cache/state params unsupported by ChatGPT backend", async () => {
    let requestBody: Record<string, unknown> | undefined;
    createMock.mockImplementationOnce(async (body: Record<string, unknown>) => {
      requestBody = body;
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "ok" };
        yield {
          type: "response.done",
          response: { usage: { input_tokens: 10, output_tokens: 2 } },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never); // oauth by default
    await provider.complete({
      model: "gpt-5.3-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
      cache: { key: "codex:test:thread", retention: "24h" },
      state: { previousResponseId: "resp_prev", store: true },
    });

    expect(requestBody).not.toHaveProperty("prompt_cache_key");
    expect(requestBody).not.toHaveProperty("prompt_cache_retention");
    expect(requestBody).not.toHaveProperty("previous_response_id");
    expect(requestBody).not.toHaveProperty("max_output_tokens");
  });

  it("canonicalizes top-level and nested tool schema key ordering", async () => {
    let requestBody: Record<string, unknown> | undefined;
    createMock.mockImplementationOnce(async (body: Record<string, unknown>) => {
      requestBody = body;
      return (async function* () {
        yield { type: "response.output_text.delta", delta: "ok" };
        yield {
          type: "response.done",
          response: {
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        };
      })();
    });

    const authManager = makeAuthManager();
    const provider = new CodexProvider(authManager as never);
    for await (const _event of provider.stream({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
      tools: [
        {
          name: "demo_tool",
          description: "demo",
          input_schema: {
            type: "object",
            required: ["zeta", "alpha"],
            properties: {
              zeta: {
                type: "string",
                description: "z",
                format: "uri",
              },
              alpha: {
                type: "object",
                properties: {
                  beta: { type: "number" },
                  alpha: { type: "string" },
                },
              },
            },
            additionalProperties: false,
            description: "demo schema",
          },
        },
      ],
    })) {
      // Drain the stream to completion so the request is issued.
    }

    const tools = requestBody?.tools as
      | Array<Record<string, unknown>>
      | undefined;
    expect(tools).toBeDefined();
    const parameters = tools?.[0]?.parameters as
      | Record<string, unknown>
      | undefined;
    expect(parameters).toBeDefined();
    expect(Object.keys(parameters ?? {})).toEqual([
      "additionalProperties",
      "description",
      "properties",
      "required",
      "type",
    ]);
    expect(
      Object.keys((parameters?.properties as Record<string, unknown>) ?? {}),
    ).toEqual(["alpha", "zeta"]);
    expect(
      Object.keys(
        ((
          (parameters?.properties as Record<string, unknown>)?.alpha as Record<
            string,
            unknown
          >
        )?.properties as Record<string, unknown>) ?? {},
      ),
    ).toEqual(["alpha", "beta"]);
    const zetaProperty = (
      (parameters?.properties ?? {}) as Record<string, unknown>
    ).zeta as Record<string, unknown> | undefined;
    expect(zetaProperty?.format).toBeUndefined();
  });

  it("propagates oauth auth failure when refresh returns null", async () => {
    createMock.mockRejectedValueOnce(new Error("401 unauthorized"));

    const authManager = makeAuthManager({
      forceRefreshModelAuth: vi.fn().mockResolvedValue(null),
    });

    const provider = new CodexProvider(authManager as never);
    await expect(
      provider.complete({
        model: "gpt-5.2-codex",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 64,
      }),
    ).rejects.toThrow(/401 unauthorized/i);
    expect(authManager.forceRefreshModelAuth).toHaveBeenCalledWith("oauth", {
      oauthAccountPoolId: undefined,
    });
  });

  it("does not retry api-key auth failures", async () => {
    createMock.mockRejectedValueOnce(new Error("401 unauthorized"));

    const authManager = makeAuthManager({
      resolveModelAuth: vi.fn().mockResolvedValue({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      forceRefreshModelAuth: vi.fn(),
    });

    const provider = new CodexProvider(authManager as never);
    await expect(
      provider.complete({
        model: "gpt-5.4",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 64,
      }),
    ).rejects.toThrow(/401 unauthorized/i);
    expect(authManager.forceRefreshModelAuth).not.toHaveBeenCalled();
  });
});

describe("CodexProvider.stream", () => {
  beforeEach(() => {
    createMock.mockReset();
    openAiConstructorMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits tool call lifecycle events and final content blocks", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            call_id: "call_123",
            name: "demo_tool",
          },
        };
        yield {
          type: "response.function_call_arguments.delta",
          call_id: "call_123",
          delta: '{"foo":',
        };
        yield {
          type: "response.function_call_arguments.delta",
          call_id: "call_123",
          delta: '"bar"}',
        };
        yield {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call_123",
            name: "demo_tool",
            arguments: '{"foo":"bar"}',
          },
        };
        yield {
          type: "response.done",
          response: {
            id: "resp_tool",
            usage: {
              input_tokens: 11,
              output_tokens: 4,
            },
          },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    const events = [] as Array<Record<string, unknown>>;
    for await (const event of provider.stream({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    })) {
      events.push(event as Record<string, unknown>);
    }

    expect(events).toEqual([
      {
        type: "tool_start",
        toolCallId: "call_123",
        toolName: "demo_tool",
      },
      {
        type: "tool_input_delta",
        toolCallId: "call_123",
        partialJson: '{"foo":',
      },
      {
        type: "tool_input_delta",
        toolCallId: "call_123",
        partialJson: '"bar"}',
      },
      {
        type: "tool_done",
        toolCallId: "call_123",
        toolName: "demo_tool",
        input: { foo: "bar" },
      },
      {
        type: "usage",
        inputTokens: 11,
        outputTokens: 4,
        cacheReadTokens: undefined,
        cacheCreationTokens: undefined,
        providerResponseId: "resp_tool",
      },
      {
        type: "content_blocks",
        blocks: [
          {
            type: "tool_use",
            id: "call_123",
            name: "demo_tool",
            input: { foo: "bar" },
          },
        ],
      },
      { type: "done" },
    ]);
  });

  it("emits thinking and refusal deltas and final text/thinking blocks", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield { type: "response.reasoning.delta", delta: "plan" };
        yield { type: "response.refusal.delta", delta: " cannot do that" };
        yield { type: "response.output_text.delta", delta: "final" };
        yield {
          type: "response.done",
          response: {
            id: "resp_reasoning",
            usage: {
              input_tokens: 8,
              output_tokens: 3,
            },
          },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    const events = [] as Array<Record<string, unknown>>;
    for await (const event of provider.stream({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    })) {
      events.push(event as Record<string, unknown>);
    }

    const thinkingStart = events.find(
      (event) => event.type === "thinking_start",
    );
    expect(thinkingStart).toBeDefined();
    expect(events).toEqual([
      {
        type: "thinking_start",
        thinkingId: thinkingStart?.thinkingId,
      },
      {
        type: "thinking_delta",
        thinkingId: thinkingStart?.thinkingId,
        text: "plan",
      },
      {
        type: "text_delta",
        text: "[Refusal]  cannot do that",
      },
      {
        type: "text_delta",
        text: "final",
      },
      {
        type: "thinking_end",
        thinkingId: thinkingStart?.thinkingId,
      },
      {
        type: "usage",
        inputTokens: 8,
        outputTokens: 3,
        cacheReadTokens: undefined,
        cacheCreationTokens: undefined,
        providerResponseId: "resp_reasoning",
      },
      {
        type: "content_blocks",
        blocks: [
          {
            type: "thinking",
            thinking: "plan",
            signature: "",
          },
          {
            type: "text",
            text: "[Refusal]  cannot do thatfinal",
          },
        ],
      },
      { type: "done" },
    ]);
  });

  it("emits plain text-only streams in order", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield { type: "response.text.delta", delta: "hello" };
        yield { type: "response.output_text.delta", delta: " world" };
        yield {
          type: "response.completed",
          response: {
            id: "resp_text",
            usage: {
              input_tokens: 6,
              output_tokens: 2,
            },
          },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    const events = [] as Array<Record<string, unknown>>;
    for await (const event of provider.stream({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    })) {
      events.push(event as Record<string, unknown>);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "text_delta", text: " world" },
      {
        type: "usage",
        inputTokens: 6,
        outputTokens: 2,
        cacheReadTokens: undefined,
        cacheCreationTokens: undefined,
        providerResponseId: "resp_text",
      },
      {
        type: "content_blocks",
        blocks: [{ type: "text", text: "hello world" }],
      },
      { type: "done" },
    ]);
  });

  it("propagates response.error events as stream errors", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield {
          type: "response.error",
          error: { message: "boom" },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    await expect(
      (async () => {
        for await (const _event of provider.stream({
          model: "gpt-5.2-codex",
          systemPrompt: "system",
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 64,
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow(/Codex API error: boom/);
  });

  it("marks context-window overflow as a condense-action retryable error", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield {
          type: "response.error",
          error: {
            message:
              "Your input exceeds the context window of this model. Please adjust your input and try again.",
          },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    await expect(
      (async () => {
        for await (const _event of provider.stream({
          model: "gpt-5.2-codex",
          systemPrompt: "system",
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 64,
        })) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({
      code: "context_window_exceeded",
      retryable: true,
      actions: { condense: true },
    });
  });

  it("propagates response.failed events as request failures", async () => {
    createMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield {
          type: "response.failed",
          error: { message: "request blew up" },
        };
      })();
    });

    const provider = new CodexProvider(makeAuthManager() as never);
    await expect(
      (async () => {
        for await (const _event of provider.stream({
          model: "gpt-5.2-codex",
          systemPrompt: "system",
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 64,
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow(/Codex request failed: request blew up/);
  });
});
