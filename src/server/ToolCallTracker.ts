import { EventEmitter } from "events";
import { randomUUID } from "crypto";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";

import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { appendFeedback } from "../util/feedbackStore.js";

// ── Types ────────────────────────────────────────────────────────────────────

import { type ToolResult } from "../shared/types.js";

const MAX_LOG_STRING_CHARS = 240;
const MAX_LOG_JSON_CHARS = 1_200;
const MAX_LOG_COLLECTION_ITEMS = 20;
const MAX_LOG_DEPTH = 3;

export interface TrackerContext {
  toolCallId: string;
  setApprovalId: (approvalId: string) => void;
  setTerminalId: (terminalId: string) => void;
}

/** Where the tool call originated from. */
export type ToolCallSource = "mcp" | "agent";

export interface TrackedCall {
  id: string;
  toolName: string;
  displayArgs: string;
  params?: string;
  sessionId: string;
  startedAt: number;
  forceResolve: (result: ToolResult) => void;
  approvalId?: string;
  terminalId?: string;
  lastHeartbeatAt?: number;
  source: ToolCallSource;
}

export interface TrackedCallInfo {
  id: string;
  toolName: string;
  displayArgs: string;
  params?: string;
  startedAt: number;
  status: "active" | "completed" | "rejected";
  completedAt?: number;
  lastHeartbeatAt?: number;
  /** Where this tool call originated — "mcp" for external agents, "agent" for the built-in agent. */
  source: ToolCallSource;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeToolResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function truncateLogString(input: string, max = MAX_LOG_STRING_CHARS): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}… [truncated ${input.length - max} chars]`;
}

function sanitizeParamsForLog(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncateLogString(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function") {
    const fn = value as (...args: unknown[]) => unknown;
    return `[function ${fn.name || "anonymous"}]`;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateLogString(value.message),
    };
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_LOG_DEPTH) return `[array(${value.length})]`;
    const items = value
      .slice(0, MAX_LOG_COLLECTION_ITEMS)
      .map((item) => sanitizeParamsForLog(item, depth + 1));
    if (value.length > MAX_LOG_COLLECTION_ITEMS) {
      items.push(`[${value.length - MAX_LOG_COLLECTION_ITEMS} more items]`);
    }
    return items;
  }

  if (typeof value === "object") {
    if (depth >= MAX_LOG_DEPTH) return "[object]";
    const entries = Object.entries(value as Record<string, unknown>);
    const trimmed = entries.slice(0, MAX_LOG_COLLECTION_ITEMS);
    const result: Record<string, unknown> = {};
    for (const [k, v] of trimmed) {
      result[k] = sanitizeParamsForLog(v, depth + 1);
    }
    if (entries.length > MAX_LOG_COLLECTION_ITEMS) {
      result.__truncated_keys__ = `${entries.length - MAX_LOG_COLLECTION_ITEMS} more keys`;
    }
    return result;
  }

  return String(value);
}

function formatParamsForLog(params: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(sanitizeParamsForLog(params));
    if (!json) return "{}";
    return truncateLogString(json, MAX_LOG_JSON_CHARS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[unserializable params: ${truncateLogString(message)}]`;
  }
}

function formatParamsForDisplay(params: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(sanitizeParamsForLog(params), null, 2);
    if (!json) return "{}";
    return truncateLogString(json, MAX_LOG_JSON_CHARS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[unserializable params: ${truncateLogString(message)}]`;
  }
}

// ── ToolCallTracker ──────────────────────────────────────────────────────────

const COMPLETED_TTL_MS = 8_000;

// Interval for SSE heartbeat notifications to prevent client idle timeouts.
// Claude Code drops the POST SSE stream after ~2.5min of inactivity.
// Sending periodic notifications keeps data flowing on the stream.
const HEARTBEAT_INTERVAL_MS = 20_000; // 20 seconds

type McpHandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const FEEDBACK_TOOL_NAMES = new Set([
  "send_feedback",
  "get_feedback",
  "delete_feedback",
]);

// Auto-failure patterns that are not actionable — skip recording them.
// Each entry: [tool_name regex, error message regex]
const IGNORED_FAILURE_PATTERNS: Array<[RegExp, RegExp]> = [
  [/^read_file$/, /is a directory/i],
  // File/path not found — Claude passed a wrong path, not a tool bug
  [/^(read_file|list_files|search_files)$/, /no such file or directory/i],
  [/^read_file$/, /file not found/i],
  // apply_diff search block didn't match — Claude sent wrong search text or format
  [/^apply_diff$/, /search.*(not found|failed)/i],
  // Terminal closed between execute_command and get_terminal_output — expected lifecycle
  [/^get_terminal_output$/, /not found.*may have been closed/i],
];

export class ToolCallTracker extends EventEmitter {
  private activeCalls = new Map<string, TrackedCall>();
  private recentCalls = new Map<string, TrackedCallInfo>();
  private log: (msg: string) => void;
  private extensionVersion: string;
  private _defaultGate?: () => ToolResult | null;

  constructor(log?: (msg: string) => void, extensionVersion?: string) {
    super();
    this.log = log ?? (() => {});
    this.extensionVersion = extensionVersion ?? "unknown";
  }

  /**
   * Set a default gate function that wrapHandler captures at registration time.
   * The gate runs after a call is tracked as active but before the actual handler.
   * If the gate returns a ToolResult, the call is immediately marked as rejected.
   */
  setDefaultGate(gate: () => ToolResult | null): void {
    this._defaultGate = gate;
  }

  clearDefaultGate(): void {
    this._defaultGate = undefined;
  }

  getActiveCalls(): TrackedCallInfo[] {
    const active: TrackedCallInfo[] = [...this.activeCalls.values()].map(
      (c) => ({
        id: c.id,
        toolName: c.toolName,
        displayArgs: c.displayArgs,
        params: c.params,
        startedAt: c.startedAt,
        status: "active" as const,
        lastHeartbeatAt: c.lastHeartbeatAt,
        source: c.source,
      }),
    );
    const recent: TrackedCallInfo[] = [...this.recentCalls.values()];
    return [...active, ...recent];
  }

  private markCompleted(call: TrackedCall): void {
    const info: TrackedCallInfo = {
      id: call.id,
      toolName: call.toolName,
      displayArgs: call.displayArgs,
      params: call.params,
      startedAt: call.startedAt,
      status: "completed",
      completedAt: Date.now(),
      source: call.source,
    };
    this.recentCalls.set(call.id, info);
    setTimeout(() => {
      this.recentCalls.delete(call.id);
      this.emit("change");
    }, COMPLETED_TTL_MS);
  }

  setApprovalId(toolCallId: string, approvalId: string): void {
    const call = this.activeCalls.get(toolCallId);
    if (call) {
      call.approvalId = approvalId;
      this.log(
        `WAITING_APPROVAL ${call.toolName} (${toolCallId.slice(0, 8)}), approvalId=${approvalId.slice(0, 8)}`,
      );
    }
  }

  setTerminalId(toolCallId: string, terminalId: string): void {
    const call = this.activeCalls.get(toolCallId);
    if (call) {
      call.terminalId = terminalId;
      this.log(
        `TERMINAL_ASSIGNED ${call.toolName} (${toolCallId.slice(0, 8)}), terminalId=${terminalId}`,
      );
    }
  }

  // ── Agent call registration (lightweight — no wrapping) ──────────────────

  /**
   * Register an agent tool call so it appears in the sidebar's active tools list.
   * Unlike wrapHandler (used for MCP calls), the caller owns the actual tool
   * execution and passes a forceResolve hook that can be triggered from the
   * sidebar's Complete/Cancel buttons.
   */
  registerAgentCall(
    toolCallId: string,
    toolName: string,
    displayArgs: string,
    sessionId: string,
    forceResolve: (result: ToolResult) => void,
    params?: string,
  ): TrackerContext {
    const tracked: TrackedCall = {
      id: toolCallId,
      toolName,
      displayArgs,
      params,
      sessionId,
      startedAt: Date.now(),
      forceResolve,
      source: "agent",
    };
    this.activeCalls.set(toolCallId, tracked);
    this.log(
      `AGENT_START ${toolName} (${toolCallId.slice(0, 8)}), active=${this.activeCalls.size}`,
    );
    this.emit("change");
    return {
      toolCallId,
      setApprovalId: (approvalId) => this.setApprovalId(toolCallId, approvalId),
      setTerminalId: (terminalId) => this.setTerminalId(toolCallId, terminalId),
    };
  }

  /**
   * Mark an agent tool call as completed. Moves it to the recent list with TTL.
   */
  completeAgentCall(toolCallId: string): void {
    const call = this.activeCalls.get(toolCallId);
    if (!call) return;
    this.activeCalls.delete(toolCallId);
    this.markCompleted(call);
    this.log(
      `AGENT_END ${call.toolName} (${toolCallId.slice(0, 8)}), active=${this.activeCalls.size}, recent=${this.recentCalls.size}`,
    );
    this.emit("change");
  }

  /**
   * Remove all active agent calls for a given session (e.g. when the session is stopped).
   */
  clearAgentCalls(sessionId: string): void {
    let removed = 0;
    for (const [id, call] of this.activeCalls) {
      if (call.source === "agent" && call.sessionId === sessionId) {
        this.activeCalls.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      this.log(
        `AGENT_CLEAR sessionId=${sessionId.slice(0, 8)}, removed=${removed}, active=${this.activeCalls.size}`,
      );
      this.emit("change");
    }
  }

  /**
   * Wrap a tool handler with tracking.  Returns a new handler that:
   * 1. Registers the call in the active set
   * 2. Races the original handler against a force-resolve promise
   * 3. Sends periodic SSE heartbeat notifications to prevent client idle timeouts
   * 4. Cleans up in `finally`
   *
   * The returned handler accepts the MCP `extra` argument (second arg from
   * McpServer.tool()) to access `sendNotification` for heartbeating.
   */
  wrapHandler<P extends Record<string, unknown> = Record<string, unknown>>(
    toolName: string,
    handler: (params: P, trackerCtx: TrackerContext) => Promise<ToolResult>,
    extractDisplayArgs: (params: P) => string,
    getSessionId: () => string,
  ): (params: P, extra?: McpHandlerExtra) => Promise<ToolResult> {
    // Capture the gate at registration time so each session keeps its own gate
    // even though the tracker instance is shared across sessions.
    const gate = this._defaultGate;

    return async (params: P, extra?: McpHandlerExtra) => {
      const id = randomUUID();
      let forceResolve!: (result: ToolResult) => void;
      const forcePromise = new Promise<ToolResult>((resolve) => {
        forceResolve = resolve;
      });

      const paramsSummary = formatParamsForLog(params);
      const paramsDisplay = formatParamsForDisplay(params);
      const tracked: TrackedCall = {
        id,
        toolName,
        displayArgs: extractDisplayArgs(params),
        params: paramsDisplay,
        sessionId: getSessionId(),
        startedAt: Date.now(),
        forceResolve,
        source: "mcp",
      };

      const ctx: TrackerContext = {
        toolCallId: id,
        setApprovalId: (approvalId) => this.setApprovalId(id, approvalId),
        setTerminalId: (terminalId) => this.setTerminalId(id, terminalId),
      };

      this.activeCalls.set(id, tracked);
      this.log(
        `START ${toolName} (${id.slice(0, 8)}), active=${this.activeCalls.size}, listeners=${this.listenerCount("change")}, params=${paramsSummary}`,
      );
      this.emit("change");

      // Gate check — runs after tracking starts so rejected calls appear in the sidebar
      if (gate) {
        const gateResult = gate();
        if (gateResult) {
          this.log(
            `REJECTED ${toolName} (${id.slice(0, 8)}) — gate returned rejection`,
          );
          this.activeCalls.delete(id);
          const info: TrackedCallInfo = {
            id,
            toolName,
            displayArgs: tracked.displayArgs,
            params: tracked.params,
            startedAt: tracked.startedAt,
            status: "rejected",
            completedAt: Date.now(),
            source: "mcp",
          };
          this.recentCalls.set(id, info);
          setTimeout(() => {
            this.recentCalls.delete(id);
            this.emit("change");
          }, COMPLETED_TTL_MS);
          this.emit("change");
          return gateResult;
        }
      }

      // Start SSE heartbeat to prevent client idle timeouts (~2.5min).
      // Notifications sent via extra.sendNotification are routed to the
      // POST SSE stream (via relatedRequestId), keeping it alive.
      // Send an immediate first heartbeat so the connection stays alive
      // during approval waits (which can exceed the command timeout value).
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      if (extra?.sendNotification) {
        let tick = 0;
        const progressToken = extra._meta?.progressToken;

        // Immediate first heartbeat — prevents client-side timeout during approval
        const sendHeartbeat = async () => {
          tick++;
          try {
            if (progressToken) {
              await extra.sendNotification!({
                method: "notifications/progress",
                params: { progressToken, progress: tick },
              });
            } else {
              await extra.sendNotification!({
                method: "notifications/message",
                params: {
                  level: "debug",
                  logger: "agentlink",
                  data: `${toolName}: processing… (${tick * (HEARTBEAT_INTERVAL_MS / 1000)}s)`,
                },
              });
            }
            tracked.lastHeartbeatAt = Date.now();
            this.emit("change");
          } catch {
            // Connection gone — stop heartbeating
            if (heartbeat) clearInterval(heartbeat);
            heartbeat = undefined;
          }
        };

        // Send immediately, then continue on interval
        sendHeartbeat().catch(() => {});
        heartbeat = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
      }

      try {
        const result = await Promise.race([handler(params, ctx), forcePromise]);
        if (__DEV_BUILD__) {
          this.recordResultFailure(toolName, params, result, getSessionId());
        }
        return result;
      } catch (err) {
        if (__DEV_BUILD__) {
          this.recordExceptionFailure(toolName, params, err, getSessionId());
        }
        throw err;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        const completed = this.activeCalls.get(id);
        this.activeCalls.delete(id);
        if (completed) this.markCompleted(completed);
        this.log(
          `END ${toolName} (${id.slice(0, 8)}), active=${this.activeCalls.size}, recent=${this.recentCalls.size}`,
        );
        this.emit("change");
      }
    };
  }

  // ── Cancel ───────────────────────────────────────────────────────────────

  cancelCall(id: string, approvalPanel: ApprovalPanelProvider): void {
    const call = this.activeCalls.get(id);
    if (!call) {
      this.log(`CANCEL_MISS (${id.slice(0, 8)}) — not found in active calls`);
      return;
    }

    if (call.source === "agent") {
      this.log(`CANCEL_AGENT ${call.toolName} (${id.slice(0, 8)})`);
      if (call.terminalId) {
        this.log(`CANCEL_INTERRUPT terminal ${call.terminalId}`);
        import("../integrations/TerminalManager.js").then(
          ({ getTerminalManager }) => {
            getTerminalManager().interruptTerminal(call.terminalId!);
          },
          (err) => {
            this.log(`CANCEL_INTERRUPT import failed: ${err}`);
          },
        );
      }
      if (call.approvalId) {
        this.log(
          `CANCEL_APPROVAL ${call.toolName} (${id.slice(0, 8)}), approvalId=${call.approvalId.slice(0, 8)}`,
        );
        approvalPanel.cancelApproval(call.approvalId);
      }
      import("../integrations/DiffViewProvider.js").then(
        ({ resolveCurrentDiff }) => {
          resolveCurrentDiff("reject");
        },
        (err) => {
          this.log(`CANCEL_DIFF import failed: ${err}`);
        },
      );
      call.forceResolve(
        makeToolResult({
          status: "cancelled",
          tool: call.toolName,
          message: "Cancelled by user from VS Code",
        }),
      );
      return;
    }

    this.log(`CANCEL ${call.toolName} (${id.slice(0, 8)})`);

    // Kill the running terminal process if applicable
    if (call.terminalId) {
      this.log(`CANCEL_INTERRUPT terminal ${call.terminalId}`);
      import("../integrations/TerminalManager.js").then(
        ({ getTerminalManager }) => {
          getTerminalManager().interruptTerminal(call.terminalId!);
        },
        (err) => {
          this.log(`CANCEL_INTERRUPT import failed: ${err}`);
        },
      );
    }

    // Cancel any linked approval
    if (call.approvalId) {
      this.log(
        `CANCEL_APPROVAL ${call.toolName} (${id.slice(0, 8)}), approvalId=${call.approvalId.slice(0, 8)}`,
      );
      approvalPanel.cancelApproval(call.approvalId);
    }

    // Reject any pending diff
    import("../integrations/DiffViewProvider.js").then(
      ({ resolveCurrentDiff }) => {
        resolveCurrentDiff("reject");
      },
      (err) => {
        this.log(`CANCEL_DIFF import failed: ${err}`);
      },
    );

    // Force-resolve with cancelled result
    call.forceResolve(
      makeToolResult({
        status: "cancelled",
        tool: call.toolName,
        message: "Cancelled by user from VS Code",
      }),
    );
  }

  // ── Complete (smart recovery) ────────────────────────────────────────────

  async completeCall(
    id: string,
    approvalPanel: ApprovalPanelProvider,
  ): Promise<void> {
    const call = this.activeCalls.get(id);
    if (!call) {
      this.log(`COMPLETE_MISS (${id.slice(0, 8)}) — not found in active calls`);
      return;
    }

    if (call.source === "agent") {
      this.log(`COMPLETE_AGENT ${call.toolName} (${id.slice(0, 8)})`);
    }

    this.log(`COMPLETE ${call.toolName} (${id.slice(0, 8)})`);

    if (call.toolName === "execute_command") {
      await this.completeExecuteCommand(call);
      return;
    }

    if (call.toolName === "get_terminal_output") {
      await this.completeGetTerminalOutput(call);
      return;
    }

    if (call.toolName === "write_file" || call.toolName === "apply_diff") {
      await this.completeWriteTool(call);
      return;
    }

    // All other tools: cancel any approval, then force-resolve
    if (call.approvalId) {
      approvalPanel.cancelApproval(call.approvalId);
    }
    call.forceResolve(
      makeToolResult({
        status: "force-completed",
        tool: call.toolName,
        message: "Force-completed by user from VS Code",
      }),
    );
  }

  private async completeExecuteCommand(call: TrackedCall): Promise<void> {
    this.log(
      `COMPLETE_EXEC ${call.toolName} (${call.id.slice(0, 8)}), terminalId=${call.terminalId ?? "none"}`,
    );
    const { getTerminalManager } =
      await import("../integrations/TerminalManager.js");
    const tm = getTerminalManager();

    let partialOutput = "";
    if (call.terminalId) {
      partialOutput =
        tm.getCurrentOutput(call.terminalId, { force: true }) ?? "";
      this.log(`COMPLETE_EXEC output captured: ${partialOutput.length} chars`);
    }

    // Interrupt the running process
    if (call.terminalId) {
      this.log(`COMPLETE_EXEC interrupting terminal ${call.terminalId}`);
      tm.interruptTerminal(call.terminalId);
    }

    call.forceResolve(
      makeToolResult({
        exit_code: null,
        output: partialOutput || "[No output captured]",
        output_captured: !!partialOutput,
        terminal_id: call.terminalId ?? null,
        status: "force-completed",
        message: "Command force-completed by user. Process was interrupted.",
      }),
    );
  }

  private async completeGetTerminalOutput(call: TrackedCall): Promise<void> {
    // displayArgs is the terminal_id for get_terminal_output
    const terminalId = call.displayArgs;
    this.log(
      `COMPLETE_GET_OUTPUT ${call.toolName} (${call.id.slice(0, 8)}), terminalId=${terminalId}`,
    );

    const { getTerminalManager } =
      await import("../integrations/TerminalManager.js");
    const tm = getTerminalManager();
    const state = tm.getBackgroundState(terminalId);

    if (!state) {
      // Terminal not in managed list — try force-reading output as last resort
      const directOutput = tm.getCurrentOutput(terminalId, { force: true });
      call.forceResolve(
        makeToolResult(
          directOutput
            ? {
                terminal_id: terminalId,
                is_running: false,
                exit_code: null,
                output_captured: true,
                output: directOutput,
                status: "force-completed",
                message:
                  "Output returned immediately — wait was interrupted by user.",
              }
            : {
                error: `Terminal "${terminalId}" not found. It may have been closed.`,
              },
        ),
      );
      return;
    }

    // Use background state output when captured, otherwise force-read
    // the output buffer directly (covers foreground terminals that were
    // never transitioned to background mode).
    const output = state.output_captured
      ? state.output
      : (tm.getCurrentOutput(terminalId, { force: true }) ?? "");

    call.forceResolve(
      makeToolResult({
        terminal_id: terminalId,
        is_running: state.is_running,
        exit_code: state.exit_code,
        output_captured: state.output_captured || !!output,
        output: output || "[No output captured]",
        status: "force-completed",
        message: "Output returned immediately — wait was interrupted by user.",
        ...(!state.output_captured &&
          !output && {
            verification_hint:
              `Terminal_id "${terminalId}" did not have shell integration capture available. ` +
              "Use the visible terminal to verify command state rather than re-running it.",
          }),
      }),
    );
  }

  private async completeWriteTool(call: TrackedCall): Promise<void> {
    this.log(`COMPLETE_WRITE ${call.toolName} (${call.id.slice(0, 8)})`);
    const { resolveCurrentDiff } =
      await import("../integrations/DiffViewProvider.js");

    // Try to auto-accept the pending diff — if successful the original
    // handler will complete naturally through saveChanges().
    if (resolveCurrentDiff("accept")) {
      this.log(`COMPLETE_WRITE auto-accepted diff for ${call.toolName}`);
      return; // Original handler wins the Promise.race
    }
    this.log(
      `COMPLETE_WRITE no pending diff, force-resolving ${call.toolName}`,
    );

    // No pending diff — force-resolve with fallback
    call.forceResolve(
      makeToolResult({
        status: "force-completed",
        path: call.displayArgs,
        message:
          "No pending diff to accept — file may already be saved or approval was not yet shown",
      }),
    );
  }

  // ── Auto-failure feedback (dev builds only) ──────────────────────────────

  /**
   * Check a tool result for error indicators and record feedback automatically.
   * Detects results where the JSON payload contains an `"error"` key.
   */
  private recordResultFailure(
    toolName: string,
    params: Record<string, unknown>,
    result: ToolResult,
    sessionId: string,
  ): void {
    if (FEEDBACK_TOOL_NAMES.has(toolName)) return;

    const firstText = result.content?.find((c) => c.type === "text");
    if (!firstText || firstText.type !== "text") return;

    try {
      const parsed = JSON.parse(firstText.text);
      if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return;

      const errorStr = String(parsed.error);
      const isIgnored = IGNORED_FAILURE_PATTERNS.some(
        ([toolRe, errRe]) => toolRe.test(toolName) && errRe.test(errorStr),
      );
      if (isIgnored) return;

      this.appendAutoFeedback(toolName, params, sessionId, {
        feedback: `[auto-failure] Tool returned error: ${String(parsed.error).slice(0, 500)}`,
        tool_result_summary: firstText.text.slice(0, 500),
      });
    } catch {
      // Not JSON or parse error — skip
    }
  }

  /**
   * Record feedback when a tool handler throws an unhandled exception.
   */
  private recordExceptionFailure(
    toolName: string,
    params: Record<string, unknown>,
    err: unknown,
    sessionId: string,
  ): void {
    if (FEEDBACK_TOOL_NAMES.has(toolName)) return;

    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? message) : String(err);

    this.appendAutoFeedback(toolName, params, sessionId, {
      feedback: `[auto-exception] Unhandled exception: ${message.slice(0, 500)}`,
      tool_result_summary: stack.slice(0, 500),
    });
  }

  private appendAutoFeedback(
    toolName: string,
    params: Record<string, unknown>,
    sessionId: string,
    extra: { feedback: string; tool_result_summary?: string },
  ): void {
    try {
      appendFeedback({
        timestamp: new Date().toISOString(),
        tool_name: toolName,
        feedback: extra.feedback,
        session_id: sessionId,
        extension_version: this.extensionVersion,
        tool_params: formatParamsForLog(params),
        tool_result_summary: extra.tool_result_summary,
      });
      this.log(`AUTO_FEEDBACK ${toolName}: ${extra.feedback.slice(0, 100)}`);
    } catch {
      // Don't let feedback recording break tool calls
    }
  }
}
