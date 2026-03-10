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

describe("CodexProvider.complete", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses streaming mode and omits unsupported temperature", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
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

    const oauthManager = {
      getAccessToken: vi.fn().mockResolvedValue("token"),
      forceRefreshAccessToken: vi.fn().mockResolvedValue("refreshed-token"),
      getAccountId: vi.fn().mockResolvedValue("acct"),
      isAuthenticated: vi.fn().mockResolvedValue(true),
    };

    const provider = new CodexProvider(oauthManager as never);
    const result = await provider.complete({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "Summarize this" }],
      maxTokens: 128,
      temperature: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody).toMatchObject({
      model: "gpt-5.2-codex",
      instructions: "system",
      stream: true,
      store: false,
    });
    expect(requestBody).not.toHaveProperty("temperature");
    expect(result).toEqual({
      text: "hello",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it("retries once on auth failure", async () => {
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

    const oauthManager = {
      getAccessToken: vi.fn().mockResolvedValue("token"),
      forceRefreshAccessToken: vi.fn().mockResolvedValue("refreshed-token"),
      getAccountId: vi.fn().mockResolvedValue("acct"),
      isAuthenticated: vi.fn().mockResolvedValue(true),
    };

    const provider = new CodexProvider(oauthManager as never);
    const result = await provider.complete({
      model: "gpt-5.2-codex",
      systemPrompt: "system",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 64,
    });

    expect(oauthManager.forceRefreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("ok");
  });
});
