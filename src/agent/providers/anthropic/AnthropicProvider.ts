/**
 * AnthropicProvider — implements ModelProvider for the Anthropic Messages API.
 *
 * This is the only file (alongside clientFactory.ts) that imports @anthropic-ai/sdk.
 * All Anthropic-specific SSE parsing, cache_control injection, and message
 * formatting lives here.
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import {
  createAnthropicClient,
  hasAnthropicApiKey,
  refreshClaudeCredentials,
  type AuthSource,
} from "../../clientFactory.js";
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
} from "../types.js";

type AnthropicModelCapabilities = ModelCapabilities & {
  supportsThinking: boolean;
};

const ANTHROPIC_MODEL_CAPABILITIES: Record<string, AnthropicModelCapabilities> =
  {
    "claude-opus-4-6": {
      supportsThinking: true,
      supportsCaching: true,
      supportsImages: true,
      supportsToolUse: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    },
    "claude-sonnet-4-6": {
      supportsThinking: true,
      supportsCaching: true,
      supportsImages: true,
      supportsToolUse: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    },
    "claude-haiku-4-5-20251001": {
      supportsThinking: false,
      supportsCaching: true,
      supportsImages: true,
      supportsToolUse: true,
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
    },
  };

const DEFAULT_CAPABILITIES: AnthropicModelCapabilities = {
  supportsThinking: false,
  supportsCaching: true,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 128_000,
};

/** The preferred cheap/fast model for condensing. */
export const ANTHROPIC_CONDENSE_MODEL = "claude-haiku-4-5-20251001";

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly displayName = "Anthropic";
  readonly condenseModel = ANTHROPIC_CONDENSE_MODEL;

  private client: Anthropic | null = null;
  private authSource: AuthSource = "none";
  private apiKey?: string;
  private log?: (msg: string) => void;

  constructor(apiKey?: string, log?: (msg: string) => void) {
    this.apiKey = apiKey;
    this.log = log;
    this.tryInitializeClient();
  }

  async isAuthenticated(): Promise<boolean> {
    return hasAnthropicApiKey();
  }

  getCapabilities(model: string): ModelCapabilities {
    return ANTHROPIC_MODEL_CAPABILITIES[model] ?? DEFAULT_CAPABILITIES;
  }

  listModels(): ModelInfo[] {
    return [
      this.makeModelInfo("claude-sonnet-4-6", "Claude Sonnet 4"),
      this.makeModelInfo("claude-opus-4-6", "Claude Opus 4"),
      this.makeModelInfo("claude-haiku-4-5-20251001", "Claude Haiku 4.5"),
    ];
  }

  /**
   * Attempt to refresh CLI credentials (runs `claude -p` to force the SDK
   * to refresh the OAuth token), then re-create the Anthropic client.
   * Returns true if the client was successfully refreshed.
   * Pass an AbortSignal to cancel if the user stops the session.
   */
  async refreshClient(signal?: AbortSignal): Promise<boolean> {
    if (this.authSource !== "cli-credentials") return false;
    const refreshed = await refreshClaudeCredentials(this.log, signal);
    if (!refreshed) return false;
    try {
      const result = createAnthropicClient(this.apiKey, this.log);
      this.client = result.client;
      this.authSource = result.authSource;
      return true;
    } catch {
      return false;
    }
  }

  get currentAuthSource(): AuthSource {
    return this.authSource;
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderStreamEvent> {
    const client = this.getClient();
    const {
      model,
      systemPrompt,
      messages,
      tools,
      maxTokens,
      thinking,
      signal,
    } = request;

    // Build Anthropic-native request params
    const anthropicMessages = addMessageCacheBreakpoints(
      mergeConsecutiveUserMessages(
        messages.map(({ role, content }) => ({ role, content })),
      ),
    ) as Anthropic.MessageParam[];

    const anthropicTools = tools
      ? tools.map((t, i) =>
          i === tools.length - 1
            ? {
                ...toAnthropicTool(t),
                cache_control: { type: "ephemeral" as const },
              }
            : toAnthropicTool(t),
        )
      : undefined;

    const requestParams: Anthropic.MessageCreateParams = {
      model,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: anthropicMessages,
      max_tokens: maxTokens,
      stream: true,
      ...(anthropicTools && anthropicTools.length > 0
        ? { tools: anthropicTools }
        : {}),
    };

    if (thinking) {
      (requestParams as unknown as Record<string, unknown>).thinking = {
        type: "enabled",
        budget_tokens: thinking.budgetTokens,
      };
    }

    const contentBlocks: ContentBlock[] = [];
    const blockBuffers = new Map<
      number,
      {
        type: string;
        id?: string;
        text: string;
        name?: string;
        signature?: string;
      }
    >();

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;

    const stream = client.messages.stream(requestParams, { signal });

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          const idx = event.index;

          if (block.type === "thinking") {
            const thinkingId = randomUUID();
            blockBuffers.set(idx, {
              type: "thinking",
              id: thinkingId,
              text: "",
            });
            yield { type: "thinking_start", thinkingId };
          } else if (block.type === "text") {
            blockBuffers.set(idx, { type: "text", text: "" });
          } else if (block.type === "tool_use") {
            blockBuffers.set(idx, {
              type: "tool_use",
              id: block.id,
              name: block.name,
              text: "",
            });
            yield {
              type: "tool_start",
              toolCallId: block.id,
              toolName: block.name,
            };
          }
          break;
        }

        case "content_block_delta": {
          const idx = event.index;
          const buf = blockBuffers.get(idx);

          if (
            event.delta.type === "thinking_delta" &&
            buf?.type === "thinking"
          ) {
            buf.text += event.delta.thinking;
            yield {
              type: "thinking_delta",
              thinkingId: buf.id!,
              text: event.delta.thinking,
            };
          } else if (
            event.delta.type === "text_delta" &&
            buf?.type === "text"
          ) {
            buf.text += event.delta.text;
            yield { type: "text_delta", text: event.delta.text };
          } else if (
            event.delta.type === "signature_delta" &&
            buf?.type === "thinking"
          ) {
            buf.signature =
              (buf.signature ?? "") +
              (event.delta as unknown as { signature: string }).signature;
          } else if (
            event.delta.type === "input_json_delta" &&
            buf?.type === "tool_use"
          ) {
            buf.text += event.delta.partial_json;
            yield {
              type: "tool_input_delta",
              toolCallId: buf.id!,
              partialJson: event.delta.partial_json,
            };
          }
          break;
        }

        case "content_block_stop": {
          const idx = event.index;
          const buf = blockBuffers.get(idx);

          if (buf?.type === "thinking") {
            yield { type: "thinking_end", thinkingId: buf.id! };
            contentBlocks.push({
              type: "thinking",
              thinking: buf.text,
              signature: buf.signature ?? "",
            } satisfies ContentBlock);
          } else if (buf?.type === "text") {
            contentBlocks.push({
              type: "text",
              text: buf.text,
            } satisfies ContentBlock);
          } else if (buf?.type === "tool_use") {
            const parsed = buf.text ? JSON.parse(buf.text) : {};
            contentBlocks.push({
              type: "tool_use",
              id: buf.id!,
              name: buf.name!,
              input: parsed,
            } satisfies ContentBlock);
            yield {
              type: "tool_done",
              toolCallId: buf.id!,
              toolName: buf.name!,
              input: parsed,
            };
          }

          blockBuffers.delete(idx);
          break;
        }

        case "message_delta": {
          if (event.usage) {
            outputTokens = event.usage.output_tokens;
          }
          break;
        }

        case "message_start": {
          if (event.message.usage) {
            inputTokens = event.message.usage.input_tokens;
            const u = event.message.usage as typeof event.message.usage & {
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            cacheReadTokens = u.cache_read_input_tokens ?? 0;
            cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
          }
          break;
        }
      }
    }

    yield {
      type: "usage",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    };
    yield { type: "content_blocks", blocks: contentBlocks };
    yield { type: "done" };
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const client = this.getClient();
    const { model, systemPrompt, messages, maxTokens, temperature } = request;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      system: systemPrompt,
      messages: messages.map(({ role, content }) => ({
        role,
        content,
      })) as Anthropic.MessageParam[],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private makeModelInfo(id: string, displayName: string): ModelInfo {
    return {
      id,
      displayName,
      provider: this.id,
      capabilities: this.getCapabilities(id),
    };
  }

  private tryInitializeClient(): void {
    try {
      const result = createAnthropicClient(this.apiKey, this.log);
      this.client = result.client;
      this.authSource = result.authSource;
    } catch (err) {
      this.client = null;
      this.authSource = "none";
      this.log?.(
        `[auth] Anthropic client unavailable at startup: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private getClient(): Anthropic {
    if (this.client) return this.client;
    const result = createAnthropicClient(this.apiKey, this.log);
    this.client = result.client;
    this.authSource = result.authSource;
    return result.client;
  }
}

// ── Helpers (moved from AgentEngine.ts) ──

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool["input_schema"],
  };
}

/**
 * Merge consecutive user messages before sending to the API.
 * Consecutive user messages can occur after condense (summary message followed
 * by a pending user message) or when the user interjects between tool batches.
 */
function mergeConsecutiveUserMessages(
  messages: MessageParam[],
): MessageParam[] {
  const result: MessageParam[] = [];
  for (const msg of messages) {
    const last = result[result.length - 1];
    if (last?.role === "user" && msg.role === "user") {
      const toBlocks = (c: MessageParam["content"]): ContentBlock[] =>
        Array.isArray(c) ? c : [{ type: "text", text: c as string }];
      last.content = [...toBlocks(last.content), ...toBlocks(msg.content)];
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }
  return result;
}

/**
 * Add cache_control breakpoints to the last 2 user messages.
 * Multi-point caching: the second-to-last breakpoint hits the cache on the next
 * turn (the prefix before it is stable), while the last creates a new cache entry
 * so the turn after that also benefits.
 */
function addMessageCacheBreakpoints(messages: MessageParam[]): MessageParam[] {
  const userIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userIndices.push(i);
      if (userIndices.length === 2) break;
    }
  }
  if (userIndices.length === 0) return messages;

  return messages.map((msg, idx) => {
    if (!userIndices.includes(idx)) return msg;
    const blocks = Array.isArray(msg.content)
      ? (msg.content as unknown as Array<Record<string, unknown>>)
      : [{ type: "text", text: msg.content as string }];
    if (blocks.length === 0) return msg;
    // Strip any pre-existing cache_control from non-last blocks
    const patched = [
      ...blocks.slice(0, -1).map(({ cache_control: _cc, ...rest }) => rest),
      { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } },
    ];
    return {
      role: msg.role,
      content: patched as unknown as ContentBlock[],
    };
  });
}
