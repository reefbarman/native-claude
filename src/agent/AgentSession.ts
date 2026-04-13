import { randomUUID } from "crypto";
import type { ContentBlock, TextBlock } from "./providers/types.js";
import type {
  SessionStatus,
  AgentConfig,
  AgentMessage,
  AgentRuntimeError,
} from "./types.js";
import { buildPromptArtifacts } from "./systemPrompt.js";
import type { AgentMode } from "./modes.js";
import type { SkillEntry } from "./skillLoader.js";
import { BUILT_IN_MODES } from "./modes.js";
import { getEffectiveHistory, injectSyntheticToolResults } from "./condense.js";
import { buildSessionTitleFromUserText } from "./sessionTitle.js";

export class AgentSession {
  id: string;
  readonly background: boolean;
  createdAt: number;
  readonly cwd: string;
  systemPrompt: string;

  mode: string;
  /** Full mode definition (for tool filtering). Falls back to built-in 'code'. */
  agentMode: AgentMode;
  model: string;
  maxTokens: number;
  thinkingBudget: number;
  autoCondense: boolean;
  autoCondenseThreshold: number;
  codexStatefulResponses: boolean;
  codexStoreResponses: boolean;
  private _status: SessionStatus = "idle";
  private _statusListeners = new Set<() => void>();
  title: string = "New Chat";
  lastActiveAt: number;
  /** Name of the most recently started tool call (updated by AgentEngine). */
  currentTool: string | undefined;

  /** Cumulative uncached input tokens across the session.
   * This is intentionally uncached-only for cost/usage accounting; use lastInputTokens
   * for most-recent total context-window usage including cache reads/writes. */
  totalInputTokens: number = 0;
  totalOutputTokens: number = 0;
  totalCacheReadTokens: number = 0;
  totalCacheCreationTokens: number = 0;

  /** Full conversation history including condensed messages */
  private messages: AgentMessage[] = [];
  /** Files read during this session (for folded file context on condense) */
  readonly filesRead = new Set<string>();
  /** Skills advertised in the current system prompt, keyed by path for allowlist validation. */
  private advertisedSkills = new Map<string, SkillEntry>();
  /** Skill names explicitly loaded during this session and kept alive across condense. */
  readonly loadedSkills = new Set<string>();
  /** Total input tokens from the most recent API response: uncached + cache_read + cache_creation.
   *  This represents actual context window usage (used for condense threshold check & context bar). */
  lastInputTokens = 0;
  /** Output tokens from the most recent API response (used with lastInputTokens to estimate next-turn usage) */
  lastOutputTokens = 0;
  /** Cache-read tokens from the most recent API response (used for cache-aware condense threshold) */
  lastCacheReadTokens = 0;

  /** Estimated tokens accumulated since the last API response (tool results, user messages, etc.).
   *  Reset to 0 when addUsage() receives fresh API data. */
  estimatedAccumulatedTokens = 0;

  /** Active file path at session creation — used for subfolder AGENTS.md and hot-reload. */
  activeFilePath: string | undefined;

  /** Provider ID (e.g. "anthropic", "codex") — used for provider-specific system prompt tuning. */
  providerId: string | undefined;
  /** Last OpenAI/Codex Responses API response ID used for optional stateful chaining. */
  providerResponseId: string | undefined;

  get status(): SessionStatus {
    return this._status;
  }

  set status(s: SessionStatus) {
    this._status = s;
    // Notify all waiters on every status change
    for (const listener of this._statusListeners) listener();
    this._statusListeners.clear();
  }

  /**
   * Returns a promise that resolves next time `status` is set.
   * Supports an optional AbortSignal for cleanup — when the signal fires,
   * the listener is removed to prevent accumulation during Promise.race loops.
   */
  waitForStatusChange(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const cb = () => {
        this._statusListeners.delete(cb);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this._statusListeners.delete(cb);
        resolve();
      };
      this._statusListeners.add(cb);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private abortController: AbortController | null = null;
  private _abortSignal: AbortSignal | undefined;
  private _pendingInterjection: {
    text: string;
    queueId: string;
    displayText?: string;
    isSlashCommand?: boolean;
    slashCommandLabel?: string;
    attachments?: string[];
    images?: Array<{ name: string; mimeType: string; base64: string }>;
    documents?: Array<{ name: string; mimeType: string; base64: string }>;
  } | null = null;
  private _pendingModeResume: {
    mode: string;
    reason?: string;
    followUp?: string;
  } | null = null;

  /**
   * Turn-bound media attachments (images + PDFs).
   * Keyed by message index so media survives retries and isn't confused with interjections.
   * Non-persistent — ephemeral within the running session.
   */
  private _pendingMedia = new Map<
    number,
    {
      images: Array<{ name: string; mimeType: string; base64: string }>;
      documents: Array<{ name: string; mimeType: string; base64: string }>;
    }
  >();

  private constructor(opts: {
    mode: string;
    agentMode: AgentMode;
    config: AgentConfig;
    systemPrompt: string;
    background?: boolean;
    cwd: string;
    activeFilePath?: string;
    providerId?: string;
  }) {
    this.id = randomUUID();
    this.mode = opts.mode;
    this.agentMode = opts.agentMode;
    this.cwd = opts.cwd;
    this.model = opts.config.model;
    this.maxTokens = opts.config.maxTokens;
    this.thinkingBudget = opts.config.thinkingBudget;
    this.autoCondense = opts.config.autoCondense ?? true;
    this.autoCondenseThreshold = opts.config.autoCondenseThreshold ?? 0.9;
    this.codexStatefulResponses = opts.config.codexStatefulResponses ?? true;
    this.codexStoreResponses = opts.config.codexStoreResponses ?? false;
    this.background = opts.background ?? false;
    this.createdAt = Date.now();
    this.lastActiveAt = this.createdAt;
    this.systemPrompt = opts.systemPrompt;
    this.activeFilePath = opts.activeFilePath;
    this.providerId = opts.providerId;
  }

  static async create(opts: {
    mode: string;
    agentMode?: AgentMode;
    config: AgentConfig;
    cwd: string;
    background?: boolean;
    isBackground?: boolean;
    /** Use lightweight prompt (background review agents). */
    lightweight?: boolean;
    devMode?: boolean;
    activeFilePath?: string;
    providerId?: string;
  }): Promise<AgentSession> {
    const artifacts = await buildPromptArtifacts(opts.mode, opts.cwd, {
      devMode: opts.devMode,
      activeFilePath: opts.activeFilePath,
      providerId: opts.providerId,
      model: opts.config.model,
      isBackground: opts.isBackground,
      lightweight: opts.lightweight,
    });
    const agentMode =
      opts.agentMode ??
      BUILT_IN_MODES.find((m) => m.slug === opts.mode) ??
      BUILT_IN_MODES[0];
    const session = new AgentSession({
      mode: opts.mode,
      agentMode,
      config: opts.config,
      systemPrompt: artifacts.systemPrompt,
      cwd: opts.cwd,
      background: opts.background,
      activeFilePath: opts.activeFilePath,
      providerId: opts.providerId,
    });
    session.setAdvertisedSkills(artifacts.skills);
    return session;
  }

  /**
   * Rebuild the system prompt in-place (used for hot-reload when instruction files change).
   * Preserves the activeFilePath that was set at session creation.
   */
  async rebuildSystemPrompt(opts?: { devMode?: boolean }): Promise<void> {
    const artifacts = await buildPromptArtifacts(this.mode, this.cwd, {
      devMode: opts?.devMode,
      activeFilePath: this.activeFilePath,
      providerId: this.providerId,
      model: this.model,
    });
    this.systemPrompt = artifacts.systemPrompt;
    this.setAdvertisedSkills(artifacts.skills);
    this.resetProviderResponseState();
  }

  /**
   * Switch mode in-place while preserving message history and session identity.
   */
  async setMode(
    mode: string,
    opts?: { agentMode?: AgentMode; devMode?: boolean },
  ): Promise<void> {
    const artifacts = await buildPromptArtifacts(mode, this.cwd, {
      devMode: opts?.devMode,
      providerId: this.providerId,
      model: this.model,
    });
    const agentMode =
      opts?.agentMode ??
      BUILT_IN_MODES.find((m) => m.slug === mode) ??
      BUILT_IN_MODES[0];

    this.mode = mode;
    this.agentMode = agentMode;
    this.systemPrompt = artifacts.systemPrompt;
    this.setAdvertisedSkills(artifacts.skills);
    this.resetProviderResponseState();
    this.lastActiveAt = Date.now();
  }

  /** Full history (for persistence, rewind, etc.) */
  getAllMessages(): AgentMessage[] {
    return this.messages;
  }

  /**
   * Effective history to send to the API.
   * Filters out messages tagged with condenseParent whose summary still exists,
   * plus persisted runtime-error notes that are for local context only.
   */
  getMessages(): AgentMessage[] {
    return injectSyntheticToolResults(
      getEffectiveHistory(this.messages).filter((m) => !m.runtimeError),
    );
  }

  get messageCount(): number {
    return this.messages.length;
  }

  /**
   * Remove the last message if it matches the given role.
   * Returns the removed message, or undefined if the last message didn't match.
   */
  popLastMessage(role: "user" | "assistant"): AgentMessage | undefined {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === role) {
      return this.messages.pop();
    }
    return undefined;
  }

  addUserMessage(
    text: string,
    opts?: {
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
    },
  ): void {
    this.messages.push({
      role: "user",
      content: text,
      ...(opts && (opts.displayText || opts.isSlashCommand)
        ? {
            uiHint: {
              userMessage: {
                ...(opts.displayText ? { displayText: opts.displayText } : {}),
                ...(opts.isSlashCommand ? { isSlashCommand: true } : {}),
                ...(opts.slashCommandLabel
                  ? { slashCommandLabel: opts.slashCommandLabel }
                  : {}),
              },
            },
          }
        : {}),
    } as AgentMessage);
    this.lastActiveAt = Date.now();
  }

  appendRuntimeError(error: AgentRuntimeError): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.runtimeError?.message === error.message) {
      last.runtimeError.retryable = error.retryable;
      last.runtimeError.code = error.code;
      last.runtimeError.actions = error.actions;
      this.lastActiveAt = Date.now();
      return;
    }
    this.messages.push({
      role: "assistant",
      content: [{ type: "text", text: error.message }],
      runtimeError: {
        message: error.message,
        retryable: error.retryable,
        code: error.code,
        actions: error.actions,
      },
    } as AgentMessage);
    this.lastActiveAt = Date.now();
  }

  appendAssistantTurn(content: ContentBlock[]): void {
    this.messages.push({ role: "assistant", content } as AgentMessage);
    this.lastActiveAt = Date.now();
  }

  setProviderResponseId(responseId: string | undefined): void {
    this.providerResponseId = responseId?.trim() || undefined;
  }

  resetProviderResponseState(): void {
    this.providerResponseId = undefined;
  }

  appendToolResults(
    results: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string | ContentBlock[];
    }>,
  ): void {
    this.messages.push({ role: "user", content: results } as AgentMessage);
    this.lastActiveAt = Date.now();
  }

  /** Replace full message history after condensing */
  replaceMessages(messages: AgentMessage[]): void {
    this.messages = messages;
    this.resetProviderResponseState();
    this.lastActiveAt = Date.now();
  }

  /**
   * Restore session state from persisted store data.
   * Only called by AgentSessionManager.loadPersistedSession().
   */
  restoreFromStore(data: {
    id: string;
    title: string;
    createdAt: number;
    lastActiveAt: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens?: number;
    totalCacheCreationTokens?: number;
    lastInputTokens?: number;
    lastCacheReadTokens?: number;
    loadedSkills?: string[];
    messages: AgentMessage[];
  }): void {
    this.id = data.id;
    this.title = data.title;
    this.createdAt = data.createdAt;
    this.lastActiveAt = data.lastActiveAt;
    this.totalInputTokens = data.totalInputTokens;
    this.totalOutputTokens = data.totalOutputTokens;
    this.totalCacheReadTokens = data.totalCacheReadTokens ?? 0;
    this.totalCacheCreationTokens = data.totalCacheCreationTokens ?? 0;
    this.lastInputTokens = data.lastInputTokens ?? 0;
    this.lastCacheReadTokens = data.lastCacheReadTokens ?? 0;
    this.messages = data.messages;
    this.resetProviderResponseState();
    this.loadedSkills.clear();
    for (const skill of data.loadedSkills ?? []) {
      if (skill.trim()) this.loadedSkills.add(skill.trim());
    }
  }

  /** Record that a file was read during this session */
  trackFileRead(filePath: string): void {
    this.filesRead.add(filePath);
  }

  setAdvertisedSkills(skills: SkillEntry[]): void {
    this.advertisedSkills = new Map(
      skills.map((skill) => [skill.skillPath, skill]),
    );
  }

  getAdvertisedSkills(): SkillEntry[] {
    return Array.from(this.advertisedSkills.values());
  }

  getLoadedSkills(): string[] {
    return [...this.loadedSkills];
  }

  trackLoadedSkill(skillName: string): void {
    if (skillName.trim()) this.loadedSkills.add(skillName.trim());
  }

  addUsage(
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
  ): void {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCacheReadTokens += cacheReadTokens;
    this.totalCacheCreationTokens += cacheCreationTokens;
    // The API's input_tokens field only counts tokens AFTER the last cache breakpoint.
    // For context window usage we need the total: uncached + cache reads + cache writes.
    this.lastInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
    this.lastOutputTokens = outputTokens;
    this.lastCacheReadTokens = cacheReadTokens;
    // Fresh API data replaces any local estimates.
    this.estimatedAccumulatedTokens = 0;
  }

  /**
   * Add an estimated token count for content added since the last API response
   * (e.g. tool results, user messages). Uses the same 4-bytes-per-token
   * heuristic as Codex CLI.
   */
  addEstimatedTokens(chars: number): void {
    this.estimatedAccumulatedTokens += Math.ceil(chars / 4);
  }

  /**
   * Running estimate of total context window usage:
   * last API total + estimated new content since then.
   */
  get estimatedTotalUsed(): number {
    return (
      this.lastInputTokens +
      this.lastOutputTokens +
      this.estimatedAccumulatedTokens
    );
  }

  /** Return the text content of the last assistant message, if any. */
  getLastAssistantText(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === "assistant") {
        if (Array.isArray(msg.content)) {
          return (
            msg.content
              .filter((b): b is TextBlock => b.type === "text")
              .map((b) => b.text)
              .join("")
              .trim() || undefined
          );
        }
        if (typeof msg.content === "string")
          return msg.content.trim() || undefined;
      }
    }
    return undefined;
  }

  /**
   * Concatenate all assistant text blocks across the full conversation.
   * Used for the "full transcript" view on background agent result blocks.
   */
  getFullAssistantTranscript(): string | undefined {
    const parts: string[] = [];
    for (const msg of this.messages) {
      if (msg.role !== "assistant") continue;
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === "text") parts.push(b.text);
        }
      } else if (typeof msg.content === "string") {
        parts.push(msg.content);
      }
    }
    const text = parts.join("\n\n").trim();
    return text || undefined;
  }

  /** Auto-title from first user message */
  autoTitle(): void {
    const first = this.messages[0];
    if (first?.role === "user" && typeof first.content === "string") {
      const title = buildSessionTitleFromUserText(first.content);
      if (title) {
        this.title = title;
      }
    }
  }

  /**
   * Queue an interjection for injection between tool batches.
   * Returns true if the slot was free and the interjection was accepted,
   * false if the slot was already occupied (caller should fall back).
   */
  setPendingInterjection(
    text: string,
    queueId: string,
    displayText?: string,
    isSlashCommand?: boolean,
    slashCommandLabel?: string,
    attachments?: string[],
    images?: Array<{ name: string; mimeType: string; base64: string }>,
    documents?: Array<{ name: string; mimeType: string; base64: string }>,
  ): boolean {
    // Only register the first queued item; subsequent items wait until done
    if (this._pendingInterjection === null) {
      this._pendingInterjection = {
        text,
        queueId,
        displayText,
        isSlashCommand,
        slashCommandLabel,
        attachments,
        images,
        documents,
      };
      return true;
    }
    return false;
  }

  updatePendingInterjection(
    queueId: string,
    updates: {
      text: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      attachments?: string[];
      images?: Array<{ name: string; mimeType: string; base64: string }>;
      documents?: Array<{ name: string; mimeType: string; base64: string }>;
    },
  ): boolean {
    if (this._pendingInterjection?.queueId !== queueId) return false;
    this._pendingInterjection = { queueId, ...updates };
    return true;
  }

  consumePendingInterjection(): {
    text: string;
    queueId: string;
    displayText?: string;
    isSlashCommand?: boolean;
    slashCommandLabel?: string;
    attachments?: string[];
    images?: Array<{ name: string; mimeType: string; base64: string }>;
    documents?: Array<{ name: string; mimeType: string; base64: string }>;
  } | null {
    const interjection = this._pendingInterjection;
    this._pendingInterjection = null;
    return interjection;
  }

  /**
   * Check if a specific interjection is still pending (not yet consumed by the engine).
   * Used to detect the race where the foreground went idle before consuming it.
   */
  hasPendingInterjection(queueId: string): boolean {
    return this._pendingInterjection?.queueId === queueId;
  }

  /**
   * Remove a pending interjection by queueId if it hasn't been consumed yet.
   * Returns the removed interjection, or null if it was already consumed.
   */
  clearPendingInterjectionIf(queueId: string): {
    text: string;
    queueId: string;
    displayText?: string;
    isSlashCommand?: boolean;
    slashCommandLabel?: string;
    attachments?: string[];
    images?: Array<{ name: string; mimeType: string; base64: string }>;
    documents?: Array<{ name: string; mimeType: string; base64: string }>;
  } | null {
    if (this._pendingInterjection?.queueId === queueId) {
      const interjection = this._pendingInterjection;
      this._pendingInterjection = null;
      return interjection;
    }
    return null;
  }

  queuePendingModeResume(
    mode: string,
    opts?: { reason?: string; followUp?: string },
  ): void {
    this._pendingModeResume = {
      mode,
      reason: opts?.reason,
      followUp: opts?.followUp,
    };
  }

  consumePendingModeResume(): {
    mode: string;
    reason?: string;
    followUp?: string;
  } | null {
    const pending = this._pendingModeResume;
    this._pendingModeResume = null;
    return pending;
  }

  /** Store pending media (images/PDFs) bound to a specific message index. */
  setPendingMedia(
    messageIndex: number,
    images?: Array<{ name: string; mimeType: string; base64: string }>,
    documents?: Array<{ name: string; mimeType: string; base64: string }>,
  ): void {
    const imgs = images?.length ? images : [];
    const docs = documents?.length ? documents : [];
    if (imgs.length > 0 || docs.length > 0) {
      this._pendingMedia.set(messageIndex, { images: imgs, documents: docs });
    }
  }

  /** Get pending media for a specific message index. Non-destructive — safe across retries. */
  getPendingMedia(messageIndex: number):
    | {
        images: Array<{ name: string; mimeType: string; base64: string }>;
        documents: Array<{ name: string; mimeType: string; base64: string }>;
      }
    | undefined {
    return this._pendingMedia.get(messageIndex);
  }

  /** Clear all pending media. Call after the engine successfully processes the turn. */
  clearPendingMedia(): void {
    this._pendingMedia.clear();
  }

  createAbortController(): AbortController {
    this.abortController = new AbortController();
    this._abortSignal = this.abortController.signal;
    return this.abortController;
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
    this._pendingModeResume = null;
  }

  get isAborted(): boolean {
    return this._abortSignal?.aborted ?? false;
  }

  get abortSignal(): AbortSignal | undefined {
    return this._abortSignal;
  }
}
