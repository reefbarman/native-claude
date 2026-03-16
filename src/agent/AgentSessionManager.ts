import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { AgentConfig, SessionInfo } from "./types.js";
import { hasPendingTodos, todoTool, type TodoItem } from "./todoTool.js";
import { AgentSession } from "./AgentSession.js";
import { AgentEngine } from "./AgentEngine.js";
import type { AgentEvent } from "./types.js";
import type { AgentMode } from "./modes.js";
import {
  getAgentTools,
  type ToolDispatchContext,
  type BgStatusResult,
  type QuestionResponse,
} from "./toolAdapter.js";
import type { Question } from "./webview/types.js";
import type { SessionStore, SessionSummary } from "./SessionStore.js";
import type { BgSessionInfo } from "../shared/types.js";
import {
  CheckpointManager,
  type Checkpoint,
  type RevertPreview,
} from "./CheckpointManager.js";
import { providerRegistry } from "./providers/index.js";
import { resolveBackgroundRoute } from "./backgroundModelRouter.js";
import {
  getConfiguredBaseThresholdForModel,
  getEffectiveAutoCondenseThreshold,
} from "./modelCondenseThresholds.js";
import type {
  SpawnBackgroundRequest,
  SpawnBackgroundResult,
} from "./backgroundTypes.js";

export class AgentSessionManager {
  private sessions = new Map<string, AgentSession>();
  private foregroundId: string | null = null;
  private engine: AgentEngine | null = null;
  private config: AgentConfig;
  private cwd: string;
  private apiKey?: string;
  private toolCtx?: ToolDispatchContext;
  private devMode: boolean;
  private store?: SessionStore;
  private log?: (msg: string) => void;

  /** CheckpointManager shared across sessions (one shadow repo per workspace) */
  private checkpointManager: CheckpointManager | null = null;
  /** Checkpoints per session: sessionId → Checkpoint[] */
  private checkpoints = new Map<string, Checkpoint[]>();
  /** Pending waiters for background session completion: sessionId → resolvers */
  private bgResultWaiters = new Map<string, Array<(result: string) => void>>();
  /** Stored final results for completed bg sessions (prevents race in waitForBackground). */
  private bgFinalResults = new Map<string, string>();
  /** Safety timers per bg session (cleared on normal completion). */
  private bgSafetyTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  /** Accumulated streaming text for background sessions (for UI preview). */
  private bgStreamingText = new Map<string, string>();
  /** Completion timestamps for background sessions (for auto-dismiss). */
  private bgCompletedAt = new Map<string, number>();
  /** Error messages for background sessions. */
  private bgErrors = new Map<string, string>();
  /** Set of bg session IDs that were explicitly cancelled by the user. */
  private bgCancelled = new Set<string>();
  /** Foreground session that launched each background session. */
  private bgParents = new Map<
    string,
    {
      sessionId: string;
      task: string;
    }
  >();
  /** Background sessions already used to auto-resume a foreground session. */
  private bgAutoResumed = new Set<string>();
  /** Routing metadata per background session. */
  private bgMeta = new Map<
    string,
    {
      resolvedMode: string;
      resolvedModel: string;
      resolvedProvider: string;
      taskClass: string;
      routingReason: string;
      fallbackUsed: boolean;
      toolCalls: number;
      tokenUsage: number;
    }
  >();

  /** Callback invoked with each event from the running agent */
  onEvent?: (sessionId: string, event: AgentEvent) => void;

  /** Callback when a background agent's question is answered by the foreground agent */
  onBgQuestionAnswered?: (
    fgSessionId: string,
    bgTask: string,
    questions: Question[],
    answer: string,
  ) => void;

  /** Callback when session list changes */
  onSessionsChanged?: () => void;

  constructor(
    config: AgentConfig,
    cwd: string,
    apiKey?: string,
    devMode?: boolean,
    store?: SessionStore,
    log?: (msg: string) => void,
    private readonly bgDefaults: {
      maxConcurrent: number;
    } = {
      maxConcurrent: 3,
    },
  ) {
    this.config = config;
    this.cwd = cwd;
    this.apiKey = apiKey;
    this.devMode = devMode ?? false;
    this.store = store;
    this.log = log;

    // Initialize checkpoint manager asynchronously — failures are non-fatal
    this.checkpointManager = new CheckpointManager({
      workspaceDir: cwd,
      taskId: "agent",
      log: (msg) => log?.(msg),
    });
    this.checkpointManager.initialize().catch((err) => {
      log?.(`[checkpoint] Init error: ${err}`);
    });
  }

  setToolContext(ctx: ToolDispatchContext): void {
    this.toolCtx = ctx;
    if (this.engine) {
      this.engine.setToolContext(ctx);
    }
  }

  private getEngine(): AgentEngine {
    if (!this.engine) {
      this.engine = new AgentEngine(providerRegistry, this.log);
      if (this.toolCtx) {
        this.engine.setToolContext(this.toolCtx);
      }
    }
    return this.engine;
  }

  updateConfig(config: Partial<AgentConfig>): void {
    Object.assign(this.config, config);
  }

  private getCondenseThresholdForModel(model: string): number {
    try {
      return getConfiguredBaseThresholdForModel(
        vscode.workspace.getConfiguration("agentlink"),
        model,
      );
    } catch (err) {
      this.log?.(
        `[agent] Failed to resolve configured condense threshold for ${model}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return getEffectiveAutoCondenseThreshold(model);
    }
  }

  private buildConfigForModel(model: string): AgentConfig {
    return {
      ...this.config,
      model,
      autoCondenseThreshold: this.getCondenseThresholdForModel(model),
    };
  }

  private applyThresholdToSession(session: AgentSession): void {
    session.autoCondenseThreshold = this.getCondenseThresholdForModel(
      session.model,
    );
  }

  getConfig(): AgentConfig {
    return this.config;
  }

  async createSession(
    mode: string,
    opts?: { activeFilePath?: string },
  ): Promise<AgentSession> {
    const config = this.buildConfigForModel(this.config.model);
    const providerId = providerRegistry.tryResolveProvider(config.model)?.id;
    const session = await AgentSession.create({
      mode,
      config,
      cwd: this.cwd,
      devMode: this.devMode,
      activeFilePath: opts?.activeFilePath,
      providerId,
    });
    this.sessions.set(session.id, session);
    this.foregroundId = session.id;
    this.onSessionsChanged?.();
    return session;
  }

  /**
   * Rebuild the system prompt for all active foreground sessions.
   * Called when instruction files (AGENTS.md, CLAUDE.md, etc.) change on disk.
   */
  async rebuildSystemPrompts(): Promise<void> {
    const fg = this.getForegroundSession();
    if (!fg) return;
    await fg.rebuildSystemPrompt({ devMode: this.devMode });
  }

  /**
   * Update the model on the active foreground session.
   * If the model crosses a provider boundary (e.g. Anthropic → Codex),
   * updates the session's providerId and rebuilds the system prompt so
   * provider-specific behavioral tuning takes effect.
   */
  async setModel(model: string): Promise<void> {
    this.updateConfig({
      model,
      autoCondenseThreshold: this.getCondenseThresholdForModel(model),
    });
    const fg = this.getForegroundSession();
    if (!fg) return;

    fg.model = model;
    this.applyThresholdToSession(fg);
    const newProviderId = providerRegistry.tryResolveProvider(model)?.id;
    if (newProviderId !== fg.providerId) {
      fg.providerId = newProviderId;
      await fg.rebuildSystemPrompt({ devMode: this.devMode });
    }
    await this.maybeAutoCondenseForegroundSession();
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  saveSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      this.store?.save(session);
    }
  }

  getForegroundSession(): AgentSession | undefined {
    return this.foregroundId ? this.sessions.get(this.foregroundId) : undefined;
  }

  getSessionInfos(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      status: s.status,
      mode: s.mode,
      model: s.model,
      title: s.title,
      messageCount: s.messageCount,
      totalInputTokens: s.totalInputTokens,
      totalOutputTokens: s.totalOutputTokens,
      background: s.background,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
    }));
  }

  async sendMessage(
    sessionId: string | undefined,
    text: string,
    mode: string,
    opts?: {
      thinkingEnabled?: boolean;
      activeFilePath?: string;
      images?: Array<{ name: string; mimeType: string; base64: string }>;
      documents?: Array<{ name: string; mimeType: string; base64: string }>;
    },
  ): Promise<void> {
    let session: AgentSession;

    if (sessionId && this.sessions.has(sessionId)) {
      session = this.sessions.get(sessionId)!;
    } else {
      session = await this.createSession(mode, {
        activeFilePath: opts?.activeFilePath,
      });
    }

    // Update thinking budget based on toggle (0 = disabled)
    if (opts?.thinkingEnabled === false) {
      session.thinkingBudget = 0;
    } else if (session.thinkingBudget === 0) {
      // Re-enable with config default
      session.thinkingBudget = this.config.thinkingBudget;
    }

    // Create checkpoint before adding user message, but only for messages after
    // the first — the first message has no prior state worth restoring to.
    // turnIndex is the 0-based index of this human user message in the sequence
    // of human user messages (not counting tool-result messages that also have
    // role "user"). The UI's SET_CHECKPOINT reducer counts messages the same way.
    const turnIndex = session
      .getAllMessages()
      .filter((m) => m.role === "user" && typeof m.content === "string").length;
    const checkpoint =
      turnIndex > 0
        ? ((await this.checkpointManager?.createCheckpoint(turnIndex)) ?? null)
        : null;
    if (checkpoint) {
      const existing = this.checkpoints.get(session.id) ?? [];
      existing.push(checkpoint);
      this.checkpoints.set(session.id, existing);
      this.onEvent?.(session.id, {
        type: "checkpoint_created",
        checkpointId: checkpoint.id,
        turnIndex,
      });
    }

    // Clear any stale pending interjection from the previous run — if the
    // webview already drained the queue and sent this message via agentSend,
    // the old interjection would otherwise be re-emitted mid-turn as a duplicate.
    session.consumePendingInterjection();
    session.addUserMessage(text);

    // Store pasted images/PDFs bound to the just-added user message index.
    // These are injected into the API call by AgentEngine, not stored in history.
    const msgIndex = session.messageCount - 1;
    session.setPendingMedia(msgIndex, opts?.images, opts?.documents);

    session.status = "streaming";

    if (session.messageCount === 1) {
      session.autoTitle();
    }

    // Persist immediately so the session appears in history even if the
    // API call fails (e.g. network error, auth failure on the first message).
    this.store?.save(session);

    this.onSessionsChanged?.();

    const MAX_AUTO_CONTINUE = 5;
    let autoContinueCount = 0;
    let lastTodos: TodoItem[] = [];

    try {
      while (true) {
        let naturalDone = false;
        for await (const event of this.getEngine().run(session)) {
          if (event.type === "todo_update") {
            lastTodos = event.todos;
          }
          if (event.type === "done") {
            this.store?.save(session);
            naturalDone = true;
            // Don't forward yet — check for pending todos first
            continue;
          }
          this.onEvent?.(session.id, event);
        }

        // Aborted — let ChatViewProvider handle the done notification
        if (session.isAborted) break;

        const pendingModeResume =
          naturalDone && autoContinueCount < MAX_AUTO_CONTINUE
            ? session.consumePendingModeResume()
            : null;
        if (pendingModeResume) {
          autoContinueCount++;
          const reason = pendingModeResume.reason?.trim();
          const followUp = pendingModeResume.followUp?.trim();
          const details = [
            `You just switched this session to ${pendingModeResume.mode} mode.`,
            "Continue immediately in the new mode and start the next concrete implementation step now.",
          ];
          if (reason) {
            details.push(`Switch reason: ${reason}`);
          }
          if (followUp) {
            details.push(`User follow-up: ${followUp}`);
          }
          this.log?.(
            `[agent] auto-continuing (${autoContinueCount}/${MAX_AUTO_CONTINUE}): resumed after switch to ${pendingModeResume.mode}`,
          );
          session.addUserMessage(details.join("\n"));
          session.status = "streaming";
          continue;
        }

        // Check if we should auto-continue due to pending todos
        if (
          naturalDone &&
          autoContinueCount < MAX_AUTO_CONTINUE &&
          hasPendingTodos(lastTodos)
        ) {
          autoContinueCount++;
          this.log?.(
            `[agent] auto-continuing (${autoContinueCount}/${MAX_AUTO_CONTINUE}): pending todos remain`,
          );
          session.addUserMessage(
            "You stopped but there are still pending tasks. Continue with the remaining items.",
          );
          session.status = "streaming";
          continue;
        }

        // Emit the deferred done
        this.onEvent?.(session.id, {
          type: "done",
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          totalCacheReadTokens: session.totalCacheReadTokens,
          totalCacheCreationTokens: session.totalCacheCreationTokens,
        });
        break;
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      session.status = "error";
      this.onEvent?.(session.id, { type: "error", error, retryable: false });
      // Persist before emitting done so sendSessionList sees the saved session
      this.store?.save(session);
      this.onEvent?.(session.id, {
        type: "done",
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalCacheReadTokens: session.totalCacheReadTokens,
        totalCacheCreationTokens: session.totalCacheCreationTokens,
      });
    }

    this.onSessionsChanged?.();
  }

  /**
   * Kill a running background agent and return its partial output.
   * Called by the foreground agent via the kill_background_agent tool.
   */
  killBackground(
    sessionId: string,
    reason?: string,
  ): { killed: boolean; partialOutput?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { killed: false, partialOutput: "Session not found" };
    }
    if (!session.background) {
      return { killed: false, partialOutput: "Not a background session" };
    }
    const isRunning =
      session.status === "streaming" ||
      session.status === "tool_executing" ||
      session.status === "awaiting_approval";
    if (!isRunning) {
      return {
        killed: false,
        partialOutput:
          session.getLastAssistantText() ??
          "(background agent already finished)",
      };
    }

    this.log?.(
      `[bg-kill] session=${sessionId} reason="${reason ?? "no reason"}"`,
    );

    // Capture partial output before stopping
    const partialOutput =
      session.getLastAssistantText() ??
      this.bgStreamingText.get(sessionId) ??
      "(no output captured)";

    // Stop the session (marks as cancelled, aborts, resolves waiters)
    this.stopSession(sessionId);

    return { killed: true, partialOutput };
  }

  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.abort();
      session.status = "idle";
      // Mark bg sessions as cancelled so the UI can distinguish stop vs complete
      if (session.background) {
        this.bgCancelled.add(sessionId);
        this.markBgCompleted(sessionId);
      }
      this.onSessionsChanged?.();
    }
  }

  /**
   * Retry the last turn of a session after an error (e.g. auth failure).
   * Re-creates the engine (which re-reads credentials) and re-runs the agent loop.
   */
  async retrySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Force re-creation of the engine so it picks up refreshed credentials
    this.engine = null;

    session.status = "streaming";
    this.onSessionsChanged?.();

    try {
      for await (const event of this.getEngine().run(session)) {
        if (event.type === "done") {
          this.store?.save(session);
        }
        this.onEvent?.(session.id, event);
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      session.status = "error";
      this.onEvent?.(session.id, { type: "error", error, retryable: false });
      this.store?.save(session);
      this.onEvent?.(session.id, {
        type: "done",
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalCacheReadTokens: session.totalCacheReadTokens,
        totalCacheCreationTokens: session.totalCacheCreationTokens,
      });
    }

    this.onSessionsChanged?.();
  }

  switchTo(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.foregroundId = sessionId;
      this.onSessionsChanged?.();
    }
  }

  /**
   * Switch the current foreground session to a different mode in-place,
   * preserving its message history and session ID.
   */
  async switchForegroundMode(
    mode: string,
    opts?: { agentMode?: AgentMode; devMode?: boolean },
  ): Promise<AgentSession | null> {
    const session = this.getForegroundSession();
    if (!session) return null;

    await session.setMode(mode, opts);
    this.onSessionsChanged?.();
    this.store?.save(session);
    return session;
  }

  queueModeSwitchResume(
    sessionId: string,
    mode: string,
    opts?: { reason?: string; followUp?: string },
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.background) return;
    session.queuePendingModeResume(mode, opts);
  }

  /**
   * Manually condense the foreground session's context.
   * Emits condense or condense_error events via onEvent.
   */
  private buildPreservedContext(session: AgentSession): {
    toolNames: string[];
    mcpServerNames: string[];
  } {
    const mcpToolDefs = this.toolCtx?.mcpHub?.getToolDefs() ?? [];
    const rawTools = this.toolCtx
      ? [...getAgentTools(session.agentMode, mcpToolDefs, false), todoTool]
      : undefined;
    return {
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
  }

  private async condenseSession(
    session: AgentSession,
    isAutomatic: boolean,
  ): Promise<void> {
    const engine = this.getEngine();
    const preservedContext = this.buildPreservedContext(session);
    session.status = "streaming";
    this.onSessionsChanged?.();

    try {
      for await (const event of engine.condenseSession(
        session,
        isAutomatic,
        undefined,
        preservedContext,
      )) {
        this.onEvent?.(session.id, event);
      }
      this.store?.save(session);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      this.onEvent?.(session.id, { type: "condense_error", error });
    } finally {
      session.status = "idle";
      this.onSessionsChanged?.();
    }
  }

  async condenseCurrentSession(): Promise<void> {
    const session = this.getForegroundSession();
    if (!session) return;
    await this.condenseSession(session, false);
  }

  async maybeAutoCondenseForegroundSession(): Promise<void> {
    const session = this.getForegroundSession();
    if (!session || session.background) return;
    if (session.status !== "idle") return;
    if (!this.getEngine().isOverCondenseThreshold(session)) return;
    await this.condenseSession(session, true);
  }

  // ---------------------------------------------------------------------------
  // Checkpoints
  // ---------------------------------------------------------------------------

  /** Return all checkpoints for a session, in creation order. */
  getCheckpoints(sessionId: string): Checkpoint[] {
    return this.checkpoints.get(sessionId) ?? [];
  }

  /**
   * Create a checkpoint for the current workspace/session state on demand.
   * Returns null when no foreground session exists or checkpoint creation fails.
   */
  async createManualCheckpoint(): Promise<Checkpoint | null> {
    const session = this.getForegroundSession();
    if (!session || !this.checkpointManager) return null;

    const turnIndex = session
      .getAllMessages()
      .filter((m) => m.role === "user" && typeof m.content === "string").length;
    if (turnIndex === 0) return null;

    const checkpoint = await this.checkpointManager.createCheckpoint(turnIndex);
    if (!checkpoint) return null;

    const existing = this.checkpoints.get(session.id) ?? [];
    existing.push(checkpoint);
    this.checkpoints.set(session.id, existing);
    return checkpoint;
  }

  /**
   * Preview the files that would be affected by reverting to a checkpoint.
   */
  async previewRevert(
    sessionId: string,
    checkpointId: string,
  ): Promise<RevertPreview | null> {
    const checkpoint = this.findCheckpoint(sessionId, checkpointId);
    if (!checkpoint || !this.checkpointManager) return null;
    return this.checkpointManager.previewRevert(checkpoint);
  }

  /**
   * Revert workspace files to the state at `checkpointId`, then truncate the
   * session's message history to that turn.
   *
   * Returns true on success.
   */
  async revertToCheckpoint(
    sessionId: string,
    checkpointId: string,
  ): Promise<boolean> {
    const checkpoint = this.findCheckpoint(sessionId, checkpointId);
    if (!checkpoint || !this.checkpointManager) return false;

    const session = this.sessions.get(sessionId);

    const ok = await this.checkpointManager.revertToCheckpoint(checkpoint);
    if (!ok) return false;

    // Truncate conversation history to the turn that was checkpointed
    if (session) {
      const allMessages = session.getAllMessages();
      // Keep messages up to (but not including) the user message at turnIndex
      const truncated = allMessages.slice(0, checkpoint.turnIndex);
      session.replaceMessages(truncated);
      session.status = "idle";
    }

    // Remove checkpoints created after this one
    const existingCheckpoints = this.checkpoints.get(sessionId) ?? [];
    const idx = existingCheckpoints.findIndex((c) => c.id === checkpointId);
    if (idx !== -1) {
      this.checkpoints.set(sessionId, existingCheckpoints.slice(0, idx + 1));
    }

    this.onSessionsChanged?.();
    return true;
  }

  /**
   * Get the diff from the shadow repo at a given checkpoint.
   * @param scope "turn" = diff since the previous checkpoint (or base), "all" = diff since session start
   */
  async getCheckpointDiff(
    sessionId: string,
    checkpointId: string,
    scope: "turn" | "all",
  ): Promise<string> {
    const checkpoint = this.findCheckpoint(sessionId, checkpointId);
    if (!checkpoint || !this.checkpointManager) return "";

    const baseHash = this.checkpointManager.baseCommit;
    if (!baseHash) return "";

    if (scope === "all") {
      return this.checkpointManager.getDiffBetween(
        baseHash,
        checkpoint.commitHash,
      );
    }

    // "turn" scope: diff from the previous checkpoint to this one
    const all = this.checkpoints.get(sessionId) ?? [];
    const idx = all.findIndex((c) => c.id === checkpointId);
    const fromHash = idx > 0 ? all[idx - 1].commitHash : baseHash;
    return this.checkpointManager.getDiffBetween(
      fromHash,
      checkpoint.commitHash,
    );
  }

  private findCheckpoint(
    sessionId: string,
    checkpointId: string,
  ): Checkpoint | undefined {
    return this.checkpoints.get(sessionId)?.find((c) => c.id === checkpointId);
  }

  // ---------------------------------------------------------------------------
  // Session history (delegates to SessionStore)
  // ---------------------------------------------------------------------------

  /** List all persisted sessions, most-recent first. */
  listPersistedSessions(): SessionSummary[] {
    return this.store?.list() ?? [];
  }

  /**
   * Load a persisted session's message history into memory and make it the
   * foreground session. Returns the loaded session or null if not found.
   */
  async loadPersistedSession(sessionId: string): Promise<AgentSession | null> {
    if (!this.store) return null;

    const summary = this.store.get(sessionId);
    if (!summary) return null;

    const messages = this.store.loadMessages(sessionId);
    if (!messages) return null;
    const metadata = this.store.loadMetadata(sessionId);

    // Reuse in-memory session if already loaded
    if (this.sessions.has(sessionId)) {
      this.foregroundId = sessionId;
      this.onSessionsChanged?.();
      return this.sessions.get(sessionId)!;
    }

    // Reconstruct session from persisted data
    const providerId = providerRegistry.tryResolveProvider(summary.model)?.id;
    const session = await AgentSession.create({
      mode: summary.mode,
      config: this.buildConfigForModel(summary.model),
      cwd: this.cwd,
      devMode: this.devMode,
      providerId,
    });

    // Restore persisted state
    session.restoreFromStore({
      id: sessionId,
      title: summary.title,
      createdAt: summary.createdAt,
      lastActiveAt: summary.lastActiveAt,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      totalCacheReadTokens: metadata?.totalCacheReadTokens ?? 0,
      totalCacheCreationTokens: metadata?.totalCacheCreationTokens ?? 0,
      lastInputTokens: metadata?.lastInputTokens ?? 0,
      // Use 0 for resumed sessions so cache-aware threshold isn't biased by stale prior runs.
      lastCacheReadTokens: 0,
      messages,
    });

    this.sessions.set(sessionId, session);
    this.foregroundId = sessionId;
    this.onSessionsChanged?.();
    return session;
  }

  /**
   * Restore the most recently active persisted session as the foreground session.
   * Called on startup so the last chat is visible after a reload or panel move.
   * Returns the loaded session or null if there are no persisted sessions.
   */
  async restoreLastSession(): Promise<AgentSession | null> {
    if (!this.store) return null;
    const sessions = this.store.list();
    if (sessions.length === 0) return null;
    // Abort restore if the user started a foreground session while startup restore
    // was still in flight. This keeps auto-restore from stealing focus back.
    if (this.foregroundId) return null;
    const targetSessionId = sessions[0].id;
    const session = await this.loadPersistedSession(targetSessionId);
    if (!session) return null;
    if (this.foregroundId !== targetSessionId) {
      return null;
    }
    return session;
  }

  deletePersistedSession(sessionId: string): boolean {
    const deleted = this.store?.delete(sessionId) ?? false;
    // Also remove from in-memory map if loaded
    if (deleted && this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      if (this.foregroundId === sessionId) {
        this.foregroundId = null;
      }
      this.onSessionsChanged?.();
    }
    return deleted;
  }

  renamePersistedSession(sessionId: string, title: string): boolean {
    const renamed = this.store?.rename(sessionId, title) ?? false;
    // Also update in-memory session if loaded
    if (renamed) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.title = title;
      }
      this.onSessionsChanged?.();
    }
    return renamed;
  }

  /**
   * Return the text of the first user message for a persisted session.
   * Used by "Copy First Prompt" to prefill a new session.
   */
  loadFirstPrompt(sessionId: string): string | null {
    // Try in-memory first
    const live = this.sessions.get(sessionId);
    if (live) {
      const first = live.getAllMessages()[0];
      if (first?.role === "user" && typeof first.content === "string") {
        return first.content;
      }
    }

    // Fall back to disk
    const messages = this.store?.loadMessages(sessionId);
    if (!messages) return null;
    const first = messages[0];
    if (first?.role === "user" && typeof first.content === "string") {
      return first.content;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Background agents
  // ---------------------------------------------------------------------------

  /**
   * Answer a background agent's ask_user call by routing it through the
   * foreground agent instead of directly to the user. The foreground agent
   * sees the question as an injected user message and can answer autonomously
   * or use its own ask_user to forward the question to the actual user.
   *
   * When the foreground is mid-turn (streaming/tool_executing), the question is
   * injected as an interjection so it gets answered within the current turn —
   * avoiding the overhead of waiting for idle then starting a new full turn.
   * Falls back to a dedicated sendMessage call when the foreground is idle or
   * the interjection slot is already occupied.
   */
  private async askForegroundAgent(
    bgTask: string,
    questions: Question[],
    _bgSessionId: string,
  ): Promise<QuestionResponse> {
    const fg = this.getForegroundSession();

    // If no foreground session exists or no engine is running, fall back to
    // the base onQuestion (which goes to the user directly).
    if (!fg || !this.toolCtx?.onQuestion) {
      if (this.toolCtx?.onQuestion) {
        return this.toolCtx.onQuestion(questions, _bgSessionId);
      }
      const fallback: QuestionResponse = {
        answers: Object.fromEntries(
          questions.map((q) => [q.id, "(no foreground agent available)"]),
        ),
        notes: {},
      };
      return fallback;
    }

    // Format the background agent's questions as a user message.
    const questionLines = questions
      .map((q, i) => `${i + 1}. ${q.question}`)
      .join("\n");
    const prompt =
      `[Background agent "${bgTask}" is asking]\n\n${questionLines}\n\n` +
      `Please answer these questions. You can use ask_user if you need input from the user.`;

    const fgId = fg.id;
    const fgMode = fg.mode;
    const isBusy =
      fg.status === "streaming" ||
      fg.status === "tool_executing" ||
      fg.status === "awaiting_approval";

    if (isBusy) {
      // Try the interjection fast-path: inject the question into the running
      // turn so the engine picks it up between tool batches or before the next
      // API call. If the slot is already occupied (user queued a message),
      // fall through to the wait-then-sendMessage path.
      const queueId = `bg-q-${randomUUID()}`;
      const accepted = fg.setPendingInterjection(prompt, queueId);

      if (accepted) {
        // Wait for the foreground turn to complete (event-driven, up to 2 min).
        const reachedIdle = await this.waitForForegroundIdle(fg, 120_000);

        if (fg.hasPendingInterjection(queueId)) {
          // Race condition: foreground went idle between our isBusy check and
          // the engine consuming the interjection. Clear it and fall back to
          // a dedicated turn so the question isn't lost.
          fg.clearPendingInterjectionIf(queueId);
          await this.sendFgQuestionTurn(fgId, fgMode, prompt);
        } else if (!reachedIdle) {
          // Timeout — foreground is still busy. Don't start a concurrent run.
          // Return a timeout notice so the bg agent knows to retry or proceed.
          this.log?.(
            `[bg-q] timeout waiting for fg to finish (task="${bgTask}")`,
          );
          const timeoutResponse = "(foreground agent timed out answering)";
          return {
            answers: Object.fromEntries(
              questions.map((q) => [q.id, timeoutResponse]),
            ),
            notes: {},
          };
        }
        // else: interjection was consumed and fg finished — answer is in the response
      } else {
        // Slot occupied — wait for idle (event-driven), then sendMessage.
        const reachedIdle = await this.waitForForegroundIdle(fg, 120_000);
        if (!reachedIdle) {
          const timeoutResponse = "(foreground agent timed out answering)";
          return {
            answers: Object.fromEntries(
              questions.map((q) => [q.id, timeoutResponse]),
            ),
            notes: {},
          };
        }
        await this.sendFgQuestionTurn(fgId, fgMode, prompt);
      }
    } else {
      // Foreground is idle — run a dedicated turn with event suppression.
      await this.sendFgQuestionTurn(fgId, fgMode, prompt);
    }

    // Build a QuestionResponse from the foreground's last text reply.
    const responseText =
      this.getForegroundSession()?.getLastAssistantText() ??
      "(no response from foreground agent)";

    // Notify the UI so it can render a collapsible Q&A block.
    this.onBgQuestionAnswered?.(fgId, bgTask, questions, responseText);

    return {
      answers: Object.fromEntries(questions.map((q) => [q.id, responseText])),
      notes: {},
    };
  }

  /**
   * Wait for the foreground session to become idle, using event-driven
   * notification instead of polling.
   * Returns true if idle was reached, false on timeout.
   */
  private async waitForForegroundIdle(
    fg: AgentSession,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (
      fg.status === "streaming" ||
      fg.status === "tool_executing" ||
      fg.status === "awaiting_approval"
    ) {
      if (Date.now() >= deadline) return false;
      // Use an AbortController so the listener is cleaned up when the
      // timeout wins the race — prevents listener accumulation.
      const ac = new AbortController();
      const remaining = deadline - Date.now();
      const guard = Math.min(remaining, 5_000);
      await Promise.race([
        fg.waitForStatusChange(ac.signal),
        new Promise<void>((r) => setTimeout(r, guard)),
      ]);
      ac.abort();
    }
    return true;
  }

  /**
   * Run a foreground turn to answer a bg question, with event suppression
   * so it renders as a collapsible Q&A block instead of inline chat.
   */
  private async sendFgQuestionTurn(
    fgId: string,
    fgMode: string,
    prompt: string,
  ): Promise<void> {
    const savedOnEvent = this.onEvent;
    this.onEvent = (sessionId, event) => {
      if (sessionId !== fgId) savedOnEvent?.(sessionId, event);
    };
    try {
      await this.sendMessage(fgId, prompt, fgMode);
    } finally {
      this.onEvent = savedOnEvent;
    }
  }

  /**
   * Spawn a background agent session and return the resolved routing metadata.
   */
  async spawnBackground(
    request: SpawnBackgroundRequest,
  ): Promise<SpawnBackgroundResult> {
    if (!this.toolCtx) {
      throw new Error("No tool context — cannot spawn background agent");
    }

    const task = request.task?.trim();
    const message = request.message?.trim();
    if (!task || !message) {
      throw new Error(
        "spawn_background_agent requires non-empty task and message",
      );
    }

    const activeBackgroundCount = Array.from(this.sessions.values()).filter(
      (s) =>
        s.background &&
        (s.status === "streaming" ||
          s.status === "tool_executing" ||
          s.status === "awaiting_approval"),
    ).length;
    if (activeBackgroundCount >= this.bgDefaults.maxConcurrent) {
      const reason = `concurrency limit reached (${this.bgDefaults.maxConcurrent})`;
      this.log?.(`[bg-guard] reject spawn: ${reason}`);
      throw new Error(
        `Background spawn rejected: ${reason}. Wait for another background run to finish.`,
      );
    }

    const fg = this.getForegroundSession();
    const foregroundMode = fg?.mode ?? "code";
    const foregroundModel = fg?.model ?? this.config.model;
    const parentSessionId = fg?.id;

    const route = await resolveBackgroundRoute(providerRegistry, request, {
      mode: foregroundMode,
      model: foregroundModel,
    });

    this.log?.(
      `[bg-route] task=${task} class=${route.taskClass} requested={mode:${request.mode ?? "-"},model:${request.model ?? "-"},provider:${request.provider ?? "-"}} resolved={mode:${route.resolvedMode},model:${route.resolvedModel},provider:${route.resolvedProvider}} fallback=${route.fallbackUsed} reason="${route.routingReason}"`,
    );

    const bgConfig: AgentConfig = {
      ...this.buildConfigForModel(route.resolvedModel),
      // Apply per-task-class thinking budget override
      ...(route.thinkingBudget !== undefined
        ? { thinkingBudget: route.thinkingBudget }
        : {}),
    };

    const providerId =
      providerRegistry.tryResolveProvider(route.resolvedModel)?.id ??
      route.resolvedProvider;

    // Use lightweight prompt for review task classes to reduce system prompt bloat
    const isReviewTask = route.taskClass.startsWith("review_");

    const session = await AgentSession.create({
      mode: route.resolvedMode,
      config: bgConfig,
      cwd: this.cwd,
      devMode: this.devMode,
      background: true,
      isBackground: true,
      lightweight: isReviewTask,
      providerId,
    });

    session.title = task.slice(0, 80);
    // Set status to "streaming" BEFORE registering the session, so the first
    // bgSessionsUpdate the UI receives already shows the agent as running
    // (not briefly "idle"/done).
    session.status = "streaming";
    this.sessions.set(session.id, session);
    if (parentSessionId) {
      this.bgParents.set(session.id, {
        sessionId: parentSessionId,
        task,
      });
    }
    this.bgMeta.set(session.id, {
      resolvedMode: route.resolvedMode,
      resolvedModel: route.resolvedModel,
      resolvedProvider: route.resolvedProvider,
      taskClass: route.taskClass,
      routingReason: route.routingReason,
      fallbackUsed: route.fallbackUsed,
      toolCalls: 0,
      tokenUsage: 0,
    });
    this.onSessionsChanged?.();

    // Build a bg-specific tool context: inherit base but block nested spawning,
    // wrap onApprovalRequest to include background task attribution, and prevent
    // background agents from switching the foreground session's mode.
    // Route ask_user through the foreground agent instead of directly to the user.
    const baseCtx = this.toolCtx;
    const bgCtx: ToolDispatchContext = {
      ...baseCtx,
      sessionId: session.id,
      onModeSwitch: undefined,
      onApprovalRequest: baseCtx.onApprovalRequest
        ? (req) => baseCtx.onApprovalRequest!({ ...req, backgroundTask: task })
        : undefined,
      onSpawnBackground: undefined,
      onGetBackgroundStatus: undefined,
      onGetBackgroundResult: undefined,
      onKillBackground: undefined,
      onQuestion: (questions, bgSessionId) =>
        this.askForegroundAgent(task, questions, bgSessionId),
    };

    const bgEngine = new AgentEngine(providerRegistry, this.log);
    bgEngine.setToolContext(bgCtx);

    session.addUserMessage(message);

    // Fire-and-forget — runs concurrently alongside the foreground session.
    // Background agents run indefinitely (like foreground agents) using
    // auto-condensing to manage context. The foreground agent can kill
    // a background agent via the kill_background_agent tool if needed.
    void (async () => {
      try {
        for await (const event of bgEngine.run(session, {
          isBackground: true,
          toolProfile: route.toolProfile,
          maxApiTurns: route.maxApiTurns,
          maxToolCalls: route.maxToolCalls,
        })) {
          if (event.type === "text_delta") {
            this.appendBgStreamingText(session.id, event.text);
          }

          // Track tool calls and token usage for observability
          const meta = this.bgMeta.get(session.id);
          if (meta) {
            if (event.type === "tool_start") {
              meta.toolCalls += 1;
            }
            if (event.type === "api_request") {
              meta.tokenUsage += event.inputTokens + event.outputTokens;
            }
          }

          this.onEvent?.(session.id, event);
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        session.status = "error";
        this.setBgError(session.id, error);
        this.onEvent?.(session.id, { type: "error", error, retryable: false });
        this.onEvent?.(session.id, {
          type: "done",
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          totalCacheReadTokens: session.totalCacheReadTokens,
          totalCacheCreationTokens: session.totalCacheCreationTokens,
        });
      }

      // Mark completion time for auto-dismiss
      this.markBgCompleted(session.id);

      // Resolve any callers waiting on get_background_result
      const fallbackMsg = this.bgErrors.get(session.id)
        ? `Background agent stopped: ${this.bgErrors.get(session.id)}`
        : "(background agent completed without output)";
      const resultText = session.getLastAssistantText() ?? fallbackMsg;

      // Store result BEFORE resolving waiters to close the race window
      this.bgFinalResults.set(session.id, resultText);

      // Clear all safety timers for this session
      for (const t of this.bgSafetyTimers.get(session.id) ?? [])
        clearTimeout(t);
      this.bgSafetyTimers.delete(session.id);

      for (const resolve of this.bgResultWaiters.get(session.id) ?? []) {
        resolve(resultText);
      }
      this.bgResultWaiters.delete(session.id);
      this.onSessionsChanged?.();
      void this.resumeParentAfterBackgroundCompletion(session.id, resultText);

      // Cleanup stored result after 5 minutes to prevent unbounded memory growth
      setTimeout(
        () => {
          this.bgFinalResults.delete(session.id);
          this.bgParents.delete(session.id);
          this.bgAutoResumed.delete(session.id);
        },
        5 * 60 * 1000,
      );
    })();

    return {
      sessionId: session.id,
      resolvedMode: route.resolvedMode,
      resolvedModel: route.resolvedModel,
      resolvedProvider: route.resolvedProvider,
      taskClass: route.taskClass,
      routingReason: route.routingReason,
      fallbackUsed: route.fallbackUsed,
    };
  }

  /**
   * Non-blocking status check for a background session.
   */
  getBackgroundStatus(sessionId: string): BgStatusResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        status: "error",
        done: true,
        partialOutput: "Session not found",
      };
    }
    const done = session.status === "idle" || session.status === "error";
    return {
      status: session.status as BgStatusResult["status"],
      currentTool: session.currentTool,
      done,
      partialOutput: done ? session.getLastAssistantText() : undefined,
    };
  }

  /**
   * Async — blocks until the background session finishes.
   * Returns the last assistant message text.
   * Uses a double-check pattern to prevent races between status check and waiter registration.
   */
  waitForBackground(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.resolve(
        JSON.stringify({ error: `No background session: ${sessionId}` }),
      );
    }

    // Check stored result first (set in finally block of completion handler)
    const storedResult = this.bgFinalResults.get(sessionId);
    if (storedResult !== undefined) {
      return Promise.resolve(storedResult);
    }

    // Already done (belt + suspenders)
    if (session.status === "idle" || session.status === "error") {
      return Promise.resolve(session.getLastAssistantText() ?? "(no result)");
    }

    return new Promise((resolve) => {
      const waiters = this.bgResultWaiters.get(sessionId) ?? [];
      waiters.push(resolve);
      this.bgResultWaiters.set(sessionId, waiters);

      // Double-check after registration to close the race window
      const storedAfter = this.bgFinalResults.get(sessionId);
      if (storedAfter !== undefined) {
        resolve(storedAfter);
        return;
      }

      // Safety timeout: resolve after 30 minutes as a last resort to prevent
      // permanently hung waiters (e.g. if the session crashes without cleanup).
      const safetyMs = 30 * 60 * 1000;
      const timerId = setTimeout(() => {
        resolve(
          session.getLastAssistantText() ??
            "(background agent timed out waiting for result)",
        );
      }, safetyMs);
      const timers = this.bgSafetyTimers.get(sessionId) ?? [];
      timers.push(timerId);
      this.bgSafetyTimers.set(sessionId, timers);
    });
  }

  /**
   * Append streaming text from a background agent (for UI preview).
   * Only keeps the last ~500 characters to avoid unbounded growth.
   */
  appendBgStreamingText(sessionId: string, text: string): void {
    const existing = this.bgStreamingText.get(sessionId) ?? "";
    const updated = existing + text;
    // Keep last 500 chars
    this.bgStreamingText.set(
      sessionId,
      updated.length > 500 ? updated.slice(-500) : updated,
    );
  }

  /** Record a bg session error message. */
  setBgError(sessionId: string, error: string): void {
    this.bgErrors.set(sessionId, error);
  }

  /** Mark a bg session as completed with a timestamp. */
  markBgCompleted(sessionId: string): void {
    this.bgCompletedAt.set(sessionId, Date.now());
  }

  private async resumeParentAfterBackgroundCompletion(
    bgSessionId: string,
    resultText: string,
  ): Promise<void> {
    if (this.bgAutoResumed.has(bgSessionId)) return;
    const parent = this.bgParents.get(bgSessionId);
    if (!parent) return;

    const session = this.sessions.get(parent.sessionId);
    if (!session || session.background) return;
    if (session.status !== "idle") return;
    if (this.foregroundId !== session.id) return;

    this.bgAutoResumed.add(bgSessionId);
    try {
      await this.sendMessage(
        session.id,
        [
          `The background agent for "${parent.task}" has returned while you were stopped.`,
          "Resume now: summarize the background result for the user and continue the task if more work is needed.",
          "",
          `<background_result task="${parent.task}" sessionId="${bgSessionId}">`,
          resultText,
          "</background_result>",
        ].join("\n"),
        session.mode,
      );
    } catch (err) {
      this.bgAutoResumed.delete(bgSessionId);
      this.log?.(
        `[bg-resume] failed to resume foreground for ${bgSessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Return status info for all background sessions (for the UI strip).
   */
  getBgSessionInfos(): BgSessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.background)
      .map((s) => {
        const isCancelled = this.bgCancelled.has(s.id);
        const isDone =
          s.status === "idle" || s.status === "error" || isCancelled;
        let status: BgSessionInfo["status"] =
          s.status as BgSessionInfo["status"];
        if (isCancelled && s.status === "idle") {
          status = "cancelled";
        }
        const meta = this.bgMeta.get(s.id);
        return {
          id: s.id,
          task: s.title,
          status,
          currentTool: s.currentTool,
          resolvedMode: meta?.resolvedMode,
          resolvedModel: meta?.resolvedModel,
          resolvedProvider: meta?.resolvedProvider,
          taskClass: meta?.taskClass,
          routingReason: meta?.routingReason,
          fallbackUsed: meta?.fallbackUsed,
          streamingText: this.bgStreamingText.get(s.id),
          resultText: isDone ? s.getLastAssistantText() : undefined,
          errorMessage: this.bgErrors.get(s.id),
          completedAt: this.bgCompletedAt.get(s.id),
          fullTranscript: isDone ? s.getFullAssistantTranscript() : undefined,
        };
      });
  }

  /**
   * Return the most recent background routing summaries for debug surfaces.
   */
  getRecentBgRoutingSummaries(limit = 5): string[] {
    const infos = this.getBgSessionInfos()
      .slice()
      .sort((a, b) => {
        const at = a.completedAt ?? Number.MAX_SAFE_INTEGER;
        const bt = b.completedAt ?? Number.MAX_SAFE_INTEGER;
        return bt - at;
      })
      .slice(0, Math.max(1, limit));

    return infos.map((info) => {
      const route = [
        info.resolvedMode ? `mode=${info.resolvedMode}` : null,
        info.resolvedProvider ? `provider=${info.resolvedProvider}` : null,
        info.resolvedModel ? `model=${info.resolvedModel}` : null,
      ]
        .filter((v): v is string => Boolean(v))
        .join(", ");
      const reason = info.routingReason
        ? ` reason="${info.routingReason}"`
        : "";
      const flags = [info.fallbackUsed ? "fallback=true" : null]
        .filter((v): v is string => Boolean(v))
        .join(" ");

      return `${info.id} task="${info.task}"${route ? ` ${route}` : ""}${reason}${flags ? ` ${flags}` : ""}`;
    });
  }
}
