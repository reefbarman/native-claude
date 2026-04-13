/**
 * CodexProvider — implements ModelProvider for the OpenAI/Codex Responses API.
 *
 * Supports two auth paths behind one provider surface:
 * - OAuth (ChatGPT/Codex subscription) via `chatgpt.com/backend-api/codex/responses`
 * - OpenAI API key via `api.openai.com/v1/responses`
 *
 * Uses the OpenAI SDK Responses API with endpoint-specific configuration for
 * OAuth-backed Codex and API-key-backed OpenAI requests.
 */

import * as crypto from "crypto";
import { randomUUID } from "crypto";

import OpenAI, { APIError } from "openai";
import type * as OpenAIResponses from "openai/resources/responses/responses";
import type { Reasoning } from "openai/resources/shared";
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
import {
  CODEX_CONDENSE_MODEL,
  CODEX_MODEL_MAP,
  getCodexModelCapabilities,
  getEndpointCaps,
  listCodexModels,
} from "./models.js";
import {
  createOpenAiResponsesClient,
  getCodexEndpointConfig,
} from "./openaiClient.js";

// ── Constants ──

const OPENAI_CALL_ID_MAX_LENGTH = 64;

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

type CodexRequestBody = OpenAIResponses.ResponseCreateParamsStreaming;
type CodexInputItem = OpenAIResponses.ResponseInputItem;
type UserInputContent = OpenAIResponses.ResponseInputMessageContentList[number];
type PromptCacheRetention = "24h" | "in-memory";

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
        } as CodexInputItem);
      } else {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text: msg.content }],
        } as CodexInputItem);
      }
      continue;
    }

    // Array content — split into message content vs tool items
    const userContent: UserInputContent[] = [];
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
              detail: "auto",
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
      input.push({
        role: "assistant",
        content: assistantContent,
      } as unknown as CodexInputItem);
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
function translateTools(tools: ToolDefinition[]): OpenAIResponses.Tool[] {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: sanitizeSchemaForCodex(
      t.input_schema as Record<string, unknown>,
    ),
    strict: false,
  })) as OpenAIResponses.Tool[];
}

function buildReasoning(effort: string): Reasoning {
  return {
    effort: effort as Reasoning["effort"],
    summary: "detailed",
  };
}

function buildStreamRequestBody(args: {
  model: string;
  input: CodexInputItem[];
  instructions: string;
  store: boolean;
  maxTokens?: number;
  reasoning?: Reasoning;
  previousResponseId?: string;
  tools?: OpenAIResponses.Tool[];
  promptCacheKey?: string;
  promptCacheRetention?: PromptCacheRetention;
}): CodexRequestBody {
  return {
    model: args.model,
    input: args.input,
    instructions: args.instructions,
    stream: true,
    store: args.store,
    ...(typeof args.maxTokens === "number"
      ? ({ max_output_tokens: args.maxTokens } as Record<string, unknown>)
      : {}),
    ...(args.reasoning ? { reasoning: args.reasoning } : {}),
    ...(args.previousResponseId
      ? { previous_response_id: args.previousResponseId }
      : {}),
    ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
    ...(args.promptCacheKey ? { prompt_cache_key: args.promptCacheKey } : {}),
    ...(args.promptCacheRetention
      ? { prompt_cache_retention: args.promptCacheRetention }
      : {}),
  } as CodexRequestBody;
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortObjectKeys(child)]),
  );
}

/**
 * Recursively strip JSON Schema annotations unsupported by the Codex API
 * (e.g. `format: "uri"`) and canonicalize object key ordering so equivalent
 * schemas serialize identically across requests.
 * Does not enforce strict-mode constraints so that free-form object schemas
 * (MCP tools, open-ended params) remain valid.
 */
function sanitizeSchemaForCodex(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return schema;

  const entries = Object.entries(schema)
    .filter(([key]) => key !== "format")
    .sort(([a], [b]) => a.localeCompare(b));

  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (key === "properties" && value && typeof value === "object") {
        const sanitizedProps = Object.fromEntries(
          Object.entries(value as Record<string, Record<string, unknown>>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([propKey, propValue]) => [
              propKey,
              sanitizeSchemaForCodex(propValue),
            ]),
        );
        return [key, sanitizedProps];
      }

      if (key === "items") {
        if (Array.isArray(value)) {
          return [
            key,
            value.map((item) =>
              item && typeof item === "object"
                ? sanitizeSchemaForCodex(item as Record<string, unknown>)
                : item,
            ),
          ];
        }
        if (value && typeof value === "object") {
          return [
            key,
            sanitizeSchemaForCodex(value as Record<string, unknown>),
          ];
        }
      }

      return [key, sortObjectKeys(value)];
    }),
  ) as Record<string, unknown>;
}

// ── Provider ──

interface CodexSdkError extends Error {
  status?: number;
  rawMessage?: string;
  rawCode?: string;
  body?: unknown;
  code?: string;
  retryable?: boolean;
  actions?: {
    signIn?: boolean;
    signInAnotherAccount?: boolean;
    condense?: boolean;
  };
  metadata?: Record<string, unknown>;
}

class CodexRequestError extends Error implements CodexSdkError {
  readonly status?: number;
  readonly rawMessage?: string;
  readonly rawCode?: string;
  readonly body?: unknown;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly actions?: {
    signIn?: boolean;
    signInAnotherAccount?: boolean;
    condense?: boolean;
  };
  readonly metadata?: Record<string, unknown>;

  constructor(
    message: string,
    options?: {
      status?: number;
      rawMessage?: string;
      rawCode?: string;
      body?: unknown;
      code?: string;
      retryable?: boolean;
      actions?: {
        signIn?: boolean;
        signInAnotherAccount?: boolean;
        condense?: boolean;
      };
      metadata?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "CodexRequestError";
    this.status = options?.status;
    this.rawMessage = options?.rawMessage;
    this.rawCode = options?.rawCode;
    this.body = options?.body;
    this.code = options?.code;
    this.retryable = options?.retryable;
    this.actions = options?.actions;
    this.metadata = options?.metadata;
  }
}

function isAuthError(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 401) {
      return true;
    }
  }

  const msg = error instanceof Error ? error.message : String(error);
  return /unauthorized|invalid token|401|authentication/i.test(msg);
}

function extractErrorText(error: CodexSdkError): string {
  return [error.rawMessage, error.message]
    .filter((v): v is string => !!v)
    .join(" ")
    .toLowerCase();
}

function isUsageLimit429(error: CodexSdkError): boolean {
  if (error.status !== 429) return false;

  const text = extractErrorText(error);
  if (text.includes("usage limit has been reached")) {
    return true;
  }

  if (error.rawCode && /usage.*limit|insufficient_quota/i.test(error.rawCode)) {
    return true;
  }

  if (error.body && typeof error.body === "object") {
    const bodyText = JSON.stringify(error.body).toLowerCase();
    if (
      bodyText.includes("usage limit") ||
      bodyText.includes("insufficient_quota")
    ) {
      return true;
    }
  }

  return false;
}

function isContextWindowExceeded(error: CodexSdkError): boolean {
  const text = extractErrorText(error);
  if (
    text.includes("exceeds the context window") ||
    text.includes("exceeded the context window") ||
    text.includes("context length exceeded") ||
    text.includes("maximum context length")
  ) {
    return true;
  }

  if (
    error.rawCode &&
    /context_length_exceeded|context_window_exceeded/i.test(error.rawCode)
  ) {
    return true;
  }

  if (error.body && typeof error.body === "object") {
    const bodyText = JSON.stringify(error.body).toLowerCase();
    if (
      bodyText.includes("context window") ||
      bodyText.includes("context length exceeded")
    ) {
      return true;
    }
  }

  return false;
}

function toCodexSdkError(error: unknown): CodexSdkError {
  if (error instanceof CodexRequestError) {
    return error;
  }
  if (error instanceof APIError) {
    const status = error.status;
    const message = error.message || "Unknown OpenAI error";
    const body = (error as unknown as { error?: unknown; body?: unknown })
      .error;
    const rawCode =
      (error as unknown as { code?: string }).code ??
      ((body as Record<string, unknown> | undefined)?.code as
        | string
        | undefined);

    return new CodexRequestError(
      `Codex API error ${status ?? "unknown"}: ${message}`,
      {
        status,
        rawMessage: message,
        rawCode,
        body,
      },
    );
  }
  if (error instanceof Error) {
    return error as CodexSdkError;
  }
  return new Error(String(error)) as CodexSdkError;
}

export class CodexProvider implements ModelProvider {
  readonly id = "codex";
  readonly displayName = "OpenAI Codex";
  readonly condenseModel = CODEX_CONDENSE_MODEL;

  private authManager: OpenAiCodexAuthManager;
  private sessionId: string;
  private log: (msg: string) => void;
  private clients = new Map<string, OpenAI>();

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
    return getCodexModelCapabilities(model);
  }

  listModels(): ModelInfo[] {
    return listCodexModels(this.id);
  }

  private async getModelAuthOrThrow(): Promise<OpenAiCodexResolvedAuth> {
    const auth = await this.authManager.resolveModelAuth();
    if (!auth) {
      throw new CodexRequestError(
        "OpenAI/Codex authentication is required. Sign in with ChatGPT/Codex or configure an OpenAI API key to use models, semantic search, and indexing.",
        {
          code: "auth_required",
          retryable: true,
          actions: { signIn: true },
        },
      );
    }
    return auth;
  }

  private getClient(auth: OpenAiCodexResolvedAuth): OpenAI {
    const endpoint = getCodexEndpointConfig(auth, this.sessionId);
    const tokenFingerprint = crypto
      .createHash("sha256")
      .update(auth.bearerToken)
      .digest("hex")
      .slice(0, 12);
    const key = `${auth.method}:${auth.accountId ?? ""}:${endpoint.baseURL}:${tokenFingerprint}`;

    const existing = this.clients.get(key);
    if (existing) return existing;

    const client = createOpenAiResponsesClient(auth, endpoint);
    this.clients.set(key, client);
    return client;
  }

  private buildRequestBody(params: {
    model: string;
    codexInput: CodexInputItem[];
    systemPrompt: string;
    maxTokens?: number;
    state?: { store?: boolean; previousResponseId?: string };
    cache?: { key?: string; retention?: "in_memory" | "24h" };
    reasoningEffort?: string;
    tools?: OpenAIResponses.Tool[];
    auth: OpenAiCodexResolvedAuth;
  }): CodexRequestBody {
    const caps = getEndpointCaps(params.auth);
    return buildStreamRequestBody({
      model: params.model,
      input: params.codexInput,
      instructions: params.systemPrompt,
      store: params.state?.store ?? false,
      maxTokens: caps.supportsMaxOutputTokens ? params.maxTokens : undefined,
      reasoning: params.reasoningEffort
        ? buildReasoning(params.reasoningEffort)
        : undefined,
      previousResponseId: caps.supportsPreviousResponseId
        ? params.state?.previousResponseId
        : undefined,
      tools: params.tools,
      promptCacheKey: caps.supportsPromptCacheKey
        ? params.cache?.key
        : undefined,
      promptCacheRetention:
        params.cache?.retention === "24h" && caps.supportsPromptCacheRetention
          ? "24h"
          : undefined,
    });
  }

  private async rotateOAuthAuth(
    attemptedOAuthAccountIds: Set<string>,
    currentAuth: OpenAiCodexResolvedAuth,
  ): Promise<OpenAiCodexResolvedAuth | null> {
    if (currentAuth.method !== "oauth") return null;
    const currentAccountId = currentAuth.oauthAccountPoolId;
    if (!currentAccountId) return null;

    const ordered =
      await this.authManager.getOAuthRoundRobinAccountIds(currentAccountId);
    for (const accountId of ordered) {
      if (attemptedOAuthAccountIds.has(accountId)) continue;
      const auth =
        await this.authManager.resolveModelAuthForOAuthAccount(accountId);
      if (!auth || auth.method !== "oauth") continue;
      attemptedOAuthAccountIds.add(accountId);
      await this.authManager.setActiveOAuthAccount(accountId);
      this.log(
        `[codex] Rotated OAuth account: ${currentAuth.oauthAccountLabel ?? currentAccountId} -> ${auth.oauthAccountLabel ?? accountId}`,
      );
      return auth;
    }

    return null;
  }

  private buildUsageLimitExhaustedError(
    attemptedOAuthAccountIds: Set<string>,
    sourceError: CodexSdkError,
  ): CodexRequestError {
    return new CodexRequestError(
      sourceError.message ||
        "Codex API error 429: The usage limit has been reached on all signed-in accounts.",
      {
        status: sourceError.status,
        rawMessage: sourceError.rawMessage,
        rawCode: sourceError.rawCode,
        body: sourceError.body,
        code: "oauth_usage_limit_exhausted",
        retryable: true,
        actions: { signInAnotherAccount: true },
        metadata: {
          attemptedOAuthAccountIds: [...attemptedOAuthAccountIds],
        },
      },
    );
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderStreamEvent> {
    const {
      model,
      systemPrompt,
      messages,
      tools,
      maxTokens,
      thinking,
      cache,
      state,
      signal,
    } = request;

    const codexInput = translateMessages(messages);
    const codexTools = tools ? translateTools(tools) : undefined;

    // Log image presence in the translated input
    {
      let imageCount = 0;
      let totalInputItems = 0;
      for (const item of codexInput) {
        if (
          "content" in item &&
          Array.isArray((item as { content?: unknown }).content)
        ) {
          const content = (
            item as { content: Array<{ type: string; image_url?: string }> }
          ).content;
          for (const c of content) {
            totalInputItems++;
            if (c.type === "input_image") {
              imageCount++;
              const urlPreview = c.image_url
                ? `${c.image_url.slice(0, 30)}...(${c.image_url.length} chars)`
                : "MISSING";
              this.log(`[codex:image] input_image found: url=${urlPreview}`);
            }
          }
        }
      }
      this.log(
        `[codex] stream() translated ${messages.length} messages → ${codexInput.length} input items (${totalInputItems} content parts, ${imageCount} images)`,
      );
    }

    const modelDef = CODEX_MODEL_MAP.get(model);
    const reasoningEffort = thinking
      ? "high"
      : (modelDef?.defaultReasoningEffort ?? "medium");

    let auth = await this.getModelAuthOrThrow();
    const attemptedOAuthAccountIds = new Set<string>();
    const refreshedOAuthAccountIds = new Set<string>();
    if (auth.method === "oauth" && auth.oauthAccountPoolId) {
      attemptedOAuthAccountIds.add(auth.oauthAccountPoolId);
    }

    while (true) {
      const requestBody = this.buildRequestBody({
        model,
        codexInput,
        systemPrompt,
        maxTokens,
        state,
        cache,
        reasoningEffort,
        tools: codexTools,
        auth,
      });

      // Log the request shape (not the full body — base64 data can be huge)
      {
        const inputItems = requestBody.input;
        const inputSummary = Array.isArray(inputItems)
          ? `${inputItems.length} items`
          : "string";
        const body = requestBody as unknown as Record<string, unknown>;
        this.log(
          `[codex] request: model=${requestBody.model} auth=${auth.method} input=${inputSummary} tools=${requestBody.tools?.length ?? 0} store=${requestBody.store} previousResponseId=${body.previous_response_id ?? "none"} cacheKey=${body.prompt_cache_key ?? "none"}`,
        );
      }

      const streamState = { outputStarted: false };
      try {
        const result = await this.executeStream(
          requestBody,
          auth,
          model,
          signal,
          streamState,
        );
        yield* result;
        return;
      } catch (err) {
        const sdkErr = toCodexSdkError(err);

        if (auth.method === "oauth" && isAuthError(sdkErr) && auth.canRefresh) {
          const refreshAccountId = auth.oauthAccountPoolId;
          if (
            refreshAccountId &&
            refreshedOAuthAccountIds.has(refreshAccountId)
          ) {
            this.log(
              `[codex] OAuth auth failure persists after refresh for account ${auth.oauthAccountLabel ?? refreshAccountId}`,
            );
          } else {
            const refreshed = await this.authManager.forceRefreshModelAuth(
              "oauth",
              {
                oauthAccountPoolId: refreshAccountId,
              },
            );
            if (refreshAccountId) {
              refreshedOAuthAccountIds.add(refreshAccountId);
            }
            if (refreshed) {
              this.log("[codex] Auth failure, refreshed active OAuth account");
              auth = refreshed;
              continue;
            }
          }
        }

        if (
          auth.method === "oauth" &&
          isUsageLimit429(sdkErr) &&
          auth.oauthAccountPoolId
        ) {
          await this.authManager.markOAuthUsageLimit(auth.oauthAccountPoolId);
          if (!streamState.outputStarted) {
            const nextAuth = await this.rotateOAuthAuth(
              attemptedOAuthAccountIds,
              auth,
            );
            if (nextAuth) {
              auth = nextAuth;
              continue;
            }
          }

          throw this.buildUsageLimitExhaustedError(
            attemptedOAuthAccountIds,
            sdkErr,
          );
        }

        if (isContextWindowExceeded(sdkErr)) {
          throw new CodexRequestError(sdkErr.message, {
            status: sdkErr.status,
            rawMessage: sdkErr.rawMessage,
            rawCode: sdkErr.rawCode,
            body: sdkErr.body,
            code: "context_window_exceeded",
            retryable: true,
            actions: { condense: true },
          });
        }

        throw sdkErr;
      }
    }
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const {
      model,
      systemPrompt,
      messages,
      maxTokens,
      temperature: _temperature,
      reasoningEffort: requestedEffort,
      cache,
      state,
    } = request;

    const codexInput = translateMessages(messages);

    const modelDef = CODEX_MODEL_MAP.get(model);
    const reasoningEffort =
      requestedEffort === "none"
        ? undefined
        : (requestedEffort ?? modelDef?.defaultReasoningEffort ?? "medium");

    let auth = await this.getModelAuthOrThrow();
    const attemptedOAuthAccountIds = new Set<string>();
    const refreshedOAuthAccountIds = new Set<string>();
    if (auth.method === "oauth" && auth.oauthAccountPoolId) {
      attemptedOAuthAccountIds.add(auth.oauthAccountPoolId);
    }

    while (true) {
      const requestBody = this.buildRequestBody({
        model,
        codexInput,
        systemPrompt,
        maxTokens,
        state,
        cache,
        reasoningEffort,
        auth,
      });

      // Log request shape (mirrors stream() logging)
      {
        const inputItems = requestBody.input;
        const inputSummary = Array.isArray(inputItems)
          ? `${inputItems.length} items`
          : "string";
        const body = requestBody as unknown as Record<string, unknown>;
        this.log(
          `[codex] complete(): model=${requestBody.model} auth=${auth.method} input=${inputSummary} tools=${requestBody.tools?.length ?? 0} store=${requestBody.store} reasoning=${JSON.stringify(body.reasoning ?? null)}`,
        );
      }

      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheCreationTokens = 0;
      let providerResponseId: string | undefined;

      try {
        for await (const event of await this.executeStream(
          requestBody,
          auth,
          model,
        )) {
          if (event.type === "text_delta") {
            text += event.text;
          } else if (event.type === "usage") {
            inputTokens = event.inputTokens;
            outputTokens = event.outputTokens;
            cacheReadTokens = event.cacheReadTokens ?? 0;
            cacheCreationTokens = event.cacheCreationTokens ?? 0;
            providerResponseId = event.providerResponseId;
          }
        }

        return {
          text,
          usage: {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
          },
          providerResponseId,
        };
      } catch (err) {
        const sdkErr = toCodexSdkError(err);

        this.log(
          `[codex] complete() error: status=${sdkErr.status ?? "none"} message=${sdkErr.message} rawCode=${sdkErr.rawCode ?? "none"} body=${JSON.stringify(sdkErr.body ?? null)}`,
        );

        if (auth.method === "oauth" && isAuthError(sdkErr) && auth.canRefresh) {
          const refreshAccountId = auth.oauthAccountPoolId;
          if (
            refreshAccountId &&
            refreshedOAuthAccountIds.has(refreshAccountId)
          ) {
            this.log(
              `[codex] complete() OAuth auth failure persists after refresh for account ${auth.oauthAccountLabel ?? refreshAccountId}`,
            );
          } else {
            const refreshed = await this.authManager.forceRefreshModelAuth(
              "oauth",
              {
                oauthAccountPoolId: refreshAccountId,
              },
            );
            if (refreshAccountId) {
              refreshedOAuthAccountIds.add(refreshAccountId);
            }
            if (refreshed) {
              this.log(
                "[codex] complete() auth failure, refreshed OAuth token",
              );
              auth = refreshed;
              continue;
            }
          }
        }

        if (
          auth.method === "oauth" &&
          isUsageLimit429(sdkErr) &&
          auth.oauthAccountPoolId
        ) {
          await this.authManager.markOAuthUsageLimit(auth.oauthAccountPoolId);
          const nextAuth = await this.rotateOAuthAuth(
            attemptedOAuthAccountIds,
            auth,
          );
          if (nextAuth) {
            if (text.length > 0) {
              this.log(
                "[codex] complete() encountered usage-limit 429 after partial output; retrying with next OAuth account and discarding partial text",
              );
            }
            auth = nextAuth;
            continue;
          }
          throw this.buildUsageLimitExhaustedError(
            attemptedOAuthAccountIds,
            sdkErr,
          );
        }

        if (isContextWindowExceeded(sdkErr)) {
          throw new CodexRequestError(sdkErr.message, {
            status: sdkErr.status,
            rawMessage: sdkErr.rawMessage,
            rawCode: sdkErr.rawCode,
            body: sdkErr.body,
            code: "context_window_exceeded",
            retryable: true,
            actions: { condense: true },
          });
        }

        throw sdkErr;
      }
    }
  }

  // ── Internal streaming parser ──

  private async *processResponseStreamEvents(
    events: AsyncIterable<Record<string, unknown>>,
    state?: { outputStarted: boolean },
  ): AsyncGenerator<ProviderStreamEvent> {
    const contentBlocks: ContentBlock[] = [];
    let currentText = "";
    let currentThinking = "";
    let thinkingId: string | null = null;

    const pendingToolCalls = new Map<
      string,
      { name: string; arguments: string }
    >();

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let providerResponseId: string | undefined;

    for await (const event of events) {
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
          if (state) state.outputStarted = true;
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
            if (state) state.outputStarted = true;
            yield { type: "thinking_start", thinkingId };
          }
          currentThinking += delta;
          if (state) state.outputStarted = true;
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
          if (state) state.outputStarted = true;
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
            if (state) state.outputStarted = true;
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
            (item.function as Record<string, unknown> | undefined)?.name) as
            | string
            | undefined;
          if (callId && name) {
            pendingToolCalls.set(callId, { name, arguments: "" });
            if (state) state.outputStarted = true;
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
            (item.function as Record<string, unknown> | undefined)?.name) as
            | string
            | undefined;
          const argsRaw = item.arguments ?? item.input;
          const argsStr =
            typeof argsRaw === "string"
              ? argsRaw
              : argsRaw && typeof argsRaw === "object"
                ? JSON.stringify(argsRaw)
                : "";

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

            if (state) state.outputStarted = true;
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
        throw new CodexRequestError(`Codex API error: ${msg}`, {
          rawMessage: msg,
          body: errObj,
        });
      }
      if (eventType === "response.failed") {
        const errObj = event.error as Record<string, unknown> | undefined;
        const msg =
          (errObj?.message as string) ??
          (event.message as string) ??
          "Request failed";
        throw new CodexRequestError(`Codex request failed: ${msg}`, {
          rawMessage: msg,
          body: errObj,
        });
      }

      // ── Response done — extract usage and finalize ──
      if (eventType === "response.done" || eventType === "response.completed") {
        const resp = event.response as Record<string, unknown> | undefined;
        providerResponseId =
          (resp?.id as string | undefined) ??
          (event.response_id as string | undefined) ??
          providerResponseId;
        const usage = (resp?.usage ?? event.usage) as
          | Record<string, unknown>
          | undefined;
        if (usage) {
          const totalInputTokens =
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
          const promptDetails = usage.prompt_tokens_details as
            | Record<string, unknown>
            | undefined;
          cacheReadTokens =
            (inputDetails?.cached_tokens as number) ??
            (promptDetails?.cached_tokens as number) ??
            (usage.cache_read_input_tokens as number) ??
            0;

          cacheCreationTokens =
            (inputDetails?.cache_creation_tokens as number) ??
            (inputDetails?.cache_write_tokens as number) ??
            (promptDetails?.cache_creation_tokens as number) ??
            (promptDetails?.cache_write_tokens as number) ??
            (usage.cache_creation_input_tokens as number) ??
            (usage.cache_write_input_tokens as number) ??
            (usage.cache_write_tokens as number) ??
            0;

          inputTokens = Math.max(0, totalInputTokens - cacheReadTokens);
        }

        if (!currentText && Array.isArray(resp?.output)) {
          for (const item of resp.output as Array<Record<string, unknown>>) {
            if (item.type === "message" && Array.isArray(item.content)) {
              for (const c of item.content as Array<Record<string, unknown>>) {
                if (c.type === "output_text" && typeof c.text === "string") {
                  currentText += c.text;
                  if (state) state.outputStarted = true;
                  yield { type: "text_delta", text: c.text as string };
                }
              }
            }
            if (
              item.type === "reasoning" &&
              Array.isArray(item.summary) &&
              !currentThinking
            ) {
              for (const s of item.summary as Array<Record<string, unknown>>) {
                if (s?.type === "summary_text" && typeof s.text === "string") {
                  if (!thinkingId) {
                    thinkingId = randomUUID();
                    if (state) state.outputStarted = true;
                    yield { type: "thinking_start", thinkingId };
                  }
                  currentThinking += s.text;
                  if (state) state.outputStarted = true;
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
        continue;
      }
    }

    if (thinkingId) {
      yield { type: "thinking_end", thinkingId };
      contentBlocks.unshift({
        type: "thinking",
        thinking: currentThinking,
        signature: "",
      } satisfies ThinkingBlock);
    }

    if (currentText) {
      contentBlocks.push({ type: "text", text: currentText });
    }

    yield {
      type: "usage",
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheReadTokens || undefined,
      cacheCreationTokens: cacheCreationTokens || undefined,
      providerResponseId,
    };
    yield { type: "content_blocks", blocks: contentBlocks };
    yield { type: "done" };
  }

  private async executeStream(
    requestBody: CodexRequestBody,
    auth: OpenAiCodexResolvedAuth,
    _model: string,
    signal?: AbortSignal,
    streamState?: { outputStarted: boolean },
  ): Promise<AsyncGenerator<ProviderStreamEvent>> {
    try {
      const client = this.getClient(auth);
      const stream = await client.responses.create(requestBody, {
        signal,
        maxRetries: 0,
      });

      return this.processResponseStreamEvents(
        stream as AsyncIterable<Record<string, unknown>>,
        streamState,
      );
    } catch (error) {
      throw toCodexSdkError(error);
    }
  }
}
