import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexProvider } from "./CodexProvider.js";

function makeSseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses streaming mode and omits unsupported temperature", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestUrl = "";
    let requestHeaders: HeadersInit | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      requestUrl = url;
      requestHeaders = init?.headers;
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return makeSseResponse([
        { type: "response.output_text.delta", delta: "hello" },
        {
          type: "response.done",
          response: {
            usage: {
              input_tokens: 12,
              output_tokens: 3,
            },
          },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const authManager = makeAuthManager();

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "Summarize this" }],
      maxTokens: 128,
      temperature: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(requestBody).toMatchObject({
      model: "gpt-5.2-codex",
      instructions: "system",
      stream: true,
      store: false,
    });
    expect(requestBody).not.toHaveProperty("temperature");
    expect(requestHeaders).toMatchObject({
      Authorization: "Bearer token",
      originator: "agentlink",
      session_id: expect.any(String),
      "ChatGPT-Account-Id": "acct",
    });
    expect(result).toEqual({
      text: "hello",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it("retries once on oauth auth failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: "401 unauthorized" },
          }),
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        makeSseResponse([
          { type: "response.output_text.delta", delta: "ok" },
          {
            type: "response.done",
            response: {
              usage: {
                input_tokens: 5,
                output_tokens: 1,
              },
            },
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const authManager = makeAuthManager();

    const provider = new CodexProvider(authManager as never);
    const result = await provider.complete({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    expect(authManager.forceRefreshModelAuth).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("ok");
  });

  it("uses the OpenAI Responses endpoint for API-key auth", async () => {
    let requestUrl = "";
    let requestHeaders: HeadersInit | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      requestUrl = url;
      requestHeaders = init?.headers;
      return makeSseResponse([
        { type: "response.output_text.delta", delta: "api" },
        {
          type: "response.done",
          response: {
            usage: {
              input_tokens: 7,
              output_tokens: 2,
            },
          },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

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

    expect(requestUrl).toBe("https://api.openai.com/v1/responses");
    expect(requestHeaders).toMatchObject({
      Authorization: "Bearer sk-test",
    });
    expect(
      (requestHeaders as Record<string, string>).originator,
    ).toBeUndefined();
    expect(result.text).toBe("api");
  });

  it("throws when oauth refresh returns null", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "401 unauthorized" },
        }),
        { status: 401 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

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
    ).rejects.toThrow(/OpenAI\/Codex authentication is required/i);
    expect(authManager.forceRefreshModelAuth).toHaveBeenCalledWith("oauth");
  });

  it("does not retry api-key auth failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "401 unauthorized" },
        }),
        { status: 401 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authManager.forceRefreshModelAuth).not.toHaveBeenCalled();
  });
});
