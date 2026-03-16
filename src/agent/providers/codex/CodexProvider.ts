/**
 * CodexProvider — implements ModelProvider for the OpenAI/Codex Responses API.
 *
 * Supports two auth paths behind one provider surface:
 * - OAuth (ChatGPT/Codex subscription) via `chatgpt.com/backend-api/codex/responses`
 * - OpenAI API key via `api.openai.com/v1/responses`
 *
 * Uses raw `fetch()` + SSE parsing rather than adding an OpenAI SDK dependency.
 */

import * as os from "os";
import * as crypto from "crypto";
import { randomUUID } from "crypto";
import type {
  ModelProvider,
  StreamRequest,
  CompleteRequest,
  CompleteResult,
  ProviderStreamEvent,
  ModelCapabilities,
  ModelInfo,
  ContentBlock,
  MessageParam,
  ToolDefinition,
  ThinkingBlock,
} from "../types.js";
import {
  openAiCodexAuthManager,
  type OpenAiCodexAuthManager,
  type OpenAiCodexResolvedAuth,
} from "./OpenAiCodexAuthManager.js";

// ── Constants ──

const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_CALL_ID_MAX_LENGTH = 64;

/** The preferred cheap/fast model for condensing on Codex. */
export const CODEX_CONDENSE_MODEL = "gpt-5.1-codex-mini";

/** Ordered fallback chain for condensing when account entitlements vary. */
export const CODEX_CONDENSE_MODEL_FALLBACKS = [
  CODEX_CONDENSE_MODEL,
  "gpt-5.2-codex",
  "gpt-5.3-codex",
] as const;

// ── Model definitions ──

interface CodexModelDef {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  supportsThinking: boolean;
  defaultReasoningEffort: string;
}

const CODEX_MODELS: CodexModelDef[] = [
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.2",
    displayName: "GPT-5.2",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.1-codex-mini",
    displayName: "GPT-5.1 Codex Mini",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsImages: false,
    supportsThinking: true,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.1-codex-max",
    displayName: "GPT-5.1 Codex Max",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsThinking: true,
    defaultReasoningEffort: "xhigh",
  },
];

const CODEX_MODEL_MAP = new Map(CODEX_MODELS.map((m) => [m.id, m]));

// ── Tool call ID sanitization ──

/**
 * Sanitize and truncate a tool call ID for OpenAI's Responses API.
 * IDs must be ≤64 chars and match `^[a-zA-Z0-9_-]+$`.
 */
function sanitizeCallId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (sanitized.length <= OPENAI_CALL_ID_MAX_LENGTH) return sanitized;

  // Use 8-char hash suffix for uniqueness
  const hash = crypto.createHash("md5").update(id).digest("hex").slice(0, 8);
  const prefix = sanitized.slice(
    0,
    OPENAI_CALL_ID_MAX_LENGTH - 1 - 8, // 1 for separator
  );
  return `${prefix}_${hash}`;
}

// ── Message translation ──

type CodexInputItem =
  | { role: "user"; content: Array<Record<string, unknown>> }
  | { role: "assistant"; content: Array<Record<string, unknown>> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/**
 * Translate our provider-agnostic messages into Codex Responses API `input[]`.
 * Tool calls and results become top-level items (not nested in messages).
 * ThinkingBlocks are stripped — Codex uses its own reasoning system.
 */
function translateMessages(messages: MessageParam[]): CodexInputItem[] {
  const input: CodexInputItem[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      if (msg.role === "user") {
        input.push({
          role: "user",
          content: [{ type: "input_text", text: msg.content }],
        });
      } else {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text: msg.content }],
        });
      }
      continue;
    }

    // Array content — split into message content vs tool items
    const userContent: Array<Record<string, unknown>> = [];
    const assistantContent: Array<Record<string, unknown>> = [];
    const toolResults: CodexInputItem[] = [];
    const toolCalls: CodexInputItem[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          if (msg.role === "user") {
            userContent.push({ type: "input_text", text: block.text });
          } else {
            assistantContent.push({ type: "output_text", text: block.text });
          }
          break;

        case "image":
          if (msg.role === "user") {
            const src = block.source;
            userContent.push({
              type: "input_image",
              image_url: `data:${src.media_type};base64,${src.data}`,
            });
          }
          break;

        case "document":
          if (msg.role === "user") {
            const src = block.source;
            userContent.push({
              type: "input_file",
              filename: block.title ?? "document.pdf",
              file_data: `data:${src.media_type};base64,${src.data}`,
            });
          }
          break;

        case "tool_use":
          toolCalls.push({
            type: "function_call",
            call_id: sanitizeCallId(block.id),
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
          break;

        case "tool_result": {
          const output =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter(
                      (b): b is { type: "text"; text: string } =>
                        b.type === "text",
                    )
                    .map((b) => b.text)
                    .join("")
                : "";
          toolResults.push({
            type: "function_call_output",
            call_id: sanitizeCallId(block.tool_use_id),
            output,
          });
          break;
        }

        case "thinking":
          // Strip thinking blocks — Codex doesn't accept Anthropic thinking signatures
          break;
      }
    }

    // Emit message content first, then tool items (order matters for Codex)
    if (msg.role === "user" && userContent.length > 0) {
      input.push({ role: "user", content: userContent });
    }
    if (msg.role === "assistant" && assistantContent.length > 0) {
      input.push({ role: "assistant", content: assistantContent });
    }
    // Tool calls come from assistant messages
    input.push(...toolCalls);
    // Tool results come from user messages
    input.push(...toolResults);
  }

  return input;
}

/**
 * Translate our ToolDefinition[] into Codex Responses API tools.
 * Uses non-strict mode to support free-form object schemas (e.g. MCP tools).
 */
function translateTools(tools: ToolDefinition[]): Array<{
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}> {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: sanitizeSchemaForCodex(
      t.input_schema as Record<string, unknown>,
    ),
    strict: false,
  }));
}

/**
 * Recursively strip JSON Schema annotations unsupported by the Codex API
 * (e.g. `format: "uri"`). Does not enforce strict-mode constraints so that
 * free-form object schemas (MCP tools, open-ended params) remain valid.
 */
function sanitizeSchemaForCodex(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return schema;

  // Strip unsupported format annotations at every level
  const { format: _format, ...result } = schema;

  if (result.properties && typeof result.properties === "object") {
    const newProps: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(
      result.properties as Record<string, Record<string, unknown>>,
    )) {
      newProps[key] = sanitizeSchemaForCodex(prop);
    }
    result.properties = newProps;
  }

  if (result.items && typeof result.items === "object") {
    result.items = sanitizeSchemaForCodex(
      result.items as Record<string, unknown>,
    );
  }

  return result;
}

// ── SSE parsing ──

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // Skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Provider ──

export class CodexProvider implements ModelProvider {
  readonly id = "codex";
  readonly displayName = "OpenAI Codex";
  readonly condenseModel = CODEX_CONDENSE_MODEL;

  private authManager: OpenAiCodexAuthManager;
  private sessionId: string;
  private log: (msg: string) => void;

  constructor(
    authManager?: OpenAiCodexAuthManager,
    log?: (msg: string) => void,
  ) {
    this.authManager = authManager ?? openAiCodexAuthManager;
    this.sessionId = randomUUID();
    this.log = log ?? (() => {});
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authManager.isAuthenticated();
  }

  getCapabilities(model: string): ModelCapabilities {
    const def = CODEX_MODEL_MAP.get(model);
    return {
      supportsThinking: def?.supportsThinking ?? true,
      supportsCaching: true, // Server-side automatic caching
      supportsImages: def?.supportsImages ?? true,
      supportsToolUse: true,
      contextWindow: def?.contextWindow ?? 400_000,
      maxOutputTokens: def?.maxOutputTokens ?? 128_000,
    };
  }

  listModels(): ModelInfo[] {
    return CODEX_MODELS.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      provider: this.id,
      capabilities: this.getCapabilities(m.id),
    }));
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderStreamEvent> {
    const {
      model,
      systemPrompt,
      messages,
      tools,
      maxTokens: _maxTokens,
      thinking,
      signal,
    } = request;

    const codexInput = translateMessages(messages);
    const codexTools = tools ? translateTools(tools) : undefined;

    const modelDef = CODEX_MODEL_MAP.get(model);
    const reasoningEffort = thinking
      ? "high"
      : (modelDef?.defaultReasoningEffort ?? "medium");

    const requestBody: Record<string, unknown> = {
      model,
      input: codexInput,
      instructions: systemPrompt,
      stream: true,
      store: false,
      reasoning: {
        effort: reasoningEffort,
        summary: "detailed",
      },
      ...(codexTools && codexTools.length > 0 ? { tools: codexTools } : {}),
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const auth =
        attempt === 0
          ? await this.getModelAuthOrThrow()
          : await this.authManager.forceRefreshModelAuth("oauth");
      if (!auth) {
        throw new Error(
          "OpenAI/Codex authentication is required. Sign in with ChatGPT/Codex or configure an OpenAI API key to use models, semantic search, and indexing.",
        );
      }

      try {
        yield* this.executeStream(requestBody, auth, model, signal);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isAuth = /unauthorized|invalid token|401|authentication/i.test(
          msg,
        );
        if (attempt === 0 && isAuth && auth.canRefresh) {
          this.log("[codex] Auth failure, attempting token refresh...");
          continue;
        }
        throw err;
      }
    }

    throw new Error("Codex stream() failed unexpectedly");
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const {
      model,
      systemPrompt,
      messages,
      maxTokens: _maxTokens,
      temperature: _temperature,
    } = request;
    const codexInput = translateMessages(messages);

    const requestBody: Record<string, unknown> = {
      model,
      input: codexInput,
      instructions: systemPrompt,
      stream: true,
      store: false,
    };

    // Keep complete() intentionally minimal. The OAuth-backed Codex endpoint
    // requires SSE even for non-interactive calls, and we aggregate the stream.
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth =
        attempt === 0
          ? await this.getModelAuthOrThrow()
          : await this.authManager.forceRefreshModelAuth("oauth");
      if (!auth) {
        throw new Error(
          "OpenAI/Codex authentication is required. Sign in with ChatGPT/Codex or configure an OpenAI API key to use models, semantic search, and indexing.",
        );
      }

      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;

      try {
        for await (const event of this.executeStream(
          requestBody,
          auth,
          model,
        )) {
          if (event.type === "text_delta") {
            text += event.text;
          } else if (event.type === "usage") {
            inputTokens = event.inputTokens;
            outputTokens = event.outputTokens;
          }
        }

        return {
          text,
          usage: { inputTokens, outputTokens },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isAuth = /unauthorized|invalid token|401|authentication/i.test(
          msg,
        );
        if (attempt === 0 && isAuth && auth.canRefresh) {
          this.log(
            "[codex] complete() auth failure, attempting token refresh...",
          );
          continue;
        }
        throw err;
      }
    }

    throw new Error("Codex complete() failed unexpectedly");
  }

  // ── Internal ──

  private async getModelAuthOrThrow(): Promise<OpenAiCodexResolvedAuth> {
    const auth = await this.authManager.resolveModelAuth();
    if (!auth) {
      throw new Error(
        "OpenAI/Codex authentication is required. Sign in with ChatGPT/Codex or configure an OpenAI API key to use models, semantic search, and indexing.",
      );
    }
    return auth;
  }

  private async makeRequest(
    body: Record<string, unknown>,
    auth: OpenAiCodexResolvedAuth,
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.bearerToken}`,
      "User-Agent": `agentlink/1.0 (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
    };

    let url = `${OPENAI_API_BASE_URL}/responses`;
    if (auth.method === "oauth") {
      url = `${CODEX_API_BASE_URL}/responses`;
      headers.originator = "agentlink";
      headers.session_id = this.sessionId;
      if (auth.accountId) {
        headers["ChatGPT-Account-Id"] = auth.accountId;
      }
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let detail = "";
      try {
        const errorJson = JSON.parse(errorText) as Record<string, unknown>;
        const errObj = errorJson.error as Record<string, unknown> | undefined;
        detail =
          (errObj?.message as string) ??
          (errorJson.message as string) ??
          (errorJson.detail as string) ??
          errorText;
      } catch {
        detail = errorText;
      }
      throw new Error(`Codex API error ${response.status}: ${detail}`);
    }

    if (stream && !response.body) {
      throw new Error(
        "Codex API returned no response body for streaming request",
      );
    }

    return response;
  }

  private async *executeStream(
    requestBody: Record<string, unknown>,
    auth: OpenAiCodexResolvedAuth,
    model: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderStreamEvent> {
    const response = await this.makeRequest(requestBody, auth, true, signal);

    // Accumulators for content blocks
    const contentBlocks: ContentBlock[] = [];
    let currentText = "";
    let currentThinking = "";
    let thinkingId: string | null = null;

    // Track tool calls being assembled
    const pendingToolCalls = new Map<
      string,
      { name: string; arguments: string }
    >();

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    for await (const event of parseSSE(response.body!, signal)) {
      const eventType = event.type as string | undefined;
      if (!eventType) continue;

      // ── Text deltas ──
      if (
        eventType === "response.output_text.delta" ||
        eventType === "response.text.delta"
      ) {
        const delta = event.delta as string | undefined;
        if (delta) {
          currentText += delta;
          yield { type: "text_delta", text: delta };
        }
        continue;
      }

      // ── Reasoning / thinking deltas ──
      if (
        eventType === "response.reasoning_summary.delta" ||
        eventType === "response.reasoning_summary_text.delta" ||
        eventType === "response.reasoning.delta" ||
        eventType === "response.reasoning_text.delta"
      ) {
        const delta = event.delta as string | undefined;
        if (delta) {
          if (!thinkingId) {
            thinkingId = randomUUID();
            yield { type: "thinking_start", thinkingId };
          }
          currentThinking += delta;
          yield { type: "thinking_delta", thinkingId, text: delta };
        }
        continue;
      }

      // ── Refusal ──
      if (eventType === "response.refusal.delta") {
        const delta = event.delta as string | undefined;
        if (delta) {
          const refusalText = `[Refusal] ${delta}`;
          currentText += refusalText;
          yield { type: "text_delta", text: refusalText };
        }
        continue;
      }

      // ── Tool call argument deltas ──
      if (
        eventType === "response.function_call_arguments.delta" ||
        eventType === "response.tool_call_arguments.delta"
      ) {
        const callId = (event.call_id ?? event.tool_call_id ?? event.id) as
          | string
          | undefined;
        const delta = (event.delta ?? event.arguments) as string | undefined;
        if (callId && delta) {
          const pending = pendingToolCalls.get(callId);
          if (pending) {
            pending.arguments += delta;
            yield {
              type: "tool_input_delta",
              toolCallId: callId,
              partialJson: delta,
            };
          }
        }
        continue;
      }

      // ── Output item added — track tool call identity ──
      if (eventType === "response.output_item.added") {
        const item = event.item as Record<string, unknown> | undefined;
        if (
          item &&
          (item.type === "function_call" || item.type === "tool_call")
        ) {
          const callId = (item.call_id ??
            item.tool_call_id ??
            item.id) as string;
          const name = (item.name ??
            (item.function as Record<string, unknown> | undefined)
              ?.name) as string;
          if (callId && name) {
            pendingToolCalls.set(callId, { name, arguments: "" });
            yield { type: "tool_start", toolCallId: callId, toolName: name };
          }
        }
        continue;
      }

      // ── Output item done — finalize tool call ──
      if (eventType === "response.output_item.done") {
        const item = event.item as Record<string, unknown> | undefined;
        if (
          item &&
          (item.type === "function_call" || item.type === "tool_call")
        ) {
          const callId = (item.call_id ??
            item.tool_call_id ??
            item.id) as string;
          const name = (item.name ??
            (item.function as Record<string, unknown> | undefined)
              ?.name) as string;
          const argsRaw = item.arguments ?? item.input;
          const argsStr =
            typeof argsRaw === "string"
              ? argsRaw
              : argsRaw && typeof argsRaw === "object"
                ? JSON.stringify(argsRaw)
                : "";

          // Use accumulated args from deltas if available, fall back to done-event args
          const pending = pendingToolCalls.get(callId);
          const finalArgs = pending?.arguments || argsStr;
          const finalName = pending?.name ?? name;

          if (callId && finalName) {
            let parsed: unknown;
            try {
              parsed = finalArgs ? JSON.parse(finalArgs) : {};
            } catch {
              parsed = {};
            }

            contentBlocks.push({
              type: "tool_use",
              id: callId,
              name: finalName,
              input: parsed as Record<string, unknown>,
            });

            yield {
              type: "tool_done",
              toolCallId: callId,
              toolName: finalName,
              input: parsed,
            };
            pendingToolCalls.delete(callId);
          }
        }
        continue;
      }

      // ── Error events ──
      if (eventType === "response.error" || eventType === "error") {
        const errObj = event.error as Record<string, unknown> | undefined;
        const msg =
          (errObj?.message as string) ??
          (event.message as string) ??
          "Unknown Codex API error";
        throw new Error(`Codex API error: ${msg}`);
      }
      if (eventType === "response.failed") {
        const errObj = event.error as Record<string, unknown> | undefined;
        const msg =
          (errObj?.message as string) ??
          (event.message as string) ??
          "Request failed";
        throw new Error(`Codex request failed: ${msg}`);
      }

      // ── Response done — extract usage and finalize ──
      if (eventType === "response.done" || eventType === "response.completed") {
        const resp = event.response as Record<string, unknown> | undefined;
        const usage = (resp?.usage ?? event.usage) as
          | Record<string, unknown>
          | undefined;
        if (usage) {
          inputTokens =
            (usage.input_tokens as number) ??
            (usage.prompt_tokens as number) ??
            0;
          outputTokens =
            (usage.output_tokens as number) ??
            (usage.completion_tokens as number) ??
            0;

          const inputDetails = usage.input_tokens_details as
            | Record<string, unknown>
            | undefined;
          cacheReadTokens =
            (inputDetails?.cached_tokens as number) ??
            (usage.cache_read_input_tokens as number) ??
            0;
        }

        // Extract any text from done response that wasn't streamed
        if (!currentText && Array.isArray(resp?.output)) {
          for (const item of resp.output as Array<Record<string, unknown>>) {
            if (item.type === "message" && Array.isArray(item.content)) {
              for (const c of item.content as Array<Record<string, unknown>>) {
                if (c.type === "output_text" && typeof c.text === "string") {
                  currentText += c.text;
                  yield { type: "text_delta", text: c.text as string };
                }
              }
            }
            // Extract reasoning summaries from done event — only if not already streamed via deltas
            if (
              item.type === "reasoning" &&
              Array.isArray(item.summary) &&
              !currentThinking
            ) {
              for (const s of item.summary as Array<Record<string, unknown>>) {
                if (s?.type === "summary_text" && typeof s.text === "string") {
                  if (!thinkingId) {
                    thinkingId = randomUUID();
                    yield { type: "thinking_start", thinkingId };
                  }
                  currentThinking += s.text;
                  yield {
                    type: "thinking_delta",
                    thinkingId,
                    text: s.text as string,
                  };
                }
              }
            }
          }
        }
        // Don't break — there might be more events in the stream
        continue;
      }
    }

    // ── Finalize ──

    // Close thinking block if open
    if (thinkingId) {
      yield { type: "thinking_end", thinkingId };
      contentBlocks.unshift({
        type: "thinking",
        thinking: currentThinking,
        signature: "", // Codex doesn't use signatures
      } satisfies ThinkingBlock);
    }

    // Add text block if any text was accumulated
    if (currentText) {
      contentBlocks.push({ type: "text", text: currentText });
    }

    yield {
      type: "usage",
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheReadTokens || undefined,
    };
    yield { type: "content_blocks", blocks: contentBlocks };
    yield { type: "done" };
  }
}
