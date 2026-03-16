import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import { readFileSync } from "fs";
import * as path from "path";
import type { AgentSession } from "./AgentSession.js";
import type { AgentEvent } from "./types.js";
import {
  getAgentTools,
  dispatchToolCall,
  READ_ONLY_TOOLS,
  type ToolDispatchContext,
} from "./toolAdapter.js";
import { handleToolError } from "../shared/types.js";
import type { ToolResult } from "../shared/types.js";
import type { TrackerContext } from "../server/ToolCallTracker.js";
import {
  TODO_TOOL_NAME,
  todoTool,
  handleTodoWrite,
  type TodoToolInput,
} from "./todoTool.js";
import {
  summarizeConversation,
  injectSyntheticToolResults,
} from "./condense.js";
import type {
  ModelProvider,
  ContentBlock,
  ToolUseBlock,
  ToolDefinition,
  MessageParam,
  ImageBlock,
} from "./providers/types.js";
import { toSupportedImageMediaType } from "./providers/types.js";
import type { ProviderRegistry } from "./providers/index.js";
import { AnthropicProvider } from "./providers/anthropic/index.js";
const MAX_API_RETRIES = 3;
const _MAX_EMPTY_RESPONSE_RETRIES = 1;

/** Walk the error cause chain and join unique messages into one string. */
// (No equivalent exists elsewhere in the codebase.)
function buildErrorMessage(err: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let e: unknown = err;
  while (e instanceof Error && !seen.has(e)) {
    seen.add(e);
    if (e.message) parts.push(e.message);
    e = (e as { cause?: unknown }).cause;
  }
  return [...new Set(parts)].join(": ");
}

/** Returns true for transient errors that are safe to retry. */
function isRetryableError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("rate_limit") ||
    lower.includes("overloaded") ||
    lower.includes("529") ||
    lower.includes("connection error") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("timed out") ||
    lower.includes("fetch failed") ||
    lower.includes("other side closed") ||
    lower.includes("terminated") ||
    lower.includes("an error occurred while processing your request") ||
    lower.includes("please include the request id")
  );
}

function extractAgentDisplayArgs(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "execute_command":
      return String(input.command ?? "").slice(0, 80);
    case "get_terminal_output":
      return String(input.terminal_id ?? "");
    case "close_terminals":
      return Array.isArray(input.names)
        ? (input.names as string[]).join(", ")
        : "all";
    case "read_file":
    case "list_files":
    case "get_diagnostics":
    case "open_file":
    case "write_file":
    case "apply_diff":
      return String(input.path ?? "");
    case "search_files":
      return String(input.regex ?? "").slice(0, 60);
    case "show_notification":
      return String(input.message ?? "").slice(0, 60);
    case "rename_symbol":
      return String(input.new_name ?? "");
    case "find_and_replace":
      return `${String(input.find ?? "").slice(0, 30)} → ${String(input.replace ?? "").slice(0, 30)}`;
    default:
      return "";
  }
}

/** Custom error for auth failures, so the outer catch can mark them specially. */
class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

/** Returns true for authentication errors (expired token, invalid key). */
function isAuthError(msg: string): boolean {
  return (
    msg.includes("authentication_error") ||
    msg.includes("invalid x-api-key") ||
    msg.includes("invalid api key") ||
    (msg.includes("401") && !msg.includes("tool"))
  );
}

function getContextWindow(model: string, provider: ModelProvider): number {
  return provider.getCapabilities(model).contextWindow;
}

function isOverCondenseThresholdInternal(
  session: AgentSession,
  provider: ModelProvider,
  toolResults?: ToolCallResult[],
): boolean {
  if (!session.autoCondense || session.lastInputTokens === 0) return false;
  const contextWindow = getContextWindow(session.model, provider);
  const usableWindow = contextWindow - session.maxTokens;
  if (usableWindow <= 0) return false;

  const estimatedResultTokens = toolResults
    ? Math.ceil(
        toolResults.reduce(
          (n, tr) =>
            n +
            JSON.stringify(
              toolResultToContent(tr.result, undefined, tr.toolName),
            ).length,
          0,
        ) / 4,
      )
    : 0;
  const used =
    session.lastInputTokens + session.lastOutputTokens + estimatedResultTokens;
  const usedFraction = used / usableWindow;
  const cacheHitRatio = session.lastCacheReadTokens / session.lastInputTokens;
  const effectiveThreshold = Math.min(
    session.autoCondenseThreshold + cacheHitRatio * 0.1,
    0.95,
  );
  return usedFraction >= effectiveThreshold;
}

function hasUnansweredUserTurn(session: AgentSession): boolean {
  const msgs = session.getAllMessages();
  const last = msgs[msgs.length - 1];
  const hasAnyAssistant = msgs.some((m) => m.role === "assistant");
  return (
    hasAnyAssistant &&
    !!last &&
    last.role === "user" &&
    typeof last.content === "string" &&
    !last.isSummary
  );
}

/** Internal result from a single tool call execution. */
interface ToolCallResult {
  tool_use_id: string;
  toolName: string;
  result: ToolResult;
  durationMs: number;
}

// Per-tool character limits for tool results kept in conversation history.
// Tools that self-paginate (read_file) get more headroom; repetitive/noisy
// tools get tighter caps. At ~4 chars/token:
const TOOL_RESULT_CHAR_LIMITS: Record<string, number> = {
  read_file: 80_000, // ~20k tokens — self-paginating; every line is high-value
  execute_command: 40_000, // ~10k tokens — VS Code terminal already caps at 200 lines
  search_files: 20_000, // ~5k tokens — results can be repetitive; agent can refine
  codebase_search: 20_000,
  list_files: 12_000, // ~3k tokens — just file paths
};
const DEFAULT_TOOL_RESULT_CHARS = 32_000; // ~8k tokens

// Truncated tool results are saved here so the agent can read_file the full
// output when needed. Allowlisted in handleReadFile to bypass the approval gate.
const AGENTLINK_TMP_DIR = "/tmp/agentlink-results";

/**
 * Snap a head slice back to the last newline within 15% of the budget,
 * so truncation always ends at a complete line.
 */
function headSlice(text: string, maxChars: number): string {
  const raw = text.slice(0, maxChars);
  const newlineIdx = raw.lastIndexOf("\n");
  if (newlineIdx > 0 && maxChars - newlineIdx <= maxChars * 0.15) {
    return raw.slice(0, newlineIdx + 1);
  }
  return raw;
}

/**
 * Snap a tail slice forward to the first newline within 15% of the budget,
 * so truncation always starts at a complete line.
 */
function tailSlice(text: string, maxChars: number): string {
  const raw = text.slice(text.length - maxChars);
  const newlineIdx = raw.indexOf("\n");
  if (newlineIdx >= 0 && newlineIdx <= maxChars * 0.15) {
    return raw.slice(newlineIdx + 1);
  }
  return raw;
}

/**
 * Head+tail truncation with line-boundary snapping. Keeps the first and last
 * portions so both the start and end of output are visible (critical for
 * terminal output where errors appear at the end). Reports omitted tokens so
 * the agent can gauge how much was dropped. Saves full content to a tmp file
 * if toolUseId is provided so the agent can read_file the complete result.
 */
function truncateToolText(
  text: string,
  maxChars: number,
  toolUseId?: string,
): string {
  if (text.length <= maxChars) return text;

  const halfChars = Math.floor(maxChars * 0.5);
  const head = headSlice(text, halfChars);
  const tail = tailSlice(text, maxChars - halfChars);
  const omittedChars = text.length - head.length - tail.length;
  const omittedTokens = Math.ceil(omittedChars / 4);

  let notice = `\n\n[... ~${omittedTokens.toLocaleString()} tokens (~${omittedChars.toLocaleString()} chars) omitted from middle ...]`;

  if (toolUseId) {
    const tmpPath = path.join(AGENTLINK_TMP_DIR, `${toolUseId}.txt`);
    // Fire-and-forget — save full content without blocking the response
    fs.mkdir(AGENTLINK_TMP_DIR, { recursive: true })
      .then(() => fs.writeFile(tmpPath, text, "utf-8"))
      .catch(() => {});
    notice += `\nFull output saved to: ${tmpPath} — use read_file to access the complete result.`;
  }

  return `${head}${notice}\n\n${tail}`;
}

/** Convert our ToolResult content to provider-agnostic tool_result content. */
function toolResultToContent(
  result: ToolResult,
  toolUseId: string | undefined,
  toolName: string,
): string | ContentBlock[] {
  const maxChars =
    TOOL_RESULT_CHAR_LIMITS[toolName] ?? DEFAULT_TOOL_RESULT_CHARS;
  const hasImage = result.content.some((c) => c.type === "image");
  if (!hasImage) {
    // Simple case: all text — join into a single string, then cap size.
    const joined = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("\n");
    return truncateToolText(joined, maxChars, toolUseId);
  }
  // Mixed content: pass blocks so images are preserved; cap text blocks.
  return result.content
    .map((c): ContentBlock | null => {
      if (c.type === "text")
        return {
          type: "text" as const,
          text: truncateToolText(c.text, maxChars, toolUseId),
        };
      // image — validate media_type before sending to the API
      const raw = (c as { type: "image"; data: string; mimeType: string })
        .mimeType;
      const mediaType = toSupportedImageMediaType(raw);
      if (!mediaType) {
        return {
          type: "text" as const,
          text: `[Image with unsupported format: ${raw}]`,
        };
      }
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mediaType,
          data: (c as { type: "image"; data: string; mimeType: string }).data,
        },
      };
    })
    .filter((b): b is ContentBlock => b !== null);
}

export class AgentEngine {
  private registry: ProviderRegistry;
  private log?: (msg: string) => void;
  private toolCtx: ToolDispatchContext | null = null;

  constructor(registry: ProviderRegistry, log?: (msg: string) => void) {
    this.registry = registry;
    this.log = log;
  }

  setToolContext(ctx: ToolDispatchContext): void {
    this.toolCtx = ctx;
  }

  async *run(
    session: AgentSession,
    opts?: {
      isBackground?: boolean;
      toolProfile?: string;
      maxApiTurns?: number;
      maxToolCalls?: number;
    },
  ): AsyncGenerator<AgentEvent> {
    const ac = session.createAbortController();
    // Capture signal locally — a subsequent run() call on the same session would
    // replace session._abortSignal via createAbortController(), causing session.isAborted
    // to return false in this (still-running) loop and allowing spurious API calls.
    const { signal } = ac;

    // Resolve the provider for this session's model
    const provider = this.registry.resolveProvider(session.model);

    // Cache assembled tool list across turns — rebuild only when the tool set changes.
    let cachedTools: ToolDefinition[] | undefined;
    let cachedToolFingerprint = "";

    const maxApiTurns = opts?.maxApiTurns ?? 0; // 0 = unlimited
    const maxToolCalls = opts?.maxToolCalls ?? 0; // 0 = unlimited
    let apiTurnCount = 0;
    let totalToolCalls = 0;
    let wrapUpAttempts = 0; // Track wrap-up injections to prevent infinite loops
    const MAX_WRAP_UP_ATTEMPTS = 2;

    try {
      let retryCount = 0;
      let credentialRefreshCount = 0;
      const MAX_CREDENTIAL_REFRESHES = 3;
      while (true) {
        if (signal.aborted) break;

        // Include tools when dispatch context is available, filtered by mode.
        // Compute this before any condense path so both automatic and retry-triggered
        // condenses see the same preserved runtime context that future requests will use.
        const mcpToolDefs = this.toolCtx?.mcpHub?.getToolDefs() ?? [];
        const rawTools = this.toolCtx
          ? [
              ...getAgentTools(
                session.agentMode,
                mcpToolDefs,
                opts?.isBackground,
                opts?.toolProfile,
              ),
              todoTool,
            ]
          : undefined;
        const preservedContext = {
          toolNames: rawTools?.map((t) => t.name) ?? [],
          mcpServerNames: [
            ...new Set(
              mcpToolDefs
                .map((t) => {
                  const sep = t.name.indexOf("__");
                  return sep === -1 ? "" : t.name.slice(0, sep);
                })
                .filter((name) => name.length > 0),
            ),
          ],
        };

        // --- Auto-condense check ---
        // Run before each API call (except the very first) to keep context in bounds.
        const resolveQueuedAttachments = (
          text: string,
          attachments?: string[],
        ) => {
          if (!attachments?.length) return text;
          const blocks: string[] = [];
          for (const filePath of attachments) {
            try {
              const absPath = path.isAbsolute(filePath)
                ? filePath
                : path.join(session.cwd, filePath);
              const content = readFileSync(absPath, "utf-8");
              const ext = path.extname(filePath).slice(1) || "";
              blocks.push(
                `<file path="${filePath}">\n\`\`\`${ext}\n${content}\n\`\`\`\n</file>`,
              );
            } catch {
              blocks.push(
                `<file path="${filePath}">\n[Error: could not read file]\n</file>`,
              );
            }
          }
          return `${blocks.join("\n\n")}\n\n${text}`;
        };

        if (
          this.isOverCondenseThreshold(session, undefined, provider) &&
          !hasUnansweredUserTurn(session)
        ) {
          yield* this.condenseSession(
            session,
            true,
            provider,
            preservedContext,
          );
          if (signal.aborted) break;
          const interjection = session.consumePendingInterjection();
          if (interjection) {
            const resolvedInterjectionText = resolveQueuedAttachments(
              interjection.text,
              interjection.attachments,
            );
            session.addUserMessage(resolvedInterjectionText);
            session.setPendingMedia(
              session.messageCount - 1,
              interjection.images,
              interjection.documents,
            );
            yield {
              type: "user_interjection" as const,
              text: interjection.text,
              queueId: interjection.queueId,
              displayText: interjection.displayText,
            };
          }
        }

        const requestId = randomUUID();
        const startTime = Date.now();
        let timeToFirstToken = 0;

        const capabilities = provider.getCapabilities(session.model);
        const useThinking =
          capabilities.supportsThinking && session.thinkingBudget > 0;

        // When thinking is enabled, max_tokens must exceed budget_tokens
        const maxTokens = useThinking
          ? Math.max(session.maxTokens, session.thinkingBudget + 4096)
          : session.maxTokens;

        // Rebuild with cache_control only when the tool set changes
        const fingerprint = rawTools
          ? rawTools
              .map((t) => t.name)
              .sort()
              .join(",")
          : "";
        if (rawTools && fingerprint !== cachedToolFingerprint) {
          cachedTools = rawTools.map((t, i) =>
            i === rawTools.length - 1
              ? { ...t, cache_control: { type: "ephemeral" as const } }
              : t,
          );
          cachedToolFingerprint = fingerprint;
        }
        const tools = rawTools ? cachedTools : undefined;

        let contentBlocks: ContentBlock[] = [];
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;
        let firstTokenReceived = false;

        try {
          // Build a copy of messages for the API call, injecting any pending
          // media (pasted images/PDFs) as content blocks alongside the text.
          // getPendingMedia() is non-destructive — safe across retries.
          const apiMessages: MessageParam[] = session
            .getMessages()
            .map(({ role, content }, idx) => {
              const media = session.getPendingMedia(idx);
              if (media && role === "user" && typeof content === "string") {
                const imageBlocks: ImageBlock[] = media.images
                  .map((img) => {
                    const mediaType = toSupportedImageMediaType(img.mimeType);
                    if (!mediaType) {
                      this.log?.(
                        `[media] skipping unsupported image type: ${img.mimeType}`,
                      );
                      return null;
                    }
                    return {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: mediaType,
                        data: img.base64,
                      },
                    };
                  })
                  .filter((b): b is ImageBlock => b !== null);

                const blocks: ContentBlock[] = [
                  ...imageBlocks,
                  ...media.documents.map((doc) => ({
                    type: "document" as const,
                    source: {
                      type: "base64" as const,
                      media_type: doc.mimeType,
                      data: doc.base64,
                    },
                    title: doc.name,
                  })),
                  { type: "text" as const, text: content },
                ];
                return { role, content: blocks };
              }
              return { role, content };
            });

          const streamGen = provider.stream({
            model: session.model,
            systemPrompt: session.systemPrompt,
            messages: apiMessages,
            tools,
            maxTokens,
            thinking: useThinking
              ? { budgetTokens: session.thinkingBudget }
              : undefined,
            signal: ac.signal,
          });

          for await (const event of streamGen) {
            if (signal.aborted) break;

            if (!firstTokenReceived) {
              firstTokenReceived = true;
              timeToFirstToken = Date.now() - startTime;
            }

            switch (event.type) {
              case "thinking_start":
                yield { type: "thinking_start", thinkingId: event.thinkingId };
                break;
              case "thinking_delta":
                yield {
                  type: "thinking_delta",
                  thinkingId: event.thinkingId,
                  text: event.text,
                };
                break;
              case "thinking_end":
                yield { type: "thinking_end", thinkingId: event.thinkingId };
                break;
              case "text_delta":
                yield { type: "text_delta", text: event.text };
                break;
              case "tool_start":
                session.currentTool = event.toolName;
                yield {
                  type: "tool_start",
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                };
                break;
              case "tool_input_delta":
                yield {
                  type: "tool_input_delta",
                  toolCallId: event.toolCallId,
                  partialJson: event.partialJson,
                };
                break;
              case "tool_done":
                // Handled at content_blocks
                break;
              case "content_blocks":
                contentBlocks = event.blocks;
                break;
              case "usage":
                inputTokens = event.inputTokens;
                outputTokens = event.outputTokens;
                cacheReadTokens = event.cacheReadTokens ?? 0;
                cacheCreationTokens = event.cacheCreationTokens ?? 0;
                break;
              case "done":
                break;
            }
          }
        } catch (streamErr: unknown) {
          if (signal.aborted) break;
          const streamErrMsg = buildErrorMessage(streamErr);

          // Orphaned tool_use blocks (e.g. from an aborted run) cause a 400.
          if (
            streamErrMsg.includes("tool_use") &&
            streamErrMsg.includes("tool_result")
          ) {
            session.replaceMessages(
              injectSyntheticToolResults(session.getAllMessages()),
            );
            yield {
              type: "warning",
              message: `Repaired orphaned tool calls, retrying. Error: ${streamErrMsg}`,
            };
            continue;
          }

          // Context too long: auto-condense and retry rather than failing.
          if (streamErrMsg.includes("prompt is too long")) {
            yield {
              type: "warning",
              message:
                "Context limit exceeded — condensing conversation and retrying…",
            };
            yield* this.condenseSession(
              session,
              true,
              provider,
              preservedContext,
            );
            if (signal.aborted) break;
            continue;
          }

          // Auth errors: try refreshing credentials before failing.
          if (isAuthError(streamErrMsg)) {
            const anthropicProvider =
              provider instanceof AnthropicProvider ? provider : null;
            if (
              !signal.aborted &&
              credentialRefreshCount < MAX_CREDENTIAL_REFRESHES &&
              anthropicProvider?.currentAuthSource === "cli-credentials"
            ) {
              credentialRefreshCount++;
              yield {
                type: "status_update",
                message: `Refreshing credentials… (attempt ${credentialRefreshCount}/${MAX_CREDENTIAL_REFRESHES} — ${streamErrMsg})`,
              };
              if (await anthropicProvider.refreshClient(signal)) {
                yield {
                  type: "status_update",
                  message: "Credentials refreshed — retrying…",
                };
                if (signal.aborted) break;
                continue;
              }
            }
            throw new AuthenticationError(streamErrMsg);
          }

          // Transient network / rate-limit errors: auto-retry with backoff.
          if (isRetryableError(streamErrMsg) && retryCount < MAX_API_RETRIES) {
            retryCount++;
            const isRateLimit =
              streamErrMsg.includes("rate_limit") ||
              streamErrMsg.includes("overloaded");
            const delayMs = isRateLimit
              ? Math.min(retryCount * 15_000, 60_000)
              : Math.min(retryCount * 2_000, 10_000);
            yield {
              type: "warning",
              message: `${streamErrMsg} — retrying in ${delayMs / 1000}s (attempt ${retryCount}/${MAX_API_RETRIES})`,
            };
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
            if (signal.aborted) break;
            continue;
          }

          throw streamErr;
        }

        // Successful API response — reset retry counter.
        retryCount = 0;
        apiTurnCount++;

        // Release pending media now that the API has received it.
        // This frees the base64 data from memory.
        session.clearPendingMedia();

        if (signal.aborted) break;

        // Always record usage and emit api_request — even for capped turns.
        const durationMs = Date.now() - startTime;
        session.addUsage(
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        );

        // The API's input_tokens only counts tokens after the last cache breakpoint.
        // For context window tracking, report the total: uncached + cache reads + cache writes.
        const totalInputTokens =
          inputTokens + cacheReadTokens + cacheCreationTokens;

        yield {
          type: "api_request",
          requestId,
          model: session.model,
          inputTokens: totalInputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          durationMs,
          timeToFirstToken,
        };

        // Enforce maxApiTurns: when the limit is reached and the model wants
        // more tool calls, inject a "wrap up" message to force a final response.
        if (maxApiTurns > 0 && apiTurnCount >= maxApiTurns) {
          const hasToolCalls = contentBlocks.some((b) => b.type === "tool_use");
          if (hasToolCalls) {
            wrapUpAttempts++;
            // Hard stop after too many wrap-up attempts to prevent infinite loops
            if (wrapUpAttempts > MAX_WRAP_UP_ATTEMPTS) {
              session.appendAssistantTurn(contentBlocks);
              yield {
                type: "warning",
                message: `Background agent exceeded ${MAX_WRAP_UP_ATTEMPTS} wrap-up attempts. Force-stopping.`,
              };
              break;
            }
            // Append the assistant turn with tool calls so history is valid,
            // then add synthetic results asking to wrap up.
            session.appendAssistantTurn(contentBlocks);
            const toolUseBlocksForWrapUp = contentBlocks.filter(
              (b): b is ToolUseBlock => b.type === "tool_use",
            );
            session.appendToolResults(
              toolUseBlocksForWrapUp.map((b) => ({
                type: "tool_result" as const,
                tool_use_id: b.id,
                content:
                  "[Turn limit reached — tool not executed. Deliver your findings now with the information you have.]",
              })),
            );
            yield {
              type: "warning",
              message: `Background agent turn limit reached (${maxApiTurns}). Requesting wrap-up.`,
            };
            continue;
          }
        }

        // Extract tool_use blocks
        const toolUseBlocks = contentBlocks.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );

        if (toolUseBlocks.length === 0) {
          // No tool calls — append the assistant turn on its own and finish.
          session.appendAssistantTurn(contentBlocks);
          break;
        }

        if (!this.toolCtx) {
          // No dispatch context — append and finish without executing tools.
          session.appendAssistantTurn(contentBlocks);
          break;
        }

        // Enforce maxToolCalls: count only dispatch-eligible tools (exclude todo_write).
        const dispatchableToolCount = toolUseBlocks.filter(
          (b) => b.name !== TODO_TOOL_NAME,
        ).length;
        if (
          maxToolCalls > 0 &&
          totalToolCalls + dispatchableToolCount > maxToolCalls
        ) {
          wrapUpAttempts++;
          if (wrapUpAttempts > MAX_WRAP_UP_ATTEMPTS) {
            session.appendAssistantTurn(contentBlocks);
            yield {
              type: "warning",
              message: `Background agent exceeded ${MAX_WRAP_UP_ATTEMPTS} wrap-up attempts. Force-stopping.`,
            };
            break;
          }
          session.appendAssistantTurn(contentBlocks);
          session.appendToolResults(
            toolUseBlocks.map((b) => ({
              type: "tool_result" as const,
              tool_use_id: b.id,
              content:
                "[Tool call budget exceeded — tool not executed. Deliver your findings now with the information you have.]",
            })),
          );
          yield {
            type: "warning",
            message: `Background agent tool call limit reached (${maxToolCalls}). Requesting wrap-up.`,
          };
          continue;
        }
        totalToolCalls += dispatchableToolCount;

        // Session-scoped tool context: use session.id so that per-session approvals
        // (MCP, command, write) are isolated between foreground chat sessions rather
        // than shared via the static "agent" synthetic ID.
        const sessionCtx: ToolDispatchContext = {
          ...this.toolCtx,
          sessionId: session.id,
          mode: session.agentMode.slug,
        };

        // Execute tools (parallel for read-only, sequential for write)
        session.status = "tool_executing";

        // Separate internal tools (todo_write) from dispatch tools
        const internalResults: ToolCallResult[] = [];
        const dispatchBlocks: ToolUseBlock[] = [];
        for (const block of toolUseBlocks) {
          if (block.name === TODO_TOOL_NAME) {
            const start = Date.now();
            const { content, todos } = handleTodoWrite(
              block.input as unknown as TodoToolInput,
            );
            internalResults.push({
              tool_use_id: block.id,
              toolName: block.name,
              result: {
                content: [
                  {
                    type: "text",
                    text:
                      typeof content === "string"
                        ? content
                        : JSON.stringify(content),
                  },
                ],
              },
              durationMs: Date.now() - start,
            });
            yield { type: "todo_update" as const, todos };
          } else {
            dispatchBlocks.push(block);
          }
        }

        const dispatchResults =
          dispatchBlocks.length > 0
            ? await this.executeToolCalls(
                dispatchBlocks,
                signal,
                sessionCtx,
                session,
              )
            : [];

        // Merge results back in original order
        const toolResults = toolUseBlocks.map((block) => {
          const internal = internalResults.find(
            (r) => r.tool_use_id === block.id,
          );
          if (internal) return internal;
          return dispatchResults.find((r) => r.tool_use_id === block.id)!;
        });

        // Append assistant turn + tool results atomically — no async gap between
        // them so the session is never left with orphaned tool_use blocks.
        session.appendAssistantTurn(contentBlocks);
        session.appendToolResults(
          toolResults.map((tr) => ({
            type: "tool_result" as const,
            tool_use_id: tr.tool_use_id,
            content: toolResultToContent(
              tr.result,
              tr.tool_use_id,
              tr.toolName,
            ),
          })),
        );

        // Yield tool_result events (after history is updated)
        for (const tr of toolResults) {
          const toolUseBlock = toolUseBlocks.find(
            (b) => b.id === tr.tool_use_id,
          );
          yield {
            type: "tool_result" as const,
            toolCallId: tr.tool_use_id,
            toolName: tr.toolName,
            result: tr.result.content,
            durationMs: tr.durationMs,
            input: toolUseBlock?.input,
          };
        }

        // Post-batch condense check: tool results may have added significant tokens
        // that aren't reflected in lastInputTokens yet (which still shows the count
        // from before the results were appended). Estimate the result size and
        // condense proactively if the projected next-turn context would exceed the
        // threshold — avoiding an oversized API call or a "prompt is too long" error.
        if (
          !signal.aborted &&
          this.isOverCondenseThreshold(session, toolResults, provider)
        ) {
          yield* this.condenseSession(
            session,
            true,
            provider,
            preservedContext,
          );
        }

        // Inject any pending user interjection between tool batches
        if (!signal.aborted) {
          const interjection = session.consumePendingInterjection();
          if (interjection) {
            const resolvedInterjectionText = resolveQueuedAttachments(
              interjection.text,
              interjection.attachments,
            );
            session.addUserMessage(resolvedInterjectionText);
            session.setPendingMedia(
              session.messageCount - 1,
              interjection.images,
              interjection.documents,
            );
            yield {
              type: "user_interjection" as const,
              text: interjection.text,
              queueId: interjection.queueId,
              displayText: interjection.displayText,
            };
          }
        }

        session.status = "streaming";
      }
    } catch (err: unknown) {
      if (signal.aborted) return;
      // Retryable errors are handled inside the loop with auto-retry.
      // Anything reaching here is non-retryable or exhausted all retries.
      // Auth and exhausted transient errors are marked retryable so the UI can
      // always offer a sensible retry path.
      const errorMessage = buildErrorMessage(err);
      const isAuth =
        err instanceof AuthenticationError || isAuthError(errorMessage);
      yield {
        type: "error",
        error: errorMessage,
        retryable: isAuth || isRetryableError(errorMessage),
      };
      return;
    } finally {
      session.status = "idle";
    }

    // Don't emit done if aborted — ChatViewProvider already posted agentDone on stop,
    // and a second done event could interrupt a new run that's already in progress.
    if (signal.aborted) return;

    yield {
      type: "done",
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      totalCacheReadTokens: session.totalCacheReadTokens,
      totalCacheCreationTokens: session.totalCacheCreationTokens,
    };
  }

  /**
   * Execute tool calls with parallel read-only and sequential write strategy.
   * Results are returned in the same order as the original tool_use blocks.
   */
  /**
   * Returns true if the session's projected next-turn context usage exceeds the
   * auto-condense threshold. Pass toolResults to include an estimate of their
   * token cost (used for the post-batch check, where results have been appended
   * to history but lastInputTokens still reflects pre-result counts).
   */
  isOverCondenseThreshold(
    session: AgentSession,
    toolResults?: ToolCallResult[],
    provider?: ModelProvider,
  ): boolean {
    const resolvedProvider =
      provider ?? this.registry.tryResolveProvider(session.model);
    if (!resolvedProvider) return false;
    return isOverCondenseThresholdInternal(
      session,
      resolvedProvider,
      toolResults,
    );
  }

  private async executeToolCalls(
    calls: ToolUseBlock[],
    signal: AbortSignal,
    ctx: ToolDispatchContext,
    session: AgentSession,
  ): Promise<Array<ToolCallResult>> {
    const resultSlots = Array.from<ToolCallResult | null>({
      length: calls.length,
    }).fill(null);

    const runTrackedToolCall = async (
      call: ToolUseBlock,
      start: number,
    ): Promise<ToolCallResult> => {
      const tracker = ctx.toolCallTracker;

      let trackerCtx: TrackerContext | undefined;
      let forceResolve: ((result: ToolResult) => void) | undefined;
      let forcePromise: Promise<ToolResult> | undefined;

      if (tracker) {
        forcePromise = new Promise<ToolResult>((resolve) => {
          forceResolve = resolve;
        });
        trackerCtx = tracker.registerAgentCall(
          call.id,
          call.name,
          extractAgentDisplayArgs(
            call.name,
            call.input as Record<string, unknown>,
          ),
          session.id,
          forceResolve!,
          JSON.stringify(call.input, null, 2),
        );
      }

      try {
        const result = await (forcePromise
          ? Promise.race([
              dispatchToolCall(
                call.name,
                call.input as Record<string, unknown>,
                {
                  ...ctx,
                  sessionId: session.id,
                  trackerCtx,
                },
              ),
              forcePromise,
            ])
          : dispatchToolCall(call.name, call.input as Record<string, unknown>, {
              ...ctx,
              sessionId: session.id,
              trackerCtx,
            }));
        return {
          tool_use_id: call.id,
          toolName: call.name,
          result,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return {
          tool_use_id: call.id,
          toolName: call.name,
          result: handleToolError(err),
          durationMs: Date.now() - start,
        };
      } finally {
        tracker?.completeAgentCall(call.id);
      }
    };

    // Partition into read-only (parallel) and write (sequential)
    const readOnlyIndices: number[] = [];
    const writeIndices: number[] = [];
    for (let i = 0; i < calls.length; i++) {
      if (READ_ONLY_TOOLS.has(calls[i].name)) {
        readOnlyIndices.push(i);
      } else {
        writeIndices.push(i);
      }
    }

    // Execute read-only tools in parallel
    await Promise.all(
      readOnlyIndices.map(async (i) => {
        if (signal.aborted) return;
        const call = calls[i];
        const start = Date.now();
        try {
          resultSlots[i] = await runTrackedToolCall(call, start);
        } catch (err) {
          resultSlots[i] = {
            tool_use_id: call.id,
            toolName: call.name,
            result: handleToolError(err),
            durationMs: Date.now() - start,
          };
        }
      }),
    );

    // Execute write tools sequentially
    for (const i of writeIndices) {
      if (signal.aborted) break;
      const call = calls[i];
      const start = Date.now();
      try {
        resultSlots[i] = await runTrackedToolCall(call, start);
      } catch (err) {
        resultSlots[i] = {
          tool_use_id: call.id,
          toolName: call.name,
          result: handleToolError(err),
          durationMs: Date.now() - start,
        };
      }
    }

    // Return results in original order, filling any gaps (from abort) with errors
    return resultSlots.map(
      (slot, i) =>
        slot ?? {
          tool_use_id: calls[i].id,
          toolName: calls[i].name,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ error: "Aborted" }) },
            ],
          },
          durationMs: 0,
        },
    );
  }

  /**
   * Condense the session's conversation history.
   * Yields condense or condense_error events. Updates session.messages on success.
   */
  async *condenseSession(
    session: AgentSession,
    isAutomatic: boolean,
    provider?: ModelProvider,
    preservedContext?: { toolNames: string[]; mcpServerNames?: string[] },
  ): AsyncGenerator<AgentEvent> {
    yield { type: "condense_start", isAutomatic };

    const prevInputTokens = session.lastInputTokens;

    // Resolve the provider for condensing — use the session's provider if available
    const resolvedProvider =
      provider ?? this.registry.resolveProvider(session.model);

    const result = await summarizeConversation(
      {
        messages: session.getAllMessages(),
        provider: resolvedProvider,
        systemPrompt: session.systemPrompt,
        isAutomatic,
        filesRead: [...session.filesRead],
        cwd: session.cwd,
        preservedContext,
      },
      prevInputTokens,
    );

    if (result.error) {
      yield { type: "condense_error", error: result.error };
      return;
    }

    session.replaceMessages(result.messages);
    // Reset lastInputTokens to estimated post-condense value so we don't immediately re-trigger
    session.lastInputTokens = result.newInputTokens;
    // Clear output and cache-read tokens; post-condense estimates have no prior-turn component.
    session.lastOutputTokens = 0;
    session.lastCacheReadTokens = 0;

    yield {
      type: "condense",
      summary: result.summary,
      prevInputTokens: result.prevInputTokens,
      newInputTokens: result.newInputTokens,
      validationWarnings: result.validationWarnings,
      metadata: result.metadata,
    };
  }
}
