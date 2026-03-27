/**
 * Provider-agnostic type system for AgentLink.
 *
 * These types replace all `Anthropic.*` types in internal code.
 * They are intentionally similar to Anthropic's types (the most mature API
 * for agentic use) but owned by us, enabling multi-provider support.
 *
 * Design note: unified `ContentBlock`
 * Anthropic has separate types for "what you send" (ContentBlockParam) vs
 * "what you receive" (ContentBlock). Our type is **unified**: ContentBlock
 * covers both directions. This simplifies the internal API.
 */

// ── Content blocks ──

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | DocumentBlock;

export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

/** MIME types accepted by the Anthropic Messages API for image content. */
export type ImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

const SUPPORTED_IMAGE_TYPES = new Set<ImageMediaType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Map common non-standard MIME strings to a supported ImageMediaType. */
const MIME_ALIASES: Record<string, ImageMediaType> = {
  "image/jpg": "image/jpeg",
  "image/x-png": "image/png",
};

/**
 * Normalise a MIME type string to a supported ImageMediaType.
 * Returns null if the type is not recognised/supported.
 */
export function toSupportedImageMediaType(
  mimeType: string,
): ImageMediaType | null {
  if (SUPPORTED_IMAGE_TYPES.has(mimeType as ImageMediaType)) {
    return mimeType as ImageMediaType;
  }
  return MIME_ALIASES[mimeType] ?? null;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: ImageMediaType;
    data: string;
  };
}

export interface DocumentBlock {
  type: "document";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
  title?: string;
}

// ── Messages ──

export interface MessageParam {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

// ── Tools ──

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
  cache_control?: { type: "ephemeral" };
}

export type JsonSchema = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  [key: string]: unknown;
};

// ── Provider interface ──

export interface ModelProvider {
  readonly id: string;
  readonly displayName: string;
  /** The preferred cheap/fast model to use for context condensing. */
  readonly condenseModel: string;

  /** Async — checks stored credentials, may trigger refresh. */
  isAuthenticated(): Promise<boolean>;

  getCapabilities(model: string): ModelCapabilities;

  /**
   * Models this provider owns. Used as source of truth for model→provider routing.
   * Returns a hardcoded superset — runtime failures (model not available for account)
   * are handled gracefully at request time, not filtered here.
   */
  listModels(): ModelInfo[];

  /**
   * Optional: check which models are actually available for the current account.
   * Called lazily after auth succeeds. Providers that don't vary by account can
   * skip this (defaults to listModels()). For Codex, this could query the API
   * to filter by entitlement — but we defer this until we hit real account-gating issues.
   */
  listAvailableModels?(): Promise<ModelInfo[]>;

  /** Streaming completion — the primary agentic loop interface. */
  stream(request: StreamRequest): AsyncGenerator<ProviderStreamEvent>;

  /**
   * Non-streaming completion — for MCP sampling, condensing, and any
   * one-shot inference call. Simpler contract than stream() for callers
   * that just need a final result.
   */
  complete(request: CompleteRequest): Promise<CompleteResult>;
}

export interface ProviderCacheOptions {
  key?: string;
  retention?: "in_memory" | "24h";
}

export interface ProviderStateOptions {
  previousResponseId?: string;
  store?: boolean;
}

export interface StreamRequest {
  model: string;
  systemPrompt: string;
  messages: MessageParam[];
  tools?: ToolDefinition[];
  maxTokens: number;
  thinking?: { budgetTokens: number };
  cache?: ProviderCacheOptions;
  state?: ProviderStateOptions;
  signal?: AbortSignal;
}

export interface CompleteRequest {
  model: string;
  systemPrompt: string;
  messages: MessageParam[];
  maxTokens: number;
  /** Optional sampling temperature. Use 0 for deterministic tasks like condensing. */
  temperature?: number;
  cache?: ProviderCacheOptions;
  state?: ProviderStateOptions;
}

export interface CompleteResult {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  providerResponseId?: string;
}

export type ProviderStreamEvent =
  | { type: "thinking_start"; thinkingId: string }
  | { type: "thinking_delta"; thinkingId: string; text: string }
  | { type: "thinking_end"; thinkingId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_input_delta"; toolCallId: string; partialJson: string }
  | {
      type: "tool_done";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | { type: "content_blocks"; blocks: ContentBlock[] }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      providerResponseId?: string;
    }
  | { type: "done" };

export interface ModelCapabilities {
  supportsThinking: boolean;
  supportsCaching: boolean;
  supportsImages: boolean;
  supportsToolUse: boolean;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: string;
  capabilities: ModelCapabilities;
}
