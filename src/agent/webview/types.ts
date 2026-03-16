/** A mode available for selection */
export interface ModeInfo {
  slug: string;
  name: string;
  icon: string;
}

/** Model info sent from the extension via agentModelsUpdate. */
export interface WebviewModelInfo {
  id: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  authenticated: boolean;
  condenseThreshold?: number;
}

/** A slash command available for autocomplete */
export interface SlashCommandInfo {
  name: string;
  description: string;
  source: "builtin" | "project" | "global" | "agentlink";
  /** True if this is a built-in command that executes immediately */
  builtin: boolean;
  /** Body to inject into input (for file-based commands) */
  body?: string;
  /** Codicon name to show next to the command */
  icon?: string;
  /** Value shown right-aligned (e.g. current model name) */
  rightLabel?: string;
  /** Show a checkmark — used in sub-pickers for current selection */
  isCurrent?: boolean;
}

/** A question posed by the agent via the ask_user tool */
export interface Question {
  id: string;
  type:
    | "multiple_choice"
    | "multiple_select"
    | "yes_no"
    | "text"
    | "scale"
    | "confirmation";
  question: string;
  options?: string[];
  /** The option value the agent recommends (must match one of the options strings) */
  recommended?: string;
  scale_min?: number;
  scale_max?: number;
  scale_min_label?: string;
  scale_max_label?: string;
}

/** Messages from extension to webview */
export type ExtensionMessage =
  | { type: "stateUpdate"; state: ChatState }
  | { type: "agentThinkingStart"; sessionId: string; thinkingId: string }
  | {
      type: "agentThinkingDelta";
      sessionId: string;
      thinkingId: string;
      text: string;
    }
  | { type: "agentThinkingEnd"; sessionId: string; thinkingId: string }
  | { type: "agentTextDelta"; sessionId: string; text: string }
  | {
      type: "agentToolStart";
      sessionId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "agentToolInputDelta";
      sessionId: string;
      toolCallId: string;
      partialJson: string;
    }
  | {
      type: "agentToolComplete";
      sessionId: string;
      toolCallId: string;
      toolName: string;
      result: string;
      durationMs: number;
      input?: unknown;
    }
  | {
      type: "agentUserAnnotation";
      sessionId: string;
      text: string;
      badge: "follow-up" | "rejection";
    }
  | {
      type: "agentApiRequest";
      sessionId: string;
      requestId: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      durationMs: number;
      timeToFirstToken: number;
    }
  | {
      type: "agentError";
      sessionId: string;
      error: string;
      retryable: boolean;
    }
  | {
      type: "agentDone";
      sessionId: string;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
    }
  | { type: "agentTodoUpdate"; sessionId: string; todos: TodoItem[] }
  | {
      type: "agentCheckpointCreated";
      sessionId: string;
      checkpointId: string;
      turnIndex: number;
    }
  | {
      type: "agentCondense";
      sessionId: string;
      prevInputTokens: number;
      newInputTokens: number;
      /** First ~200 chars of the summary for display */
      summary: string;
      durationMs: number;
      validationWarnings?: string[];
    }
  | {
      type: "agentCondenseError";
      sessionId: string;
      error: string;
    }
  | {
      type: "agentCondenseStart";
      sessionId: string;
      isAutomatic: boolean;
    }
  | {
      type: "agentWarning";
      sessionId: string;
      message: string;
    }
  | {
      type: "agentStatusUpdate";
      sessionId: string;
      message: string;
    }
  | { type: "agentSessionUpdate"; sessions: SessionInfo[] }
  | {
      type: "agentDebugInfo";
      info: Record<string, string | number>;
      systemPrompt?: string;
      loadedInstructions?: Array<{ source: string; chars: number }>;
    }
  | {
      type: "agentFileSearchResults";
      requestId: string;
      files: Array<{ path: string; kind: "file" | "folder" }>;
    }
  | {
      type: "agentInjectPrompt";
      prompt: string;
      attachments: string[];
      autoSubmit?: boolean;
    }
  | { type: "agentInjectAttachment"; path: string }
  | { type: "agentInjectContext"; context: string }
  | { type: "agentModesUpdate"; modes: ModeInfo[] }
  | { type: "agentModelsUpdate"; models: WebviewModelInfo[] }
  | { type: "agentSlashCommandsUpdate"; commands: SlashCommandInfo[] }
  | { type: "agentModeSwitchRequest"; mode: string; reason?: string }
  | {
      type: "agentElicitationRequest";
      id: string;
      serverName: string;
      message: string;
      fields: Record<
        string,
        {
          type: "string" | "number" | "boolean";
          title?: string;
          description?: string;
          enum?: string[];
          default?: unknown;
          minimum?: number;
          maximum?: number;
          minLength?: number;
          maxLength?: number;
        }
      >;
      required: string[];
    }
  | {
      type: "agentMcpStatus";
      open?: boolean;
      infos: Array<{
        name: string;
        status: string;
        error?: string;
        toolCount: number;
        resourceCount: number;
        promptCount: number;
      }>;
    }
  | {
      type: "showApproval";
      request: import("../../approvals/webview/types").ApprovalRequest;
    }
  | { type: "idle" }
  | { type: "agentQuestionRequest"; id: string; questions: Question[] }
  | { type: "agentDroppedFilesResolved"; files: string[] }
  | {
      type: "agentSessionList";
      sessions: SessionSummary[];
    }
  | { type: "agentRestoreSessionStart" }
  | { type: "agentRestoreSessionDone" }
  | {
      type: "agentSessionLoaded";
      sessionId: string;
      title: string;
      mode: string;
      messages: unknown[];
      lastInputTokens: number;
      lastOutputTokens: number;
      /** True when this came from automatic startup restore rather than explicit user action. */
      restored?: boolean;
      /** turnIndex → checkpointId mapping for restored sessions */
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
    }
  | {
      type: "agentInterjection";
      sessionId: string;
      text: string;
      queueId: string;
      /** Display text for the chat bubble (e.g. "/pr") when text is the expanded body */
      displayText?: string;
    }
  | {
      type: "agentBgSessionsUpdate";
      sessions: Array<{
        id: string;
        task: string;
        status:
          | "streaming"
          | "tool_executing"
          | "awaiting_approval"
          | "idle"
          | "error"
          | "cancelled";
        currentTool?: string;
        resolvedMode?: string;
        resolvedModel?: string;
        resolvedProvider?: string;
        taskClass?: string;
        routingReason?: string;
        fallbackUsed?: boolean;
        streamingText?: string;
        resultText?: string;
        errorMessage?: string;
        completedAt?: number;
        fullTranscript?: string;
      }>;
    }
  | { type: "agentBgThinkingStart"; sessionId: string; thinkingId: string }
  | {
      type: "agentBgThinkingDelta";
      sessionId: string;
      thinkingId: string;
      text: string;
    }
  | { type: "agentBgThinkingEnd"; sessionId: string; thinkingId: string }
  | { type: "agentBgTextDelta"; sessionId: string; text: string }
  | {
      type: "agentBgToolStart";
      sessionId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "agentBgToolComplete";
      sessionId: string;
      toolCallId: string;
      toolName: string;
      result: string;
      durationMs: number;
      input?: unknown;
    }
  | {
      type: "agentBgApiRequest";
      sessionId: string;
      requestId: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      durationMs: number;
      timeToFirstToken: number;
    }
  | {
      type: "agentBgError";
      sessionId: string;
      error: string;
      retryable: boolean;
    }
  | {
      type: "agentBgDone";
      sessionId: string;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
      resultText?: string;
    }
  | {
      type: "agentBgQuestion";
      /** Foreground session that answered the question */
      sessionId: string;
      /** The background agent's task label */
      bgTask: string;
      /** Questions asked by the background agent */
      questions: string[];
      /** The foreground agent's answer */
      answer: string;
    }
  | ShowBgTranscriptMessage
  | { type: "agentBtwLoading"; requestId: string; question: string }
  | {
      type: "agentBtwResponse";
      requestId: string;
      question: string;
      answer: string;
      error?: boolean;
    };

export type ShowBgTranscriptMessage = {
  type: "showBgTranscript";
  sessionId: string;
  task: string;
  /** Raw AgentMessage[] from the backend session */
  messages: unknown[];
};

export interface ChatState {
  sessionId: string | null;
  mode: string;
  model: string;
  streaming: boolean;
  condenseThreshold?: number;
  agentWriteApproval?: "prompt" | "session" | "project" | "global";
}

export interface SessionInfo {
  id: string;
  status: string;
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

/** Persisted session summary from the SessionStore */
export interface SessionSummary {
  id: string;
  mode: string;
  model: string;
  title: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: number;
  lastActiveAt: number;
}

// ── Ordered content blocks ──

export type ContentBlock =
  | { type: "thinking"; id: string; text: string; complete: boolean }
  | { type: "text"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      inputJson: string;
      result: string;
      complete: boolean;
      durationMs?: number;
    }
  | {
      type: "bg_agent";
      /** The background session ID */
      sessionId: string;
      /** Short task label */
      task: string;
      /** The full message/prompt sent to the background agent */
      message?: string;
      /** Resolved model used by the background agent */
      resolvedModel?: string;
      /** Resolved provider */
      resolvedProvider?: string;
      /** Resolved mode */
      resolvedMode?: string;
      /** Task class used for routing */
      taskClass?: string;
      /** Routing decision reason */
      routingReason?: string;
    }
  | {
      type: "bg_agent_result";
      /** The background session ID */
      sessionId: string;
      /** Short task label */
      task: string;
      /** Completion status */
      status: "completed" | "error" | "cancelled";
      /** The final result text from the background agent */
      resultText?: string;
    }
  | {
      type: "bg_question";
      /** The background agent's task label */
      bgTask: string;
      /** Questions asked by the background agent */
      questions: string[];
      /** The foreground agent's answer */
      answer: string;
    }
  | {
      type: "question_answer";
      /** Array of Q&A pairs from the ask_user tool */
      items: Array<{
        question: string;
        answer: string | string[] | number | boolean | null;
        note?: string;
      }>;
    };

/** A chat message in the webview state */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "condense" | "warning";
  /** User messages: plain text. Assistant messages: empty (use blocks). */
  content: string;
  timestamp: number;
  /** Ordered content blocks — preserves interleaving of thinking/text/tool_call */
  blocks: ContentBlock[];
  /** Badge shown on approval follow-up and rejection annotation messages */
  badge?: "follow-up" | "rejection";
  /** True when this message is a slash command invocation (renders as a compact pill) */
  isSlashCommand?: boolean;
  /** Checkpoint ID associated with this user message (set when checkpoint was created before send) */
  checkpointId?: string;
  error?: { message: string; retryable: boolean };
  apiRequest?: {
    requestId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    timeToFirstToken: number;
  };
  /** Set when role === "condense" */
  condenseInfo?: {
    prevInputTokens: number;
    newInputTokens: number;
    durationMs?: number;
    errorMessage?: string;
    condensing?: boolean;
    validationWarnings?: string[];
  };
  /** Set when role === "warning" */
  warningMessage?: string;
}

export interface TodoItem {
  id: string;
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
  children?: TodoItem[];
}
