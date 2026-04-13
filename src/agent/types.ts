import type { ToolResult } from "../shared/types.js";
import type { TodoItem } from "./todoTool.js";
import type { MessageParam } from "./providers/types.js";

// --- Agent Message (conversation history with condense metadata) ---

/**
 * Extends MessageParam with non-destructive condense tracking.
 * - isSummary: marks this message as a condensation summary
 * - condenseId: UUID set on the summary message
 * - condenseParent: UUID of the summary that replaced this message
 *   (messages with condenseParent are filtered from API history when their summary exists)
 */
export interface AgentErrorActions {
  signIn?: boolean;
  signInAnotherAccount?: boolean;
  condense?: boolean;
}

export interface AgentRuntimeError {
  message: string;
  retryable: boolean;
  code?: string;
  actions?: AgentErrorActions;
}

export type AgentMessage = MessageParam & {
  isSummary?: boolean;
  isResumeContext?: boolean;
  condenseId?: string;
  condenseParent?: string;
  preservedContext?: {
    toolNames: string[];
    mcpServerNames?: string[];
    activeSkills?: string[];
  };
  runtimeError?: AgentRuntimeError;
  uiHint?: {
    userMessage?: {
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
    };
    condense?: {
      prevInputTokens?: number;
      newInputTokens?: number;
      durationMs?: number;
      validationWarnings?: string[];
      errorMessage?: string;
      condensing?: boolean;
    };
  };
};

// --- Agent Events (emitted by AgentEngine) ---

export type AgentEvent =
  | { type: "thinking_start"; thinkingId: string }
  | { type: "thinking_delta"; thinkingId: string; text: string }
  | { type: "thinking_end"; thinkingId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | {
      type: "tool_input_delta";
      toolCallId: string;
      partialJson: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      result: ToolResult["content"];
      durationMs: number;
      input?: unknown;
    }
  | { type: "todo_update"; todos: TodoItem[] }
  | {
      type: "checkpoint_created";
      checkpointId: string;
      /** Number of visible user turns already committed at the checkpoint snapshot. */
      turnIndex: number;
    }
  | { type: "condense_start"; isAutomatic: boolean }
  | {
      type: "condense";
      /** Short summary of what was condensed (first ~100 chars of LLM output) */
      summary: string;
      /** Input tokens before condensing */
      prevInputTokens: number;
      /** Estimated input tokens after condensing */
      newInputTokens: number;
      /** Duration in ms for this condense operation */
      durationMs?: number;
      /** Non-fatal validator/retry warnings for this condense run */
      validationWarnings?: string[];
      metadata?: {
        inputMessageCount: number;
        sourceUserMessageCount: number;
        hadPriorSummaryInInput: boolean;
        sourceHash: string;
        providerId: string;
        condenseModel: string;
        modelCandidates: string[];
        selectedModel: string;
        latestUserMessage: string;
        currentTask: string;
        pendingTasks: string[];
        canonicalUserMessages: string[];
        requestMessageCount: number;
        effectiveHistoryMessageCount: number;
        effectiveHistoryRoles: string[];
      };
    }
  | {
      type: "condense_error";
      error: string;
      retryable?: boolean;
      code?: string;
      actions?: AgentErrorActions;
    }
  | {
      type: "api_request";
      requestId: string;
      model: string;
      inputTokens: number;
      uncachedInputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      durationMs: number;
      timeToFirstToken: number;
      usedPreviousResponseId?: boolean;
      previousResponseIdFallback?: boolean;
      promptCacheKey?: string;
      promptCacheRetention?: "in_memory" | "24h";
      storeResponseState?: boolean;
      providerResponseId?: string;
    }
  | { type: "warning"; message: string }
  | { type: "status_update"; message: string }
  | {
      type: "error";
      error: string;
      retryable: boolean;
      code?: string;
      actions?: AgentErrorActions;
    }
  | {
      type: "done";
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
    }
  | {
      type: "user_interjection";
      text: string;
      queueId: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
    };

// --- Session types ---

export type SessionStatus =
  | "idle"
  | "streaming"
  | "tool_executing"
  | "awaiting_approval"
  | "error";

export interface SessionInfo {
  id: string;
  status: SessionStatus;
  mode: string;
  model: string;
  title: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  background: boolean;
  createdAt: number;
  lastActiveAt: number;
}

// --- Configuration ---

export interface AgentConfig {
  model: string;
  maxTokens: number;
  thinkingBudget: number;
  showThinking: boolean;
  autoCondense: boolean;
  autoCondenseThreshold: number; // 0–1, e.g. 0.9 = 90%
  codexStatefulResponses?: boolean;
  codexStoreResponses?: boolean;
}
