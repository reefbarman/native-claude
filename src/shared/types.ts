/**
 * Inline approval request — passed as a callback through the tool dispatch
 * pipeline so tools can request user approval via the chat webview instead
 * of a native VS Code modal or the separate approval panel.
 */
export interface InlineApprovalChoice {
  label: string;
  value: string;
  isPrimary?: boolean;
  isDanger?: boolean;
}

export interface InlineApprovalRequest {
  kind: "mcp" | "write" | "rename" | "command";
  title: string;
  detail?: string;
  choices: InlineApprovalChoice[];
  /**
   * Optional id for approvals that need rich decision payloads
   * (e.g. rejectionReason/followUp), not just a selected choice value.
   */
  id?: string;
  /** When set, shows attribution for which background task is requesting approval. */
  backgroundTask?: string;
}

/**
 * Function type for requesting inline approval.
 * Returns either a selected choice value or a rich decision payload.
 */
export type OnApprovalRequest = (request: InlineApprovalRequest) => Promise<
  | string
  | {
      decision: string;
      rejectionReason?: string;
      followUp?: string;
      trustScope?: string;
      rulePattern?: string;
      ruleMode?: string;
    }
>;

/**
 * Shared type for MCP tool handler results.
 * Used across all tool implementations.
 */
export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
};

/** Create a successful ToolResult from a JSON-serializable payload. */
export function successResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/** Create an error ToolResult from a message string. */
export function errorResult(
  message: string,
  extra?: Record<string, unknown>,
): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: message, ...extra }) },
    ],
  };
}

/** Wrap a caught error into a ToolResult. */
export function handleToolError(
  err: unknown,
  context?: Record<string, unknown>,
): ToolResult {
  if (typeof err === "object" && err !== null && "content" in err) {
    return err as ToolResult;
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(message, context);
}

/** Status info for a running background agent session. */
export interface BgSessionInfo {
  id: string;
  task: string;
  status:
    | "streaming"
    | "tool_executing"
    | "awaiting_approval"
    | "idle"
    | "error"
    | "cancelled";
  /** Most recently started tool name (while streaming). */
  currentTool?: string;
  /** Resolved execution mode after route selection. */
  resolvedMode?: string;
  /** Resolved model id after route selection. */
  resolvedModel?: string;
  /** Resolved provider id after route selection. */
  resolvedProvider?: string;
  /** Background task class used for routing profile selection. */
  taskClass?: string;
  /** Human-readable reason for the selected route. */
  routingReason?: string;
  /** True when route fallback behavior was used. */
  fallbackUsed?: boolean;
  /** Accumulated streaming text from the bg agent (last ~500 chars for preview). */
  streamingText?: string;
  /** Final result text when agent is done. */
  resultText?: string;
  /** Error message if the agent errored. */
  errorMessage?: string;
  /** Timestamp when the agent finished (for auto-dismiss timing). */
  completedAt?: number;
  /** Full transcript of the bg agent conversation (all assistant text blocks). */
  fullTranscript?: string;
}
