import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { providerRegistry } from "./providers/index.js";
import { getConfiguredBaseThresholdForModel } from "./modelCondenseThresholds.js";
import type { AgentSessionManager } from "./AgentSessionManager.js";
import type { AgentEvent } from "./types.js";
import type { TodoItem } from "./todoTool.js";
import { SlashCommandRegistry } from "./SlashCommandRegistry.js";
import { McpClientHub } from "./McpClientHub.js";
import { loadMcpConfigs, getMcpConfigFilePaths } from "./mcpConfig.js";
import { loadCustomModes, getAllModes } from "./modes.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { loadAllInstructionBlocks } from "./configLoader.js";
import type {
  ApprovalRequest,
  DecisionMessage,
} from "../approvals/webview/types.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ToolCallTracker } from "../server/ToolCallTracker.js";
import { DIFF_VIEW_URI_SCHEME } from "../extension.js";

/**
 * Webview protocol types — messages between extension and chat webview.
 * Mirrored in src/agent/webview/types.ts for the browser side.
 */
export type ExtensionToWebview =
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
      type: "agentTodoUpdate";
      sessionId: string;
      todos: TodoItem[];
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
  | {
      type: "agentSessionUpdate";
      sessions: import("./types.js").SessionInfo[];
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
  | { type: "agentDroppedFilesResolved"; files: string[] }
  | {
      type: "agentModesUpdate";
      modes: Array<{ slug: string; name: string; icon: string }>;
    }
  | {
      type: "agentSlashCommandsUpdate";
      commands: Array<{
        name: string;
        description: string;
        source: string;
        builtin: boolean;
        body?: string;
      }>;
    }
  | {
      type: "agentModelsUpdate";
      models: Array<{
        id: string;
        displayName: string;
        provider: string;
        contextWindow: number;
        authenticated: boolean;
      }>;
    }
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
  | { type: "showApproval"; request: ApprovalRequest }
  | { type: "idle" }
  | {
      type: "agentQuestionRequest";
      id: string;
      questions: import("./webview/types.js").Question[];
    }
  | {
      type: "agentCondense";
      sessionId: string;
      prevInputTokens: number;
      newInputTokens: number;
      summary: string;
      durationMs: number;
      validationWarnings?: string[];
      metadata?: {
        inputMessageCount: number;
        sourceUserMessageCount: number;
        hadPriorSummaryInInput: boolean;
        retryUsed: boolean;
        validatorErrors: string[];
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
  | {
      type: "agentSessionList";
      sessions: import("./SessionStore.js").SessionSummary[];
    }
  | { type: "agentRestoreSessionStart" }
  | { type: "agentRestoreSessionDone" }
  | {
      type: "agentSessionLoaded";
      sessionId: string;
      title: string;
      mode: string;
      messages: import("./types.js").AgentMessage[];
      lastInputTokens: number;
      lastOutputTokens: number;
      /** True when this came from automatic startup restore rather than explicit user action. */
      restored?: boolean;
      /** turnIndex → checkpointId mapping for restored sessions */
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
    }
  | {
      type: "agentCheckpointCreated";
      sessionId: string;
      checkpointId: string;
      turnIndex: number;
    }
  | {
      type: "agentBgSessionsUpdate";
      sessions: import("../shared/types.js").BgSessionInfo[];
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
      type: "agentInterjection";
      sessionId: string;
      text: string;
      queueId: string;
      displayText?: string;
    }
  | {
      type: "agentDebugInfo";
      info: Record<string, string | number>;
      systemPrompt?: string;
      loadedInstructions?: Array<{ source: string; chars: number }>;
    }
  | {
      type: "agentBgQuestion";
      sessionId: string;
      bgTask: string;
      questions: string[];
      answer: string;
    }
  | {
      type: "showBgTranscript";
      sessionId: string;
      task: string;
      messages: unknown[];
    }
  | { type: "agentBtwLoading"; requestId: string; question: string }
  | {
      type: "agentBtwResponse";
      requestId: string;
      question: string;
      answer: string;
      error?: boolean;
    };

export interface ChatState {
  sessionId: string | null;
  mode: string;
  model: string;
  streaming: boolean;
  condenseThreshold?: number;
  agentWriteApproval?: "prompt" | "session" | "project" | "global";
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "agentLink.chatView";

  private view: vscode.WebviewView | undefined;
  private sessionManager: AgentSessionManager | undefined;
  private outputChannel: vscode.OutputChannel;
  private webviewReady = false;
  private pendingMessages: ExtensionToWebview[] = [];
  private slashRegistry: SlashCommandRegistry | undefined;
  private mcpHub: McpClientHub;
  private fileWatchers: vscode.Disposable[] = [];
  private cwd: string = "";
  private pendingElicitations = new Map<
    string,
    { resolve: (values: Record<string, unknown>) => void; cancel: () => void }
  >();
  private pendingApprovals = new Map<
    string,
    (
      result:
        | string
        | {
            decision: string;
            rejectionReason?: string;
            followUp?: string;
            trustScope?: string;
            rulePattern?: string;
            ruleMode?: string;
          },
    ) => void
  >();
  private pendingForwardedApprovals = new Map<
    string,
    (msg: DecisionMessage) => void
  >();
  private pendingQuestions = new Map<
    string,
    (response: {
      answers: Record<string, unknown>;
      notes: Record<string, string>;
    }) => void
  >();
  /** Tracks which pending-question IDs belong to each session, for scoped cancellation on stop */
  private questionSessionIndex = new Map<string, Set<string>>();
  /** Tracks which pending-approval IDs belong to each session, for scoped cancellation on stop */
  private approvalSessionIndex = new Map<string, Set<string>>();

  private condenseStartTimes = new Map<string, number>();
  private bgUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  // Buffers for coalescing high-frequency streaming deltas before postMessage IPC.
  private textDeltaBuffer = new Map<string, string>();
  private thinkingDeltaBuffer = new Map<string, Map<string, string>>();
  private toolInputDeltaBuffer = new Map<string, Map<string, string>>();
  private deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private streamDropCounts = {
    sessionMismatch: 0,
    streamingFalse: 0,
  };
  private streamDropLogTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalManager: ApprovalManager | undefined;
  private approvalManagerListener: vscode.Disposable | undefined;
  private toolCallTracker: ToolCallTracker | undefined;
  private specialBlockPanel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalState: vscode.Memento,
  ) {
    this.outputChannel = vscode.window.createOutputChannel("AgentLink Agent");
    this.mcpHub = new McpClientHub(globalState);
    this.mcpHub.onSampling = async ({
      messages,
      systemPrompt,
      maxTokens,
      model,
    }) => {
      const targetModel = model ?? "claude-sonnet-4-6";
      const provider = providerRegistry.tryResolveProvider(targetModel);
      if (!provider) {
        return {
          role: "assistant",
          content: "Sampling unavailable: no provider for model.",
        };
      }
      try {
        const result = await provider.complete({
          model: targetModel,
          systemPrompt: systemPrompt ?? "",
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          maxTokens,
        });
        return { role: "assistant", content: result.text };
      } catch {
        return {
          role: "assistant",
          content: "Sampling failed.",
        };
      }
    };

    this.mcpHub.onElicitation = (request, resolve, cancel) => {
      const id = `elicit_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      this.pendingElicitations.set(id, { resolve, cancel });
      this.postMessage({
        type: "agentElicitationRequest",
        id,
        serverName: request.serverName,
        message: request.message,
        fields: request.fields,
        required: request.required,
      } as unknown as ExtensionToWebview);
    };
  }

  dispose(): void {
    // Reject all pending promises so any awaiting tool calls/question handlers
    // don't stay suspended across view lifecycle.
    for (const resolve of this.pendingQuestions.values()) {
      resolve({ answers: {}, notes: {} });
    }
    this.pendingQuestions.clear();
    this.questionSessionIndex.clear();

    for (const resolve of this.pendingApprovals.values()) {
      resolve("reject");
    }
    this.pendingApprovals.clear();
    this.approvalSessionIndex.clear();

    for (const resolve of this.pendingForwardedApprovals.values()) {
      // Send a synthetic rejection so the approval chain unblocks.
      resolve({
        type: "decision",
        id: "",
        decision: "reject",
      } as import("../approvals/webview/types.js").DecisionMessage);
    }
    this.pendingForwardedApprovals.clear();

    for (const { cancel } of this.pendingElicitations.values()) {
      cancel();
    }
    this.pendingElicitations.clear();

    this.outputChannel.dispose();
    this.specialBlockPanel?.dispose();
    this.specialBlockPanel = undefined;
    for (const w of this.fileWatchers) w.dispose();
    this.fileWatchers = [];
    this.approvalManagerListener?.dispose();
    this.mcpHub?.disconnectAll().catch(() => undefined);
  }

  setApprovalManager(manager: ApprovalManager): void {
    this.approvalManager = manager;
    this.approvalManagerListener?.dispose();
    this.approvalManagerListener = manager.onDidChange(() => {
      this.sendInitialState();
    });
  }

  setToolCallTracker(tracker: ToolCallTracker): void {
    this.toolCallTracker = tracker;
  }

  /**
   * Initialize modes, slash commands, MCP hub, and file watchers.
   * Call after construction, before the webview is opened.
   */
  async initialize(cwd: string): Promise<void> {
    this.cwd = cwd;

    // Slash commands
    this.slashRegistry = new SlashCommandRegistry(cwd);
    await this.slashRegistry.reload();

    this.mcpHub.onStatusChange = (infos) => {
      this.log(`[mcp] server status changed`);
      // Push live updates to the status panel if it's open
      this.postMessage({
        type: "agentMcpStatus",
        infos,
      } as ExtensionToWebview);
    };
    await this.refreshMcpConnections();

    // File watchers for hot reload
    this.setupFileWatchers(cwd);

    this.log(
      `[slash] loaded ${this.slashRegistry.getAll().length} commands on init`,
    );
    // Re-send after async init completes in case webview opened during init
    void this.sendModesUpdate();
    this.sendSlashCommands();
  }

  /** Returns the MCP client hub (always defined, may not yet be connected). */
  getMcpHub(): McpClientHub {
    return this.mcpHub;
  }

  private async refreshMcpConnections(): Promise<void> {
    if (!this.mcpHub || !this.cwd) return;
    try {
      const configs = await loadMcpConfigs(this.cwd);
      await this.mcpHub.connect(configs);
      this.log(`[mcp] connected ${configs.length} server(s)`);
    } catch (err) {
      this.log(`[mcp] connection error: ${err}`);
    }
  }

  private async openMcpConfig(scope: "project" | "global"): Promise<void> {
    if (!this.cwd) return;
    const paths = getMcpConfigFilePaths(this.cwd);
    const filePath = scope === "global" ? paths.global : paths.project;

    const fs = require("fs");
    const pathMod = require("path");

    // Create with template if missing
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(pathMod.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({ mcpServers: {} }, null, 2),
        "utf-8",
      );
    }

    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  }

  /** Called by the tool dispatcher when the agent requests a mode switch. */
  public async handleModeSwitch(
    mode: string,
    reason?: string,
  ): Promise<{ approved: boolean; mode: string }> {
    const requestedBy =
      reason && reason.trim().length > 0 ? reason.trim() : "agent";

    try {
      const approval = await this.requestApproval({
        id: `mode-switch-${randomUUID()}`,
        kind: "mode-switch",
        title: `Switch to "${mode}" mode`,
        detail: requestedBy,
        choices: [
          { label: "Allow", value: "run-once", isPrimary: true },
          { label: "Reject", value: "reject", isDanger: true },
        ],
      });

      const decision =
        typeof approval === "string" ? approval : approval.decision;
      const rejectionReason =
        typeof approval === "string" ? undefined : approval.rejectionReason;
      const followUp =
        typeof approval === "string" ? undefined : approval.followUp;

      if (decision === "reject") {
        const reasonText = rejectionReason?.trim() || "No reason provided";
        this.log(`[mode] denied switch to ${mode}: ${reasonText}`);
        this.postMessage({
          type: "agentUserAnnotation",
          sessionId: this.sessionManager?.getForegroundSession()?.id ?? "agent",
          text: `Mode switch to "${mode}" denied: ${reasonText}`,
          badge: "rejection",
        });
        return { approved: false, mode };
      }

      if (!this.sessionManager) {
        this.postMessage({ type: "agentModeSwitchRequest", mode, reason });
        return { approved: true, mode };
      }

      try {
        const session = await this.sessionManager.switchForegroundMode(mode);
        if (!session) {
          // No active session yet — fall back to creating a new session in target mode.
          this.postMessage({
            type: "agentModeSwitchRequest",
            mode,
            reason,
          });
          return { approved: true, mode };
        }
        // Reset session-level write approval when switching modes — "session"
        // approval was granted for the previous mode, not the new one.
        this.approvalManager?.resetSessionAgentWriteApproval(session.id);
        this.sessionManager.queueModeSwitchResume(session.id, mode, {
          reason,
          followUp,
        });
        this.sendInitialState();
        const suffix = followUp?.trim() ? ` | ${followUp.trim()}` : "";
        this.log(
          `[mode] switched foreground session ${session.id} to ${mode}${suffix}`,
        );
        return { approved: true, mode };
      } catch (err) {
        this.log(`[mode] failed to switch mode in-place: ${err}`);
        this.postMessage({ type: "agentModeSwitchRequest", mode, reason });
        return { approved: true, mode };
      }
    } catch (err) {
      this.log(`[mode] approval flow failed for switch to ${mode}: ${err}`);
      return { approved: false, mode };
    }
  }

  /**
   * Forward a rich approval request (from ApprovalPanelProvider) to the chat webview.
   * Renders the actual CommandCard/WriteCard/RenameCard/PathCard components inline.
   */
  public forwardApproval(
    request: ApprovalRequest,
    respond: (msg: DecisionMessage) => void,
  ): void {
    this.pendingForwardedApprovals.set(request.id, respond);
    this.postMessage({ type: "showApproval", request } as ExtensionToWebview);
  }

  /**
   * Notify the chat webview that the approval queue is empty (clear any shown card).
   */
  public sendApprovalIdle(): void {
    this.postMessage({ type: "idle" } as ExtensionToWebview);
  }

  /**
   * Show a rich approval card in the chat webview.
   * All approvals are routed through the rich card system (WriteCard,
   * CommandCard, McpCard, ModeSwitchCard) with follow-up input and
   * rejection reasons.
   */
  public requestApproval(request: {
    kind: "mcp" | "write" | "rename" | "command" | "mode-switch";
    title: string;
    detail?: string;
    choices: Array<{
      label: string;
      value: string;
      isPrimary?: boolean;
      isDanger?: boolean;
    }>;
    id?: string;
    backgroundTask?: string;
  }): Promise<
    | string
    | {
        decision: string;
        rejectionReason?: string;
        followUp?: string;
        trustScope?: string;
        rulePattern?: string;
        ruleMode?: string;
      }
  > {
    const id = request.id ?? randomUUID();

    // Build an ApprovalRequest for the rich card system
    const approvalRequest = this.buildApprovalRequest(id, request);

    return new Promise((resolve) => {
      this.pendingApprovals.set(id, resolve);
      this.postMessage({
        type: "showApproval",
        request: approvalRequest,
      } as ExtensionToWebview);
    });
  }

  /**
   * Map an inline approval request to a rich ApprovalRequest for the card system.
   */
  private buildApprovalRequest(
    id: string,
    request: {
      kind: string;
      title: string;
      detail?: string;
      choices: Array<{
        label: string;
        value: string;
        isPrimary?: boolean;
        isDanger?: boolean;
      }>;
    },
  ): ApprovalRequest {
    switch (request.kind) {
      case "write": {
        const pathMatch = request.title.match(/`([^`]+)`/);
        const filePath = pathMatch?.[1] ?? request.title;
        const isCreate = request.title.startsWith("Create");
        return {
          kind: "write",
          id,
          filePath,
          writeOperation: isCreate ? "create" : "modify",
        };
      }
      case "mcp":
        return {
          kind: "mcp",
          id,
          command: request.title,
          mcpDetail: request.detail,
          mcpChoices: request.choices,
        };
      case "mode-switch":
        return {
          kind: "mode-switch",
          id,
          command: request.title,
          mcpDetail: request.detail,
        };
      default:
        return {
          kind: request.kind as ApprovalRequest["kind"],
          id,
          command: request.detail ?? request.title,
          subCommands: [],
        };
    }
  }

  /**
   * Ask the user a set of questions via the chat webview and wait for responses.
   * Called by the ask_user tool handler in toolAdapter.
   */
  public requestQuestion(
    questions: import("./webview/types.js").Question[],
    sessionId: string,
  ): Promise<import("./toolAdapter.js").QuestionResponse> {
    const { randomUUID } = require("crypto") as typeof import("crypto");
    const id = randomUUID();
    // Register in the session index so agentStop can cancel only this session's questions
    const sessionSet = this.questionSessionIndex.get(sessionId) ?? new Set();
    sessionSet.add(id);
    this.questionSessionIndex.set(sessionId, sessionSet);
    return new Promise((resolve) => {
      this.pendingQuestions.set(id, (raw) => {
        this.questionSessionIndex.get(sessionId)?.delete(id);
        resolve({
          answers:
            raw.answers as import("./toolAdapter.js").QuestionResponse["answers"],
          notes: (raw.notes as Record<string, string>) ?? {},
        });
      });
      this.postMessage({ type: "agentQuestionRequest", id, questions });
    });
  }

  private setupFileWatchers(cwd: string): void {
    // Watch .agentlink/ and .claude/ for config changes
    const configPattern = new vscode.RelativePattern(
      cwd,
      ".agentlink/{commands/**,modes.json,mcp.json}",
    );
    const configWatcher =
      vscode.workspace.createFileSystemWatcher(configPattern);
    const reloadConfig = () => {
      this.slashRegistry?.reload().then(() => this.sendSlashCommands());
      this.refreshMcpConnections();
      void this.sendModesUpdate();
    };
    configWatcher.onDidChange(reloadConfig);
    configWatcher.onDidCreate(reloadConfig);
    configWatcher.onDidDelete(reloadConfig);
    this.fileWatchers.push(configWatcher);

    // Watch instruction files for system prompt hot-reload
    const instructionPattern = new vscode.RelativePattern(
      cwd,
      "{AGENTS.md,AGENT.md,CLAUDE.md,AGENTS.local.md,.claude/CLAUDE.md,.agentlink/CLAUDE.md,.agents/rules/**/*.md,.agentlink/rules/**/*.md,.agentlink/rules-*/**/*.md,.agents/rules-*/**/*.md,**/AGENTS.md,**/AGENT.md,**/AGENTS.local.md}",
    );
    const instructionWatcher =
      vscode.workspace.createFileSystemWatcher(instructionPattern);
    const reloadInstructions = () => {
      void this.rebuildSessionSystemPrompts();
    };
    instructionWatcher.onDidChange(reloadInstructions);
    instructionWatcher.onDidCreate(reloadInstructions);
    instructionWatcher.onDidDelete(reloadInstructions);
    this.fileWatchers.push(instructionWatcher);
  }

  private async rebuildSessionSystemPrompts(): Promise<void> {
    if (!this.sessionManager) return;
    try {
      await this.sessionManager.rebuildSystemPrompts();
      this.log(
        "[instructions] Rebuilt system prompt after instruction file change",
      );
    } catch (err) {
      this.log(`[instructions] Failed to rebuild system prompt: ${err}`);
    }
  }

  private async sendModesUpdate(): Promise<void> {
    const customModes = this.cwd ? await loadCustomModes(this.cwd) : [];
    const allModes = getAllModes(customModes);
    const modes = allModes.map((m) => ({
      slug: m.slug,
      name: m.name,
      icon: m.icon,
    }));
    this.postMessage({ type: "agentModesUpdate", modes } as ExtensionToWebview);
  }

  private async sendModelsUpdate(): Promise<void> {
    const allModels = providerRegistry.listAllModels();
    const authStatus = await providerRegistry.getAuthStatus();
    const config = vscode.workspace.getConfiguration("agentlink");
    const models = allModels.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      provider: m.provider,
      contextWindow: m.capabilities.contextWindow,
      authenticated: authStatus[m.provider] ?? false,
      condenseThreshold: getConfiguredBaseThresholdForModel(config, m.id),
    }));
    this.postMessage({
      type: "agentModelsUpdate",
      models,
    } as ExtensionToWebview);
  }

  private sendSlashCommands(): void {
    if (!this.slashRegistry) return;
    this.postMessage({
      type: "agentSlashCommandsUpdate",
      commands: this.slashRegistry.getAll(),
    } as ExtensionToWebview);
  }

  private sendSessionList(): void {
    const sessions = this.sessionManager?.listPersistedSessions() ?? [];
    this.postMessage({ type: "agentSessionList", sessions });
  }

  log(message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  setSessionManager(manager: AgentSessionManager): void {
    this.sessionManager = manager;

    manager.onEvent = (sessionId, event) => {
      this.handleAgentEvent(sessionId, event);
    };

    manager.onBgQuestionAnswered = (fgSessionId, bgTask, questions, answer) => {
      this.postMessage({
        type: "agentBgQuestion",
        sessionId: fgSessionId,
        bgTask,
        questions: questions.map((q) => q.question),
        answer,
      } as ExtensionToWebview);
    };

    manager.onSessionsChanged = () => {
      // Session status can change outside the foreground event stream (for example
      // when a tracked tool is force-cancelled/completed from the sidebar). Push a
      // full foreground state refresh so the chat webview's streaming/session state
      // stays aligned with the real session status, then refresh the sidebar strips.
      this.sendInitialState();
      this.sendBgSessionsUpdate();
    };
  }

  private sendBgSessionsUpdate(): void {
    if (!this.sessionManager) return;
    this.postMessage({
      type: "agentBgSessionsUpdate",
      sessions: this.sessionManager.getBgSessionInfos(),
    });
  }

  /**
   * Throttled version of sendBgSessionsUpdate for high-frequency events
   * (text_delta). Coalesces updates to fire at most once per 150ms.
   */
  private sendBgSessionsUpdateThrottled(): void {
    if (this.bgUpdateTimer) return; // already scheduled
    this.bgUpdateTimer = setTimeout(() => {
      this.bgUpdateTimer = null;
      this.sendBgSessionsUpdate();
    }, 150);
  }

  /**
   * Flush all buffered streaming deltas to the webview immediately.
   * Called on a timer (scheduleDeltaFlush) and synchronously before done/error.
   */
  private flushDeltaBuffers(): void {
    this.deltaFlushTimer = null;
    for (const [sessionId, text] of this.textDeltaBuffer) {
      this.postMessage({ type: "agentTextDelta", sessionId, text });
    }
    this.textDeltaBuffer.clear();
    for (const [sessionId, byId] of this.thinkingDeltaBuffer) {
      for (const [thinkingId, text] of byId) {
        this.postMessage({
          type: "agentThinkingDelta",
          sessionId,
          thinkingId,
          text,
        });
      }
    }
    this.thinkingDeltaBuffer.clear();
    for (const [sessionId, byId] of this.toolInputDeltaBuffer) {
      for (const [toolCallId, partialJson] of byId) {
        this.postMessage({
          type: "agentToolInputDelta",
          sessionId,
          toolCallId,
          partialJson,
        });
      }
    }
    this.toolInputDeltaBuffer.clear();
  }

  /** Schedule a delta flush ~16ms from now (idempotent). */
  private scheduleDeltaFlush(): void {
    if (this.deltaFlushTimer !== null) return;
    this.deltaFlushTimer = setTimeout(() => this.flushDeltaBuffers(), 16);
  }

  /** Cancel any pending flush timer and drain buffers immediately. */
  private flushDeltaBuffersNow(): void {
    if (this.deltaFlushTimer !== null) {
      clearTimeout(this.deltaFlushTimer);
    }
    this.flushDeltaBuffers();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };

    webviewView.webview.html = this.getHtml();
    this.webviewReady = false;

    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.webviewReady = false;
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendInitialState();
      }
    });

    webviewView.webview.onDidReceiveMessage((msg) => {
      this.handleWebviewMessage(msg);
    });
  }

  private async handleWebviewMessage(
    msg: Record<string, unknown>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (msg.command) {
      case "agentStreamDrop": {
        if (!__DEV_BUILD__) break;
        const reason = String(msg.reason ?? "");
        const eventType = String(msg.eventType ?? "unknown");
        const eventSessionId =
          msg.eventSessionId === null || msg.eventSessionId === undefined
            ? "none"
            : String(msg.eventSessionId);
        const currentSessionId =
          msg.currentSessionId === null || msg.currentSessionId === undefined
            ? "none"
            : String(msg.currentSessionId);
        const streaming = Boolean(msg.streaming);

        if (reason === "session_mismatch") {
          this.streamDropCounts.sessionMismatch += 1;
        } else if (reason === "streaming_false") {
          this.streamDropCounts.streamingFalse += 1;
        }

        if (!this.streamDropLogTimer) {
          this.streamDropLogTimer = setTimeout(() => {
            this.streamDropLogTimer = null;
            this.log(
              `[webview-drop] summary: session_mismatch=${this.streamDropCounts.sessionMismatch} streaming_false=${this.streamDropCounts.streamingFalse}`,
            );
          }, 2000);
        }

        this.log(
          `[webview-drop] reason=${reason} event=${eventType} eventSession=${eventSessionId} currentSession=${currentSessionId} streaming=${streaming}`,
        );
        break;
      }
      case "webviewReady":
        this.webviewReady = true;
        void this.sendModesUpdate();
        void this.sendModelsUpdate();
        this.sendSlashCommands();
        this.sendSessionList();
        // Flush any messages queued before the webview was ready
        for (const pending of this.pendingMessages) {
          this.view?.webview.postMessage(pending);
        }
        this.pendingMessages = [];
        // Restore last session if there is no foreground session yet
        if (!this.sessionManager?.getForegroundSession()) {
          this.postMessage({ type: "agentRestoreSessionStart" });
          this.sessionManager
            ?.restoreLastSession()
            .then((session) => {
              if (session) {
                this.postMessage({
                  type: "agentSessionLoaded",
                  sessionId: session.id,
                  title: session.title,
                  mode: session.mode,
                  messages: session.getAllMessages(),
                  lastInputTokens: session.lastInputTokens,
                  // lastOutputTokens is the per-last-request output count used for
                  // context bar display. We don't persist this value, so send 0 for
                  // loaded sessions to avoid displaying stale cumulative totals.
                  lastOutputTokens: 0,
                  restored: true,
                  checkpoints: this.getSessionCheckpoints(session.id),
                });
              }
              this.postMessage({ type: "agentRestoreSessionDone" });
              this.sendInitialState();
              void this.sendDebugInfo();
            })
            .catch(() => {
              this.postMessage({ type: "agentRestoreSessionDone" });
              this.sendInitialState();
              void this.sendDebugInfo();
            });
        } else {
          this.sendInitialState();
          void this.sendDebugInfo();
        }
        break;

      case "agentSend": {
        const text = msg.text as string;
        const mode = (msg.mode as string) ?? "code";
        const sessionId = msg.sessionId as string | undefined;
        const thinkingEnabled = msg.thinkingEnabled !== false;
        const attachments = (msg.attachments as string[]) ?? [];
        const images =
          (msg.images as
            | Array<{ name: string; mimeType: string; base64: string }>
            | undefined) ?? [];
        const documents =
          (msg.documents as
            | Array<{ name: string; mimeType: string; base64: string }>
            | undefined) ?? [];

        if (
          !text?.trim() &&
          attachments.length === 0 &&
          images.length === 0 &&
          documents.length === 0
        )
          return;

        // Resolve attachments: read file contents and build context
        const resolvedText = await this.resolveAttachments(text, attachments);

        this.log(
          `[send] session=${sessionId ?? "new"} mode=${mode} thinking=${thinkingEnabled} attachments=${attachments.length} text="${resolvedText.slice(0, 80)}${resolvedText.length > 80 ? "..." : ""}"`,
        );

        const mgr = this.sessionManager;

        // For new sessions, create the session first so we can send stateUpdate
        // with the correct sessionId BEFORE streaming events start arriving.
        // If we fire sendMessage() unawaited with no sessionId, createSession()
        // runs async inside it — getForegroundSession() below returns null and
        // the stateUpdate is never sent, causing all events to be dropped as
        // session_mismatch in the webview.
        let effectiveSessionId = sessionId;
        if (!effectiveSessionId || !mgr.getSession(effectiveSessionId)) {
          const newSession = await mgr.createSession(mode, {
            activeFilePath: vscode.window.activeTextEditor?.document.uri.fsPath,
          });
          effectiveSessionId = newSession.id;
          // Migrate any approval state that was set before the session existed
          // (stored under the "agent" fallback ID).
          this.approvalManager?.migrateSessionState(
            "agent",
            effectiveSessionId,
          );
        }

        mgr
          .sendMessage(effectiveSessionId, resolvedText, mode, {
            thinkingEnabled,
            activeFilePath: vscode.window.activeTextEditor?.document.uri.fsPath,
            images: images.length > 0 ? images : undefined,
            documents: documents.length > 0 ? documents : undefined,
          })
          .catch((err) => {
            this.log(`[error] send failed: ${err}`);
          });

        // Send updated state immediately so webview knows the session ID
        const fg = mgr.getForegroundSession();
        if (fg) {
          this.postMessage({
            type: "stateUpdate",
            state: {
              sessionId: fg.id,
              mode: fg.mode,
              model: fg.model,
              streaming: true,
              condenseThreshold: getConfiguredBaseThresholdForModel(
                vscode.workspace.getConfiguration("agentlink"),
                fg.model,
              ),
              agentWriteApproval:
                this.approvalManager?.getAgentWriteApprovalState(fg.id),
            },
          });
        }
        break;
      }

      case "agentStop": {
        const sessionId = msg.sessionId as string;
        if (sessionId) {
          const session = this.sessionManager.getSession(sessionId);
          this.sessionManager.stopSession(sessionId);
          // Clear any active agent tool calls from the sidebar tracker
          this.toolCallTracker?.clearAgentCalls(sessionId);
          // Resolve only the pending questions belonging to this session so their
          // promises unblock without cancelling unrelated sessions' question flows.
          const questionIds = this.questionSessionIndex.get(sessionId);
          if (questionIds) {
            for (const id of questionIds) {
              const resolve = this.pendingQuestions.get(id);
              if (resolve) {
                this.pendingQuestions.delete(id);
                resolve({ answers: {}, notes: {} });
              }
            }
            this.questionSessionIndex.delete(sessionId);
          }
          // Immediately notify the webview so it exits streaming state
          this.postMessage({
            type: "agentDone",
            sessionId,
            totalInputTokens: session?.totalInputTokens ?? 0,
            totalOutputTokens: session?.totalOutputTokens ?? 0,
            totalCacheReadTokens: session?.totalCacheReadTokens ?? 0,
            totalCacheCreationTokens: session?.totalCacheCreationTokens ?? 0,
          });
          // If this was a bg session, push updated status so the strip/block
          // shows the cancelled state immediately.
          if (session?.background) {
            this.sendBgSessionsUpdate();
          }
        }
        break;
      }

      case "agentRetry": {
        const sessionId = msg.sessionId as string;
        if (sessionId) {
          this.log(`[retry] retrying session ${sessionId}`);
          this.sessionManager.retrySession(sessionId).catch((err) => {
            this.log(`[error] retry failed: ${err}`);
          });
          // Update state to show streaming
          const fg = this.sessionManager.getForegroundSession();
          if (fg) {
            this.postMessage({
              type: "stateUpdate",
              state: {
                sessionId: fg.id,
                mode: fg.mode,
                model: fg.model,
                streaming: true,
                condenseThreshold: getConfiguredBaseThresholdForModel(
                  vscode.workspace.getConfiguration("agentlink"),
                  fg.model,
                ),
                agentWriteApproval:
                  this.approvalManager?.getAgentWriteApprovalState(fg.id),
              },
            });
          }
        }
        break;
      }

      case "agentNewSession": {
        const mode = (msg.mode as string) ?? "code";
        this.sessionManager.createSession(mode).then((session) => {
          this.sendInitialState();
          this.log(`New session created: ${session.id}`);
        });
        break;
      }

      case "agentSwitchMode": {
        const mode = (msg.mode as string) ?? "code";
        const fg = this.sessionManager.getForegroundSession();
        if (fg && fg.mode !== mode) {
          this.sessionManager
            .switchForegroundMode(mode)
            .then((session) => {
              if (!session) {
                // No active session — create a new one in the target mode
                return this.sessionManager!.createSession(mode);
              }
              this.approvalManager?.resetSessionAgentWriteApproval(session.id);
              return session;
            })
            .then(() => {
              this.sendInitialState();
              this.log(`[mode] user switched mode to ${mode}`);
            })
            .catch((err) => {
              this.log(`[mode] failed to switch mode: ${err}`);
            });
        } else if (!fg) {
          // No session yet — create one in the target mode
          this.sessionManager.createSession(mode).then(() => {
            this.sendInitialState();
            this.log(`[mode] new session created in mode ${mode}`);
          });
        }
        break;
      }

      case "agentClearSession": {
        // Create a fresh session with the same mode as the current one
        const fg = this.sessionManager.getForegroundSession();
        const mode = fg?.mode ?? "code";
        this.sessionManager.createSession(mode).then((session) => {
          this.sendInitialState();
          this.log(`Session cleared, new session: ${session.id}`);
        });
        break;
      }

      case "agentSetModel": {
        const model = msg.model as string;
        if (!model) break;
        // Update config, session model, and rebuild system prompt if provider changed
        await this.sessionManager.setModel(model);
        // Persist to VS Code global settings so it survives restarts
        vscode.workspace
          .getConfiguration("agentlink")
          .update("agentModel", model, vscode.ConfigurationTarget.Global);
        this.sendInitialState();
        this.log(`Model changed to: ${model}`);
        break;
      }

      case "agentSetCondenseThreshold": {
        const threshold = Number(msg.threshold);
        if (!Number.isFinite(threshold)) break;
        const config = vscode.workspace.getConfiguration("agentlink");
        const currentModel =
          this.sessionManager.getForegroundSession()?.model ??
          this.sessionManager.getConfig().model;
        const thresholds = {
          ...(config.get("modelCondenseThresholds") as
            | Record<string, number>
            | undefined),
          [currentModel]: Math.min(1, Math.max(0.1, threshold)),
        };
        await config.update(
          "modelCondenseThresholds",
          thresholds,
          vscode.ConfigurationTarget.Global,
        );
        this.sessionManager.updateConfig({
          autoCondenseThreshold: thresholds[currentModel],
        });
        const fg = this.sessionManager.getForegroundSession();
        if (fg && fg.model === currentModel) {
          fg.autoCondenseThreshold = thresholds[currentModel];
          await this.sessionManager.maybeAutoCondenseForegroundSession();
        }
        this.sendInitialState();
        this.log(
          `Auto-condense threshold set to ${Math.round(thresholds[currentModel] * 100)}% for ${currentModel}`,
        );
        break;
      }

      case "agentSetWriteApproval": {
        const mode = msg.mode as string;
        if (!mode || !this.approvalManager) break;
        // Use the foreground session's actual ID so session-level approvals are
        // scoped per chat session (not shared across all foreground sessions).
        const fgSession = this.sessionManager?.getForegroundSession();
        const fgSessionId = fgSession?.id ?? "agent";
        this.approvalManager.resetAgentWriteApproval();
        if (mode !== "prompt") {
          this.approvalManager.setAgentWriteApproval(
            fgSessionId,
            mode as "session" | "project" | "global",
          );
        }
        this.sendInitialState();
        this.log(`Agent write approval changed to: ${mode}`);
        break;
      }

      case "agentMcpAction": {
        const serverName = msg.serverName as string;
        const action = msg.action as "disable" | "reconnect" | "reauthenticate";
        if (!serverName || !action) break;
        if (action === "disable") {
          await this.mcpHub.disableServer(serverName);
        } else if (action === "reconnect") {
          await this.mcpHub.reconnectServer(serverName);
        } else if (action === "reauthenticate") {
          await this.mcpHub.reauthenticateServer(serverName);
        }
        // Push updated status to webview
        this.postMessage({
          type: "agentMcpStatus",
          infos: this.mcpHub.getServerInfos(),
        } as ExtensionToWebview);
        break;
      }

      case "agentElicitationResponse": {
        const id = msg.id as string;
        const pending = this.pendingElicitations.get(id);
        if (!pending) break;
        this.pendingElicitations.delete(id);
        if (msg.cancelled) {
          pending.cancel();
        } else {
          pending.resolve(msg.values as Record<string, unknown>);
        }
        break;
      }

      case "approvalDecision": {
        const id = msg.id as string;

        const resolveInline = this.pendingApprovals.get(id);
        if (resolveInline) {
          this.pendingApprovals.delete(id);
          resolveInline({
            decision: String(msg.decision ?? "reject"),
            rejectionReason:
              (msg.rejectionReason as string | undefined) ?? undefined,
            followUp: (msg.followUp as string | undefined) ?? undefined,
            trustScope: (msg.trustScope as string | undefined) ?? undefined,
            rulePattern: (msg.rulePattern as string | undefined) ?? undefined,
            ruleMode: (msg.ruleMode as string | undefined) ?? undefined,
          });
          break;
        }

        const respond = this.pendingForwardedApprovals.get(id);
        if (!respond) break;
        this.pendingForwardedApprovals.delete(id);
        // Build a DecisionMessage from the webview payload
        const decision: DecisionMessage = {
          type: "decision",
          id,
          decision: msg.decision as string,
          editedCommand: msg.editedCommand as string | undefined,
          rejectionReason: msg.rejectionReason as string | undefined,
          rulePattern: msg.rulePattern as string | undefined,
          ruleMode: msg.ruleMode as string | undefined,
          rules: msg.rules as DecisionMessage["rules"],
          trustScope: msg.trustScope as string | undefined,
          followUp: msg.followUp as string | undefined,
        };
        respond(decision);
        break;
      }

      case "agentQuestionResponse": {
        const id = msg.id as string;
        const resolve = this.pendingQuestions.get(id);
        if (!resolve) break;
        this.pendingQuestions.delete(id);
        resolve({
          answers: msg.answers as Record<
            string,
            string | string[] | number | boolean | undefined
          >,
          notes: (msg.notes as Record<string, string>) ?? {},
        });
        break;
      }

      case "agentRefreshSlashCommands": {
        this.slashRegistry?.reload().then(() => {
          this.sendSlashCommands();
          this.log(
            `[slash] refreshed: ${this.slashRegistry?.getAll().length ?? 0} commands`,
          );
        });
        break;
      }

      case "agentSlashCommand": {
        const name = msg.name as string;
        if (name === "condense") {
          const fg = this.sessionManager?.getForegroundSession();
          await this.sessionManager?.condenseCurrentSession();
          // Manual condense doesn't go through run() — emit agentDone so the
          // webview drains any messages queued during the condense operation.
          if (fg) {
            this.postMessage({
              type: "agentDone",
              sessionId: fg.id,
              totalInputTokens: fg.totalInputTokens,
              totalOutputTokens: fg.totalOutputTokens,
              totalCacheReadTokens: fg.totalCacheReadTokens,
              totalCacheCreationTokens: fg.totalCacheCreationTokens,
            });
          }
        } else if (name === "checkpoint") {
          const checkpoint =
            await this.sessionManager?.createManualCheckpoint();
          if (!checkpoint) {
            vscode.window.showInformationMessage(
              "No active session state is available to checkpoint yet.",
            );
            break;
          }
          vscode.window.showInformationMessage(
            `Checkpoint created: ${checkpoint.id.slice(0, 8)}`,
          );
        } else if (name === "revert") {
          const fg = this.sessionManager?.getForegroundSession();
          if (!fg || !this.sessionManager) break;
          const checkpoints = this.sessionManager.getCheckpoints(fg.id);
          if (checkpoints.length === 0) {
            vscode.window.showInformationMessage("No checkpoints available.");
            break;
          }

          const query = String(msg.args ?? "").trim();
          const checkpoint = query
            ? checkpoints.find(
                (candidate) =>
                  candidate.id === query || candidate.id.startsWith(query),
              )
            : checkpoints[checkpoints.length - 1];

          if (!checkpoint) {
            vscode.window.showWarningMessage(
              `No checkpoint matched "${query}".`,
            );
            break;
          }

          await this.revertCheckpointWithConfirmation(fg.id, checkpoint.id);
        } else if (name === "mcp") {
          const scope =
            (msg.args as string) === "global" ? "global" : "project";
          await this.openMcpConfig(scope);
        } else if (name === "mcp-refresh") {
          await this.refreshMcpConnections();
          vscode.window.showInformationMessage("MCP servers reconnected.");
        } else if (name === "mcp-status") {
          const infos = this.mcpHub.getServerInfos();
          this.postMessage({
            type: "agentMcpStatus",
            infos,
            open: true,
          } as ExtensionToWebview);
        } else if (name === "btw") {
          const question = String(msg.args ?? "").trim();
          if (question) {
            void this.handleBtwQuestion(question);
          }
        } else {
          this.log(`[slash] /${name} not yet implemented`);
          vscode.window.showInformationMessage(
            `Unknown slash command: /${name}`,
          );
        }
        break;
      }

      case "agentOpenFile": {
        const filePath = msg.path as string;
        const line = msg.line as number | undefined;
        if (!filePath) break;
        const path = require("path");
        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        const absPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(workspaceRoot, filePath);
        const uri = vscode.Uri.file(absPath);
        const options: vscode.TextDocumentShowOptions = {};
        if (line) {
          const pos = new vscode.Position(line - 1, 0);
          options.selection = new vscode.Range(pos, pos);
        }
        vscode.window.showTextDocument(uri, options).then(undefined, (err) => {
          this.log(`[error] Failed to open file: ${err}`);
        });
        break;
      }

      case "openBgTranscript": {
        const sessionId = msg.sessionId as string;
        if (sessionId) {
          const session = this.sessionManager?.getSession(sessionId);
          if (session) {
            this.postMessage({
              type: "showBgTranscript",
              sessionId,
              task: session.title ?? "Background Agent",
              messages: session.getAllMessages(),
            });
          } else {
            vscode.window.showWarningMessage(
              "Background agent session not found — it may have been cleaned up.",
            );
          }
        }
        break;
      }

      case "agentOpenSpecialBlockPanel": {
        const kind = msg.kind as "mermaid" | "vega" | "vega-lite";
        const source = msg.source as string;
        if (!source?.trim()) break;
        if (!["mermaid", "vega", "vega-lite"].includes(kind)) break;
        this.openSpecialBlockPanel(kind, source);
        break;
      }

      case "agentResolveDroppedFiles": {
        const paths = msg.paths as string[];
        if (!Array.isArray(paths)) break;
        const pathMod = require("path");
        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        const resolved = paths.map((p: string) =>
          workspaceRoot ? pathMod.relative(workspaceRoot, p) : p,
        );
        this.postMessage({
          type: "agentDroppedFilesResolved",
          files: resolved,
        } as ExtensionToWebview);
        break;
      }

      case "agentAttachFile": {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          canSelectFiles: true,
          canSelectFolders: false,
          defaultUri: workspaceRoot,
          title: "Attach files to chat",
        });
        if (uris?.length) {
          const pathMod = require("path");
          const wsRoot = workspaceRoot?.fsPath ?? "";
          const resolved = uris.map((u) =>
            wsRoot ? pathMod.relative(wsRoot, u.fsPath) : u.fsPath,
          );
          this.postMessage({
            type: "agentDroppedFilesResolved",
            files: resolved,
          } as ExtensionToWebview);
        }
        break;
      }

      case "agentSearchFiles": {
        const query = msg.query as string;
        const requestId = msg.requestId as string;
        if (!query || !requestId) break;
        this.searchWorkspaceFiles(query, requestId);
        break;
      }

      case "agentExportTranscript": {
        const messages = msg.messages as Array<{
          role: string;
          content: string;
          timestamp: number;
          blocks: Array<{
            type: string;
            text?: string;
            name?: string;
            inputJson?: string;
            result?: string;
            durationMs?: number;
          }>;
        }>;
        this.exportTranscript(messages);
        break;
      }

      case "agentListSessions": {
        const sessions = this.sessionManager?.listPersistedSessions() ?? [];
        this.postMessage({ type: "agentSessionList", sessions });
        break;
      }

      case "agentLoadSession": {
        const sessionId = msg.sessionId as string;
        if (!sessionId || !this.sessionManager) break;
        const session =
          await this.sessionManager.loadPersistedSession(sessionId);
        if (!session) {
          this.log(`[history] session not found: ${sessionId}`);
          break;
        }
        this.postMessage({
          type: "agentSessionLoaded",
          sessionId: session.id,
          title: session.title,
          mode: session.mode,
          messages: session.getAllMessages(),
          lastInputTokens: session.lastInputTokens,
          lastOutputTokens: 0, // per-last-request value not persisted; 0 avoids stale cumulative display
          checkpoints: this.getSessionCheckpoints(session.id),
        });
        this.sendInitialState();
        break;
      }

      case "agentDeleteSession": {
        const sessionId = msg.sessionId as string;
        if (!sessionId || !this.sessionManager) break;
        this.sessionManager.deletePersistedSession(sessionId);
        this.approvalManager?.clearSession(sessionId);
        const sessions = this.sessionManager.listPersistedSessions();
        this.postMessage({ type: "agentSessionList", sessions });
        break;
      }

      case "agentRenameSession": {
        const sessionId = msg.sessionId as string;
        const title = msg.title as string;
        if (!sessionId || !title || !this.sessionManager) break;
        this.sessionManager.renamePersistedSession(sessionId, title);
        const sessions = this.sessionManager.listPersistedSessions();
        this.postMessage({ type: "agentSessionList", sessions });
        break;
      }

      case "agentRevertCheckpoint": {
        const sessionId = msg.sessionId as string;
        const checkpointId = msg.checkpointId as string;
        if (!sessionId || !checkpointId || !this.sessionManager) break;
        await this.revertCheckpointWithConfirmation(sessionId, checkpointId);
        break;
      }

      case "agentViewCheckpointDiff": {
        const sessionId = msg.sessionId as string;
        const checkpointId = msg.checkpointId as string;
        const scope = (msg.scope as "turn" | "all") ?? "turn";
        if (!sessionId || !checkpointId || !this.sessionManager) break;
        await this.openCheckpointDiff(sessionId, checkpointId, scope);
        break;
      }

      case "agentQueueMessage": {
        const sessionId = msg.sessionId as string;
        const text = msg.text as string;
        const queueId = msg.queueId as string;
        const displayText = msg.displayText as string | undefined;
        const attachments = (msg.attachments as string[] | undefined) ?? [];
        const images =
          (msg.images as
            | Array<{ name: string; mimeType: string; base64: string }>
            | undefined) ?? [];
        const documents =
          (msg.documents as
            | Array<{ name: string; mimeType: string; base64: string }>
            | undefined) ?? [];
        if (
          sessionId &&
          queueId &&
          this.sessionManager &&
          (text ||
            attachments.length > 0 ||
            images.length > 0 ||
            documents.length > 0)
        ) {
          const session = this.sessionManager.getSession(sessionId);
          session?.setPendingInterjection(
            text,
            queueId,
            displayText,
            attachments.length > 0 ? attachments : undefined,
            images.length > 0 ? images : undefined,
            documents.length > 0 ? documents : undefined,
          );
        }
        break;
      }

      case "agentUpdateQueuedMessage": {
        const sessionId = msg.sessionId as string;
        const text = msg.text as string;
        const queueId = msg.queueId as string;
        const displayText = msg.displayText as string | undefined;
        const attachments = (msg.attachments as string[] | undefined) ?? [];
        const images =
          (msg.images as
            | Array<{ name: string; mimeType: string; base64: string }>
            | undefined) ?? [];
        const documents =
          (msg.documents as
            | Array<{ name: string; mimeType: string; base64: string }>
            | undefined) ?? [];
        if (
          sessionId &&
          queueId &&
          this.sessionManager &&
          (text ||
            attachments.length > 0 ||
            images.length > 0 ||
            documents.length > 0)
        ) {
          const session = this.sessionManager.getSession(sessionId);
          session?.updatePendingInterjection(queueId, {
            text,
            displayText,
            attachments: attachments.length > 0 ? attachments : undefined,
            images: images.length > 0 ? images : undefined,
            documents: documents.length > 0 ? documents : undefined,
          });
        }
        break;
      }

      case "agentRemoveQueuedMessage": {
        const sessionId = msg.sessionId as string;
        const queueId = msg.queueId as string;
        if (sessionId && queueId && this.sessionManager) {
          const session = this.sessionManager.getSession(sessionId);
          session?.clearPendingInterjectionIf(queueId);
        }
        break;
      }

      case "agentCodexSignIn": {
        // Trigger unified OpenAI/Codex sign-in from the webview model picker.
        vscode.commands.executeCommand("agentlink.codexSignIn");
        break;
      }

      case "agentAnthropicSignIn": {
        // Trigger Anthropic API key entry from the webview model picker
        vscode.commands.executeCommand("agentlink.setAnthropicApiKey");
        break;
      }

      case "agentCodexSignOut": {
        vscode.commands.executeCommand("agentlink.codexSignOut");
        break;
      }

      case "agentCopyFirstPrompt": {
        const sessionId = msg.sessionId as string;
        if (!sessionId || !this.sessionManager) break;
        const messages = this.sessionManager.loadFirstPrompt(sessionId);
        if (messages) {
          this.postMessage({
            type: "agentInjectPrompt",
            prompt: messages,
            attachments: [],
          } as ExtensionToWebview);
        }
        break;
      }
    }
  }

  private handleAgentEvent(sessionId: string, event: AgentEvent): void {
    // Route foreground and background streams separately so foreground transcript
    // rendering does not depend on session-ID filtering in the webview.
    const isBackground = Boolean(
      this.sessionManager?.getSession(sessionId)?.background,
    );

    // Log all events to the output channel
    switch (event.type) {
      case "thinking_start":
        this.log(`[agent] thinking_start id=${event.thinkingId}`);
        this.postMessage({
          type: isBackground ? "agentBgThinkingStart" : "agentThinkingStart",
          sessionId,
          thinkingId: event.thinkingId,
        });
        break;

      case "thinking_delta":
        // Don't log every delta — too noisy
        if (isBackground) {
          this.postMessage({
            type: "agentBgThinkingDelta",
            sessionId,
            thinkingId: event.thinkingId,
            text: event.text,
          });
        } else {
          const tMap =
            this.thinkingDeltaBuffer.get(sessionId) ??
            new Map<string, string>();
          tMap.set(
            event.thinkingId,
            (tMap.get(event.thinkingId) ?? "") + event.text,
          );
          this.thinkingDeltaBuffer.set(sessionId, tMap);
          this.scheduleDeltaFlush();
        }
        break;

      case "thinking_end":
        this.log(`[agent] thinking_end id=${event.thinkingId}`);
        // Flush buffered thinking deltas before marking complete so content
        // arrives at the webview before the block is sealed.
        this.flushDeltaBuffersNow();
        this.postMessage({
          type: isBackground ? "agentBgThinkingEnd" : "agentThinkingEnd",
          sessionId,
          thinkingId: event.thinkingId,
        });
        break;

      case "text_delta":
        // Don't log every delta — too noisy
        if (isBackground) {
          this.postMessage({
            type: "agentBgTextDelta",
            sessionId,
            text: event.text,
          });
        } else {
          this.textDeltaBuffer.set(
            sessionId,
            (this.textDeltaBuffer.get(sessionId) ?? "") + event.text,
          );
          this.scheduleDeltaFlush();
        }
        // Keep bg strip in sync with streaming text (throttled to avoid flooding)
        if (isBackground) {
          this.sendBgSessionsUpdateThrottled();
        }
        break;

      case "tool_start":
        this.log(
          `[agent] tool_start tool=${event.toolName} id=${event.toolCallId}`,
        );
        // Flush buffered text deltas before the tool card so pre-tool text
        // arrives at the webview before agentToolStart, preserving natural order.
        this.flushDeltaBuffersNow();
        this.postMessage({
          type: isBackground ? "agentBgToolStart" : "agentToolStart",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        });
        // Keep bg strip in sync when a bg session starts a new tool
        if (isBackground) {
          this.sendBgSessionsUpdate();
        }
        break;

      case "tool_input_delta":
        const iMap =
          this.toolInputDeltaBuffer.get(sessionId) ?? new Map<string, string>();
        iMap.set(
          event.toolCallId,
          (iMap.get(event.toolCallId) ?? "") + event.partialJson,
        );
        this.toolInputDeltaBuffer.set(sessionId, iMap);
        this.scheduleDeltaFlush();
        break;

      case "checkpoint_created":
        this.log(
          `[agent] checkpoint_created id=${event.checkpointId} turn=${event.turnIndex}`,
        );
        this.postMessage({
          type: "agentCheckpointCreated",
          sessionId,
          checkpointId: event.checkpointId,
          turnIndex: event.turnIndex,
        } as ExtensionToWebview);
        break;

      case "todo_update":
        this.postMessage({
          type: "agentTodoUpdate",
          sessionId,
          todos: event.todos,
        } as ExtensionToWebview);
        break;

      case "tool_result": {
        // Convert tool result content to a string for the webview
        // Flush buffered tool input deltas before marking the tool complete
        // so the webview sees the full input JSON before the result arrives.
        this.flushDeltaBuffersNow();
        const resultText = event.result
          .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
          .join("\n");
        this.log(
          `[agent] tool_result tool=${event.toolName} id=${event.toolCallId} duration=${event.durationMs}ms`,
        );
        this.postMessage({
          type: isBackground ? "agentBgToolComplete" : "agentToolComplete",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: resultText,
          durationMs: event.durationMs,
          input: event.input,
        });
        // Emit user-visible annotation for follow-ups and user rejections
        try {
          const parsed = JSON.parse(resultText);
          if (parsed.follow_up) {
            this.postMessage({
              type: "agentUserAnnotation",
              sessionId,
              text: parsed.follow_up,
              badge: "follow-up",
            });
          } else if (parsed.status === "rejected_by_user" && parsed.reason) {
            this.postMessage({
              type: "agentUserAnnotation",
              sessionId,
              text: parsed.reason,
              badge: "rejection",
            });
          }
        } catch {
          // result is not JSON — no annotation needed
        }
        break;
      }

      case "api_request":
        this.log(
          `[agent] api_request model=${event.model} in=${event.inputTokens} out=${event.outputTokens} ` +
            `cacheRead=${event.cacheReadTokens} cacheCreate=${event.cacheCreationTokens} ` +
            `duration=${event.durationMs}ms ttft=${event.timeToFirstToken}ms`,
        );
        this.postMessage({
          type: isBackground ? "agentBgApiRequest" : "agentApiRequest",
          sessionId,
          requestId: event.requestId,
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheCreationTokens: event.cacheCreationTokens,
          durationMs: event.durationMs,
          timeToFirstToken: event.timeToFirstToken,
        });
        break;

      case "error": {
        this.flushDeltaBuffersNow();
        this.log(
          `[agent] error: ${event.error} (retryable=${event.retryable})`,
        );
        const session = this.sessionManager?.getSession(sessionId);
        if (session) {
          session.appendRuntimeError(event.error, event.retryable);
          this.sessionManager?.saveSession(sessionId);
        }
        this.postMessage({
          type: isBackground ? "agentBgError" : "agentError",
          sessionId,
          error: event.error,
          retryable: event.retryable,
        });
        // Keep bg strip in sync on error (flush any pending throttled update)
        if (isBackground) {
          if (this.bgUpdateTimer) {
            clearTimeout(this.bgUpdateTimer);
            this.bgUpdateTimer = null;
          }
          this.sendBgSessionsUpdate();
        }
        break;
      }

      case "condense_start":
        this.condenseStartTimes.set(sessionId, Date.now());
        this.postMessage({
          type: "agentCondenseStart",
          sessionId,
          isAutomatic: event.isAutomatic,
        });
        break;

      case "condense":
        this.log(
          `[agent] condensed: prev=${event.prevInputTokens} new=${event.newInputTokens}`,
        );
        const condenseDurationMs = this.condenseStartTimes.has(sessionId)
          ? Date.now() - this.condenseStartTimes.get(sessionId)!
          : 0;
        this.condenseStartTimes.delete(sessionId);
        this.postMessage({
          type: "agentCondense",
          sessionId,
          prevInputTokens: event.prevInputTokens,
          newInputTokens: event.newInputTokens,
          summary: event.summary,
          durationMs: condenseDurationMs,
          validationWarnings: event.validationWarnings,
          metadata: event.metadata,
        });
        if (__DEV_BUILD__ && this.cwd) {
          this.writeCondenseDebug(sessionId, event).catch((err) => {
            this.log(`[agent] condense debug export failed: ${err}`);
          });
        }
        break;

      case "warning":
        this.log(`[agent] warning: ${event.message}`);
        this.postMessage({
          type: "agentWarning",
          sessionId,
          message: event.message,
        });
        break;

      case "status_update":
        this.log(`[agent] status_update: ${event.message}`);
        this.postMessage({
          type: "agentStatusUpdate",
          sessionId,
          message: event.message,
        });
        break;

      case "condense_error":
        this.log(`[agent] condense_error: ${event.error}`);
        this.postMessage({
          type: "agentCondenseError",
          sessionId,
          error: event.error,
        });
        break;

      case "user_interjection":
        this.log(`[agent] user_interjection queueId=${event.queueId}`);
        // Suppress interjection UI for bg question injections — these are
        // rendered as collapsible Q&A blocks via onBgQuestionAnswered instead.
        if (!event.queueId.startsWith("bg-q-")) {
          this.postMessage({
            type: "agentInterjection",
            sessionId,
            text: event.text,
            queueId: event.queueId,
            displayText: event.displayText,
          });
        }
        break;

      case "done":
        this.flushDeltaBuffersNow();
        // Clean up any lingering agent tool calls from the sidebar tracker
        this.toolCallTracker?.clearAgentCalls(sessionId);
        this.log(
          `[agent] done totalIn=${event.totalInputTokens} totalOut=${event.totalOutputTokens} ` +
            `cacheRead=${event.totalCacheReadTokens} cacheCreate=${event.totalCacheCreationTokens}`,
        );
        this.postMessage({
          type: isBackground ? "agentBgDone" : "agentDone",
          sessionId,
          totalInputTokens: event.totalInputTokens,
          totalOutputTokens: event.totalOutputTokens,
          totalCacheReadTokens: event.totalCacheReadTokens,
          totalCacheCreationTokens: event.totalCacheCreationTokens,
          ...(isBackground && {
            resultText:
              this.sessionManager
                ?.getSession(sessionId)
                ?.getLastAssistantText() ?? undefined,
          }),
        });
        // Refresh session list after save (SessionStore.save is called in SessionManager)
        this.sendSessionList();
        // Keep bg strip in sync on done (flush any pending throttled update)
        if (isBackground) {
          if (this.bgUpdateTimer) {
            clearTimeout(this.bgUpdateTimer);
            this.bgUpdateTimer = null;
          }
          this.sendBgSessionsUpdate();
        }
        break;
    }
  }

  private async writeCondenseDebug(
    sessionId: string,
    event: {
      prevInputTokens: number;
      newInputTokens: number;
      summary: string;
      validationWarnings?: string[];
      metadata?: {
        inputMessageCount: number;
        sourceUserMessageCount: number;
        hadPriorSummaryInInput: boolean;
        retryUsed: boolean;
        validatorErrors: string[];
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
    },
  ): Promise<void> {
    const { randomUUID: uuid } = require("crypto") as typeof import("crypto");
    const id = uuid().slice(0, 8);
    const dir = path.join(this.cwd, ".agentlink", "debug", "condensing", id);
    fs.mkdirSync(dir, { recursive: true });

    // Write summary result
    const summaryLines = [
      `# Condense Result`,
      ``,
      `**Session:** ${sessionId}`,
      `**Date:** ${new Date().toISOString()}`,
      `**Tokens before:** ${event.prevInputTokens.toLocaleString()}`,
      `**Tokens after:** ${event.newInputTokens.toLocaleString()}`,
      `**Reduction:** ${Math.round(((event.prevInputTokens - event.newInputTokens) / event.prevInputTokens) * 100)}%`,
      ``,
      `---`,
      ``,
      `## Summary`,
      ``,
      event.summary,
    ];
    if (event.validationWarnings && event.validationWarnings.length > 0) {
      summaryLines.push(``);
      summaryLines.push(`## Validation Warnings`);
      summaryLines.push(``);
      for (const warning of event.validationWarnings) {
        summaryLines.push(`- ${warning}`);
      }
    }
    if (event.metadata) {
      summaryLines.push(``);
      summaryLines.push(`## Metadata`);
      summaryLines.push(``);
      summaryLines.push(`- providerId: ${event.metadata.providerId}`);
      summaryLines.push(`- condenseModel: ${event.metadata.condenseModel}`);
      summaryLines.push(
        `- modelCandidates: ${event.metadata.modelCandidates.join(" | ")}`,
      );
      summaryLines.push(`- selectedModel: ${event.metadata.selectedModel}`);
      summaryLines.push(
        `- inputMessageCount: ${event.metadata.inputMessageCount}`,
      );
      summaryLines.push(
        `- sourceUserMessageCount: ${event.metadata.sourceUserMessageCount}`,
      );
      summaryLines.push(
        `- requestMessageCount: ${event.metadata.requestMessageCount}`,
      );
      summaryLines.push(
        `- effectiveHistoryMessageCount: ${event.metadata.effectiveHistoryMessageCount}`,
      );
      summaryLines.push(
        `- effectiveHistoryRoles: ${event.metadata.effectiveHistoryRoles.join(" | ")}`,
      );
      summaryLines.push(
        `- hadPriorSummaryInInput: ${event.metadata.hadPriorSummaryInInput}`,
      );
      summaryLines.push(`- retryUsed: ${event.metadata.retryUsed}`);
      summaryLines.push(`- sourceHash: ${event.metadata.sourceHash}`);
      if (event.metadata.validatorErrors.length > 0) {
        summaryLines.push(
          `- validatorErrors: ${event.metadata.validatorErrors.join(" | ")}`,
        );
      }

      summaryLines.push(``);
      summaryLines.push(`## Resume Anchor Inputs`);
      summaryLines.push(``);
      summaryLines.push(
        `- latestUserMessage: ${event.metadata.latestUserMessage}`,
      );
      summaryLines.push(`- currentTask: ${event.metadata.currentTask}`);

      summaryLines.push(``);
      summaryLines.push(`### Pending Tasks`);
      summaryLines.push(``);
      if (event.metadata.pendingTasks.length > 0) {
        for (const task of event.metadata.pendingTasks) {
          summaryLines.push(`- ${task}`);
        }
      } else {
        summaryLines.push(`- None`);
      }

      summaryLines.push(``);
      summaryLines.push(`### Canonical User Messages`);
      summaryLines.push(``);
      if (event.metadata.canonicalUserMessages.length > 0) {
        for (const message of event.metadata.canonicalUserMessages) {
          summaryLines.push(`- ${message}`);
        }
      } else {
        summaryLines.push(`- None`);
      }
    }
    fs.writeFileSync(
      path.join(dir, "condense-result.md"),
      summaryLines.join("\n"),
      "utf-8",
    );

    // Write full session transcript
    const session = this.sessionManager?.getSession(sessionId);
    if (session) {
      const transcriptLines: string[] = [
        `# Session Transcript (at time of condensing)`,
        ``,
        `**Session:** ${sessionId}`,
        `**Date:** ${new Date().toISOString()}`,
        ``,
        `---`,
        ``,
      ];
      for (const msg of session.getAllMessages()) {
        const role = msg.isSummary
          ? "Condense Summary"
          : msg.role === "user"
            ? "User"
            : "Assistant";
        transcriptLines.push(`## ${role}`);
        transcriptLines.push(``);
        if (typeof msg.content === "string") {
          transcriptLines.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text") {
              transcriptLines.push(block.text);
            } else if (block.type === "tool_use") {
              transcriptLines.push(
                `**Tool call:** ${block.name}\n\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\``,
              );
            } else if (block.type === "tool_result") {
              const resultText = Array.isArray(block.content)
                ? block.content
                    .map((c: { type: string; text?: string }) =>
                      c.type === "text" ? c.text : `[${c.type}]`,
                    )
                    .join("\n")
                : String(block.content);
              transcriptLines.push(
                `**Tool result** (id=${block.tool_use_id}):\n\`\`\`\n${resultText}\n\`\`\``,
              );
            }
          }
        }
        transcriptLines.push(``);
        transcriptLines.push(`---`);
        transcriptLines.push(``);
      }
      fs.writeFileSync(
        path.join(dir, "transcript.md"),
        transcriptLines.join("\n"),
        "utf-8",
      );
    }

    this.log(
      `[agent] condense debug exported to .agentlink/debug/condensing/${id}/`,
    );
  }

  private async exportTranscript(
    messages: Array<{
      role: string;
      content: string;
      timestamp: number;
      blocks: Array<{
        type: string;
        text?: string;
        name?: string;
        inputJson?: string;
        result?: string;
        durationMs?: number;
      }>;
    }>,
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder open.");
      return;
    }

    const fs = require("fs");
    const path = require("path");
    const dir = path.join(workspaceRoot, ".agentlink", "transcripts");
    fs.mkdirSync(dir, { recursive: true });

    const now = new Date();
    const timestamp = now
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\.\d+Z$/, "");
    const filePath = path.join(dir, `${timestamp}.md`);

    const lines: string[] = [
      `# Agent Transcript`,
      ``,
      `**Date:** ${now.toLocaleString()}`,
      ``,
      `---`,
      ``,
    ];

    for (const msg of messages) {
      const role = msg.role === "user" ? "User" : "Assistant";
      lines.push(`## ${role}`);
      lines.push(``);

      if (msg.role === "user") {
        lines.push(msg.content);
        lines.push(``);
        continue;
      }

      // Assistant: render blocks in order
      for (const block of msg.blocks ?? []) {
        switch (block.type) {
          case "thinking":
            lines.push(`<details><summary>Thinking</summary>`);
            lines.push(``);
            lines.push(block.text ?? "");
            lines.push(``);
            lines.push(`</details>`);
            lines.push(``);
            break;

          case "text":
            lines.push(block.text ?? "");
            lines.push(``);
            break;

          case "tool_call": {
            const duration = block.durationMs ? ` (${block.durationMs}ms)` : "";
            lines.push(`**Tool: ${block.name}**${duration}`);
            if (block.inputJson) {
              lines.push(``);
              lines.push(`\`\`\`json`);
              lines.push(block.inputJson);
              lines.push(`\`\`\``);
            }
            if (block.result) {
              lines.push(``);
              lines.push(`<details><summary>Result</summary>`);
              lines.push(``);
              lines.push(`\`\`\``);
              lines.push(block.result);
              lines.push(`\`\`\``);
              lines.push(``);
              lines.push(`</details>`);
            }
            lines.push(``);
            break;
          }
        }
      }

      lines.push(`---`);
      lines.push(``);
    }

    fs.writeFileSync(filePath, lines.join("\n"), "utf-8");

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: true });
    this.log(`Transcript exported to ${filePath}`);
  }

  /**
   * Handle /btw side question: make a one-shot completion using the current
   * session's context, without modifying conversation history.
   */
  private async handleBtwQuestion(question: string): Promise<void> {
    const requestId = randomUUID();

    this.postMessage({
      type: "agentBtwLoading",
      requestId,
      question,
    } as ExtensionToWebview);

    const fg = this.sessionManager?.getForegroundSession();
    const systemPrompt = fg?.systemPrompt ?? "";
    const model =
      fg?.model ??
      this.sessionManager?.getConfig().model ??
      "claude-sonnet-4-6";

    // Build provider-safe messages: use the effective API history (already
    // filtered for condense) and append the side question.
    const sessionMessages = fg?.getMessages() ?? [];
    const messages: import("./providers/types.js").MessageParam[] = [
      ...sessionMessages,
      { role: "user", content: question },
    ];

    try {
      const provider = providerRegistry.resolveProvider(model);
      const result = await provider.complete({
        model,
        systemPrompt,
        messages,
        maxTokens: 4096,
      });

      this.postMessage({
        type: "agentBtwResponse",
        requestId,
        question,
        answer: result.text,
      } as ExtensionToWebview);

      this.log(
        `[btw] answered (${result.usage?.inputTokens ?? "?"}in/${result.usage?.outputTokens ?? "?"}out)`,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`[btw] error: ${errorMsg}`);
      this.postMessage({
        type: "agentBtwResponse",
        requestId,
        question,
        answer: errorMsg,
        error: true,
      } as ExtensionToWebview);
    }
  }

  private async revertCheckpointWithConfirmation(
    sessionId: string,
    checkpointId: string,
  ): Promise<void> {
    if (!this.sessionManager) return;

    const preview = await this.sessionManager.previewRevert(
      sessionId,
      checkpointId,
    );

    const affected: string[] = [
      ...(preview?.modified.map((f) => `  ~ ${f}`) ?? []),
      ...(preview?.deleted.map((f) => `  - ${f}`) ?? []),
      ...(preview?.restored.map((f) => `  + ${f}`) ?? []),
    ];
    const detail =
      affected.length > 0
        ? `\n\nAffected files:\n${affected.slice(0, 20).join("\n")}${affected.length > 20 ? `\n  ...and ${affected.length - 20} more` : ""}`
        : "\n\nNo file changes detected.";

    const confirmed = await vscode.window.showWarningMessage(
      `Revert workspace to this checkpoint?${detail}`,
      { modal: true },
      "Revert",
    );

    if (confirmed !== "Revert") return;

    const ok = await this.sessionManager.revertToCheckpoint(
      sessionId,
      checkpointId,
    );

    if (ok) {
      this.log(
        `[agent] Reverted session ${sessionId} to checkpoint ${checkpointId}`,
      );
      const session = this.sessionManager.getSession(sessionId);
      if (session) {
        this.postMessage({
          type: "agentSessionLoaded",
          sessionId: session.id,
          title: session.title,
          mode: session.mode,
          messages: session.getAllMessages(),
          lastInputTokens: session.lastInputTokens,
          lastOutputTokens: 0,
          checkpoints: this.getSessionCheckpoints(session.id),
        });
      }
      this.sendInitialState();
      vscode.window.showInformationMessage("Reverted to checkpoint.");
    } else {
      vscode.window.showErrorMessage(
        "Failed to revert checkpoint. Check the AgentLink Agent output channel for details.",
      );
    }
  }

  private async openCheckpointDiff(
    sessionId: string,
    checkpointId: string,
    scope: "turn" | "all",
  ): Promise<void> {
    if (!this.sessionManager) return;

    const diff = await this.sessionManager.getCheckpointDiff(
      sessionId,
      checkpointId,
      scope,
    );

    if (!diff) {
      vscode.window.showInformationMessage("No changes in this checkpoint.");
      return;
    }

    const label =
      scope === "all" ? "Checkpoint Diff (All)" : "Checkpoint Diff (Turn)";
    const uri = vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${label}.diff`).with({
      query: Buffer.from(diff).toString("base64"),
    });

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: false,
    });
  }

  private async sendDebugInfo(): Promise<void> {
    const os = require("os");

    // VS Code environment
    const info: Record<string, string | number> = {
      // VS Code env
      "vscode.sessionId": vscode.env.sessionId,
      "vscode.machineId": vscode.env.machineId,
      "vscode.appName": vscode.env.appName,
      "vscode.appHost": vscode.env.appHost,
      "vscode.language": vscode.env.language,
      "vscode.uiKind":
        vscode.env.uiKind === vscode.UIKind.Desktop ? "Desktop" : "Web",
      "vscode.remoteName": vscode.env.remoteName ?? "none",

      // Runtime
      nodeVersion: process.version,
      platform: os.platform(),
      arch: os.arch(),
      pid: process.pid,
      uptime: `${Math.round(process.uptime())}s`,

      // Workspace
      workspaceFolders:
        (vscode.workspace.workspaceFolders ?? [])
          .map((f: vscode.WorkspaceFolder) => f.uri.fsPath)
          .join(", ") || "none",
    };

    // Add all environment variables (sorted, redacting sensitive values)
    const sensitiveKeys = /key|token|secret|password|auth|credential/i;
    const envEntries = Object.entries(process.env)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [key, value] of envEntries) {
      const displayValue = sensitiveKeys.test(key)
        ? `${value!.slice(0, 8)}...`
        : value!;
      info[`env.${key}`] = displayValue;
    }

    // Get system prompt from foreground session. If no foreground session
    // exists yet (fresh chat), build a fallback prompt for the default mode
    // so the Environment panel can still show the System Prompt section.
    const fg = this.sessionManager?.getForegroundSession();
    let systemPrompt = fg?.systemPrompt;
    if (!systemPrompt && this.cwd) {
      try {
        const mode = fg?.mode ?? "code";
        const model = fg?.model ?? this.sessionManager?.getConfig().model;
        const providerId = model
          ? providerRegistry.tryResolveProvider(model)?.id
          : undefined;
        systemPrompt = await buildSystemPrompt(mode, this.cwd, { providerId });
      } catch (err) {
        this.log(`[warn] Failed to build debug system prompt: ${err}`);
      }
    }

    // Load instruction blocks for the preview panel
    let loadedInstructions:
      | Array<{ source: string; chars: number }>
      | undefined;
    if (this.cwd) {
      try {
        const activeFilePath =
          vscode.window.activeTextEditor?.document.uri.fsPath;
        const blocks = await loadAllInstructionBlocks(this.cwd, {
          activeFilePath,
        });
        loadedInstructions = blocks.map((b) => ({
          source: b.source,
          chars: b.content.length,
        }));
      } catch (err) {
        this.log(`[warn] Failed to load instruction blocks for debug: ${err}`);
      }
    }

    const bgRouting = this.sessionManager?.getRecentBgRoutingSummaries(5) ?? [];
    if (bgRouting.length > 0) {
      bgRouting.forEach((line, idx) => {
        info[`bg.route.${idx + 1}`] = line;
      });
    }

    this.postMessage({
      type: "agentDebugInfo",
      info,
      systemPrompt: systemPrompt ?? undefined,
      loadedInstructions,
    });
  }

  private async resolveAttachments(
    text: string,
    attachments: string[],
  ): Promise<string> {
    if (attachments.length === 0) return text;

    const fs = require("fs");
    const pathMod = require("path");
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

    const blocks: string[] = [];
    for (const relPath of attachments) {
      try {
        const absPath = pathMod.isAbsolute(relPath)
          ? relPath
          : pathMod.join(workspaceRoot, relPath);
        const content = fs.readFileSync(absPath, "utf-8") as string;
        const ext = pathMod.extname(relPath).slice(1) || "";
        blocks.push(
          `<file path="${relPath}">\n\`\`\`${ext}\n${content}\n\`\`\`\n</file>`,
        );
      } catch (err) {
        this.log(`[warn] Failed to read attachment ${relPath}: ${err}`);
        blocks.push(
          `<file path="${relPath}">\n[Error: could not read file]\n</file>`,
        );
      }
    }

    // Strip the [Attached: ...] markers from the display text
    const cleanText = text.replace(/\[Attached: [^\]]+\]\n*/g, "").trim();
    return blocks.join("\n\n") + "\n\n" + cleanText;
  }

  private async searchWorkspaceFiles(
    query: string,
    requestId: string,
  ): Promise<void> {
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    if (!workspaceRoot) {
      this.postMessage({
        type: "agentFileSearchResults",
        requestId,
        files: [],
      });
      return;
    }

    try {
      // Use VS Code's findFiles API for fast glob-based search
      const pattern = query === "*" ? "**/*" : `**/*${query}*`;
      const uris = await vscode.workspace.findFiles(
        pattern,
        "**/node_modules/**",
        50,
      );

      const path = require("path");
      const files = uris.map((uri) => ({
        path: path.relative(workspaceRoot, uri.fsPath),
        kind: "file" as const,
      }));

      // Sort: prefer files whose basename starts with the query
      const lowerQuery = query.toLowerCase();
      files.sort((a, b) => {
        const aBase = path.basename(a.path).toLowerCase();
        const bBase = path.basename(b.path).toLowerCase();
        const aStarts = aBase.startsWith(lowerQuery) ? 0 : 1;
        const bStarts = bBase.startsWith(lowerQuery) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        // Then prefer shorter paths
        return a.path.length - b.path.length;
      });

      this.postMessage({
        type: "agentFileSearchResults",
        requestId,
        files: files.slice(0, 20),
      });
    } catch (err) {
      this.log(`[error] File search failed: ${err}`);
      this.postMessage({
        type: "agentFileSearchResults",
        requestId,
        files: [],
      });
    }
  }

  private sendInitialState(): void {
    if (!this.sessionManager) return;

    const fg = this.sessionManager.getForegroundSession();
    const config = this.sessionManager.getConfig();
    const state: ChatState = {
      sessionId: fg?.id ?? null,
      mode: fg?.mode ?? "code",
      model: fg?.model ?? config.model,
      streaming:
        fg?.status === "streaming" ||
        fg?.status === "tool_executing" ||
        fg?.status === "awaiting_approval",
      condenseThreshold: getConfiguredBaseThresholdForModel(
        vscode.workspace.getConfiguration("agentlink"),
        fg?.model ?? config.model,
      ),
      // Use the foreground session's ID so the write approval state reflects the
      // current session's trust level rather than a shared synthetic "agent" ID.
      agentWriteApproval: this.approvalManager?.getAgentWriteApprovalState(
        fg?.id ?? "agent",
      ),
    };

    this.postMessage({ type: "stateUpdate", state });
    this.postMessage({
      type: "agentSessionUpdate",
      sessions: this.sessionManager.getSessionInfos(),
    });
  }

  /**
   * Re-send model list to the webview. Called externally when provider auth
   * state changes (e.g. Codex sign-in/sign-out).
   */
  public refreshModels(): void {
    void this.sendModelsUpdate();
  }

  /**
   * Inject a prompt into the chat input and optionally focus the panel.
   * Used by code actions (Fix/Explain with AgentLink).
   */
  public injectPrompt(
    prompt: string,
    attachments?: string[],
    autoSubmit?: boolean,
  ): void {
    this.revealPanel();
    this.postMessage({
      type: "agentInjectPrompt",
      prompt,
      attachments: attachments ?? [],
      autoSubmit,
    } as ExtensionToWebview);
  }

  /**
   * Add a file attachment to the chat input.
   * Used by explorer context menu (Add File to Chat).
   */
  public injectAttachment(path: string): void {
    this.revealPanel();
    this.postMessage({
      type: "agentInjectAttachment",
      path,
    } as ExtensionToWebview);
  }

  /**
   * Inject context text into the chat input.
   * Used by editor context menu (Add Selection to Chat).
   */
  public injectContext(context: string): void {
    this.revealPanel();
    this.postMessage({
      type: "agentInjectContext",
      context,
    } as ExtensionToWebview);
  }

  private revealPanel(): void {
    if (this.view) {
      this.view.show(true);
    } else {
      // Panel hasn't been opened yet — force VS Code to create it
      vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    }
  }

  /** Build checkpoint mapping for a session (turnIndex → checkpointId). */
  private getSessionCheckpoints(
    sessionId: string,
  ): Array<{ turnIndex: number; checkpointId: string }> | undefined {
    const checkpoints = this.sessionManager?.getCheckpoints(sessionId);
    if (!checkpoints || checkpoints.length === 0) return undefined;
    return checkpoints.map((c) => ({
      turnIndex: c.turnIndex,
      checkpointId: c.id,
    }));
  }

  private postMessage(msg: ExtensionToWebview): void {
    if (!this.webviewReady) {
      this.pendingMessages.push(msg);
      return;
    }
    this.view?.webview.postMessage(msg);
  }

  private getHtml(): string {
    const webview = this.view!.webview;
    const nonce = randomUUID().replace(/-/g, "");

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "chat.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "chat.css"),
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "codicon.css"),
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${codiconsUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>AgentLink Chat</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private openSpecialBlockPanel(
    kind: "mermaid" | "vega" | "vega-lite",
    source: string,
  ): void {
    const existing = this.specialBlockPanel;
    if (existing) {
      existing.title = this.getSpecialBlockPanelTitle(kind);
      existing.webview.html = this.getSpecialBlockPanelHtml(
        existing.webview,
        kind,
        source,
      );
      existing.reveal(vscode.ViewColumn.Beside, false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "agentlinkSpecialBlockPreview",
      this.getSpecialBlockPanelTitle(kind),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "node_modules", "mermaid"),
          vscode.Uri.joinPath(this.extensionUri, "node_modules", "vega"),
          vscode.Uri.joinPath(this.extensionUri, "node_modules", "vega-lite"),
          vscode.Uri.joinPath(this.extensionUri, "node_modules", "vega-embed"),
        ],
      },
    );

    this.specialBlockPanel = panel;
    panel.onDidDispose(() => {
      if (this.specialBlockPanel === panel) {
        this.specialBlockPanel = undefined;
      }
    });
    panel.webview.html = this.getSpecialBlockPanelHtml(
      panel.webview,
      kind,
      source,
    );
  }

  private getSpecialBlockPanelTitle(
    kind: "mermaid" | "vega" | "vega-lite",
  ): string {
    if (kind === "mermaid") return "Mermaid Diagram";
    if (kind === "vega-lite") return "Vega-Lite Chart";
    return "Vega Chart";
  }

  private getSpecialBlockPanelHtml(
    webview: vscode.Webview,
    kind: "mermaid" | "vega" | "vega-lite",
    source: string,
  ): string {
    const nonce = randomUUID().replace(/-/g, "");
    const escapedSource = JSON.stringify(source);
    const escapedKind = JSON.stringify(kind);
    const mermaidModuleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "node_modules",
        "mermaid",
        "dist",
        "mermaid.esm.min.mjs",
      ),
    );
    const vegaEmbedModuleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "node_modules",
        "vega-embed",
        "build",
        "embed.js",
      ),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource} 'unsafe-eval' blob:; worker-src blob:; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource} data:;">
  <title>${this.getSpecialBlockPanelTitle(kind)}</title>
  <style>
    :root { color-scheme: dark light; }
    body {
      margin: 0;
      padding: 16px;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }
    #diagram {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px;
      overflow: auto;
      min-height: 120px;
      background: var(--vscode-editor-background);
    }
    #diagram svg,
    #diagram canvas {
      display: block;
      margin: 0 auto;
      max-width: 100%;
      height: auto;
    }
    .error {
      color: var(--vscode-errorForeground);
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div id="diagram">Rendering preview...</div>
  <script nonce="${nonce}" type="module">
    import mermaid from "${mermaidModuleUri}";
    import embed from "${vegaEmbedModuleUri}";
    const source = ${escapedSource};
    const kind = ${escapedKind};
    const target = document.getElementById("diagram");

    const escapeHtml = (value) => value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    try {
      if (kind === "mermaid") {
        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          securityLevel: "loose",
          fontFamily: "var(--vscode-font-family)",
          themeVariables: {
            primaryColor: "#2a5e58",
            primaryTextColor: "#e0e0e0",
            primaryBorderColor: "#4EC9B0",
            secondaryColor: "#1e3a36",
            secondaryTextColor: "#e0e0e0",
            secondaryBorderColor: "#3ba89f",
            tertiaryColor: "#163330",
            tertiaryTextColor: "#e0e0e0",
            tertiaryBorderColor: "#2d7a72",
            lineColor: "#4EC9B0",
            textColor: "#e0e0e0"
          }
        });
        const id = "special-block-panel-" + Date.now();
        const { svg } = await mermaid.render(id, source);
        target.innerHTML = svg;
      } else {
        const spec = JSON.parse(source);
        target.innerHTML = "";
        await embed(target, spec, {
          actions: false,
          renderer: "svg",
          mode: kind,
          theme: "dark"
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      target.innerHTML = '<div class="error">Failed to render preview: ' + escapeHtml(message) + "</div>";
    }
  </script>
</body>
</html>`;
  }
}
