import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import type {
  ApprovalManager,
  RuleScope,
} from "../approvals/ApprovalManager.js";
import type {
  ToolCallTracker,
  TrackedCallInfo,
} from "../server/ToolCallTracker.js";
import { readFeedback, deleteFeedback } from "../util/feedbackStore.js";
import { editRuleViaQuickPick } from "./editRuleQuickPick.js";
import { matchClientName, getAgentById } from "../agents/registry.js";
import type {
  AgentInfo,
  IndexStatusInfo,
  SidebarState,
} from "./webview/types.js";

export type { AgentInfo, SidebarState };

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "agentLink.statusView";

  private view: vscode.WebviewView | undefined;
  private state: SidebarState = {
    serverRunning: false,
    port: null,
    sessions: 0,
    authEnabled: true,
    agentConfigured: false,
    masterBypass: false,
    hasWorkspace: (vscode.workspace.workspaceFolders ?? []).length > 0,
  };
  private approvalManager: ApprovalManager | undefined;
  private toolCallTracker: ToolCallTracker | undefined;
  private activeToolCalls: TrackedCallInfo[] = [];
  private log: (msg: string) => void;
  private mcpSessionProvider?: () => Array<{
    id: string;
    clientName?: string;
    clientVersion?: string;
    lastActivity: number;
    trusted: boolean;
  }>;
  private sidebarRefreshInterval?: ReturnType<typeof setInterval>;

  constructor(
    private readonly extensionUri: vscode.Uri,
    log?: (msg: string) => void,
  ) {
    this.log = log ?? (() => {});
    // Periodic refresh so "last seen" times and stale-session filtering stay current
    this.sidebarRefreshInterval = setInterval(
      () => this.refreshApprovalState(),
      30_000,
    );
  }

  setApprovalManager(manager: ApprovalManager): void {
    this.approvalManager = manager;
    manager.onDidChange(() => this.refreshApprovalState());
  }

  setMcpSessionProvider(
    provider: () => Array<{
      id: string;
      clientName?: string;
      clientVersion?: string;
      lastActivity: number;
      trusted: boolean;
    }>,
  ): void {
    this.mcpSessionProvider = provider;
  }

  setToolCallTracker(tracker: ToolCallTracker): void {
    this.toolCallTracker = tracker;
    tracker.on("change", () => this.refreshToolCalls());
  }

  private refreshToolCalls(): void {
    if (!this.toolCallTracker) return;
    this.activeToolCalls = this.toolCallTracker.getActiveCalls();
    this.log(
      `refreshToolCalls: ${this.activeToolCalls.length} active calls, view=${!!this.view}`,
    );
    // Send lightweight update to client instead of full re-render
    this.view?.webview.postMessage({
      type: "updateToolCalls",
      calls: this.activeToolCalls,
    });
    // Auto-refresh feedback after tool calls complete (may have auto-recorded failures)
    if (__DEV_BUILD__) {
      this.refreshFeedback();
    }
  }

  private refreshFeedback(): void {
    if (!this.view) return;
    try {
      const entries = readFeedback();
      this.view.webview.postMessage({
        type: "updateFeedback",
        entries,
      });
    } catch {
      // feedbackStore may not exist yet
    }
  }

  updateIndexStatus(status: IndexStatusInfo): void {
    this.state.indexStatus = status;
    this.view?.webview.postMessage({
      type: "updateIndexStatus",
      status,
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };

    webviewView.webview.html = this.getHtml();
    this.log("Webview resolved, HTML set");

    // Refresh state when the sidebar becomes visible again — postMessage calls
    // are silently dropped while the webview is hidden (no retainContextWhenHidden).
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.refreshApprovalState();
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "webviewReady":
          this.log("Received webviewReady from Preact app");
          this.refreshApprovalState();
          this.refreshToolCalls();
          if (__DEV_BUILD__) {
            this.refreshFeedback();
          }
          break;
        case "startServer":
          vscode.commands.executeCommand("agentlink.startServer");
          break;
        case "stopServer":
          vscode.commands.executeCommand("agentlink.stopServer");
          break;
        case "copyConfig":
          this.copyMcpConfig();
          break;
        case "copyCliCommand":
          this.copyCliCommand();
          break;
        case "openSettings":
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "agentlink",
          );
          break;
        case "openOutput":
          vscode.commands.executeCommand(
            "workbench.action.output.show",
            "AgentLink",
          );
          break;
        case "openGlobalConfig":
          this.openConfigFile("global");
          break;
        case "openProjectConfig":
          this.openConfigFile("project");
          break;
        case "installCli":
          this.installViaCli();
          break;
        case "saveAgents":
          this.saveAgentSelection((message.agents as string).split(","));
          break;
        case "resetOnboarding":
          vscode.commands.executeCommand("agentlink.resetOnboarding");
          break;
        case "dismissOnboarding":
          this.dismissOnboarding();
          break;
        case "setupInstructions":
          vscode.commands.executeCommand(
            "agentlink.setupInstructions",
            message.agentId,
          );
          // Enable auto-update for future startups
          vscode.workspace
            .getConfiguration("agentlink")
            .update(
              "autoUpdateInstructions",
              true,
              vscode.ConfigurationTarget.Global,
            );
          break;
        case "installHooks":
          vscode.commands.executeCommand("agentlink.installHooks");
          // Enable auto-update for future startups
          vscode.workspace
            .getConfiguration("agentlink")
            .update("autoUpdateHooks", true, vscode.ConfigurationTarget.Global);
          break;
        case "resetWriteApproval":
          this.approvalManager?.resetWriteApproval();
          break;
        case "setWriteApproval":
          if (this.approvalManager && message.mode) {
            const mode = message.mode as string;
            // Reset everything first, then set the new level
            this.approvalManager.resetWriteApproval();
            if (mode !== "prompt") {
              // For session scope, approve all active sessions
              if (mode === "session") {
                for (const s of this.approvalManager.getActiveSessions()) {
                  this.approvalManager.setWriteApproval(s.id, "session");
                }
              } else {
                this.approvalManager.setWriteApproval(
                  "_sidebar",
                  mode as "project" | "global",
                );
              }
            }
          }
          break;
        case "removeGlobalRule":
          if (message.pattern) {
            this.approvalManager?.removeCommandRule(message.pattern, "global");
          }
          break;
        case "editGlobalRule":
          if (message.pattern && message.mode) {
            this.editRule(message.pattern, message.mode, "global");
          }
          break;
        case "removeProjectRule":
          if (message.pattern) {
            this.approvalManager?.removeCommandRule(message.pattern, "project");
          }
          break;
        case "editProjectRule":
          if (message.pattern && message.mode) {
            this.editRule(message.pattern, message.mode, "project");
          }
          break;
        case "addGlobalRule":
          vscode.commands.executeCommand("agentlink.addTrustedCommand");
          break;
        case "removeSessionRule":
          if (message.sessionId && message.pattern) {
            this.approvalManager?.removeCommandRule(
              message.pattern,
              "session",
              message.sessionId,
            );
          }
          break;
        case "editSessionRule":
          if (message.sessionId && message.pattern && message.mode) {
            this.editRule(
              message.pattern,
              message.mode,
              "session",
              message.sessionId,
            );
          }
          break;
        case "clearSessionRules":
          if (message.sessionId) {
            this.approvalManager?.clearSessionCommandRules(message.sessionId);
          }
          break;
        case "cancelToolCall":
          if (message.id) {
            vscode.commands.executeCommand(
              "agentlink.cancelToolCall",
              message.id,
            );
          }
          break;
        case "completeToolCall":
          if (message.id) {
            vscode.commands.executeCommand(
              "agentlink.completeToolCall",
              message.id,
            );
          }
          break;
        case "clearAllSessions":
          vscode.commands.executeCommand("agentlink.clearSessionApprovals");
          break;
        // Path rule handlers
        case "removeGlobalPathRule":
          if (message.pattern) {
            this.approvalManager?.removePathRule(message.pattern, "global");
          }
          break;
        case "editGlobalPathRule":
          if (message.pattern && message.mode) {
            this.editPathRule(message.pattern, message.mode, "global");
          }
          break;
        case "removeProjectPathRule":
          if (message.pattern) {
            this.approvalManager?.removePathRule(message.pattern, "project");
          }
          break;
        case "editProjectPathRule":
          if (message.pattern && message.mode) {
            this.editPathRule(message.pattern, message.mode, "project");
          }
          break;
        case "removeSessionPathRule":
          if (message.sessionId && message.pattern) {
            this.approvalManager?.removePathRule(
              message.pattern,
              "session",
              message.sessionId,
            );
          }
          break;
        // Write rule handlers
        case "removeGlobalWriteRule":
          if (message.pattern) {
            this.approvalManager?.removeWriteRule(message.pattern, "global");
          }
          break;
        case "editGlobalWriteRule":
          if (message.pattern && message.mode) {
            this.editWriteRule(message.pattern, message.mode, "global");
          }
          break;
        case "removeProjectWriteRule":
          if (message.pattern) {
            this.approvalManager?.removeWriteRule(message.pattern, "project");
          }
          break;
        case "editProjectWriteRule":
          if (message.pattern && message.mode) {
            this.editWriteRule(message.pattern, message.mode, "project");
          }
          break;
        case "removeSessionWriteRule":
          if (message.sessionId && message.pattern) {
            this.approvalManager?.removeWriteRule(
              message.pattern,
              "session",
              message.sessionId,
            );
          }
          break;
        // Feedback handlers (dev builds only)
        case "refreshFeedback":
          if (__DEV_BUILD__) {
            this.refreshFeedback();
          }
          break;
        case "deleteFeedbackEntry":
          if (__DEV_BUILD__ && message.index != null) {
            deleteFeedback([Number(message.index)]);
            this.refreshFeedback();
          }
          break;
        case "clearAllFeedback":
          if (__DEV_BUILD__) {
            const entries = readFeedback();
            if (entries.length > 0) {
              deleteFeedback(entries.map((_, i) => i));
            }
            this.refreshFeedback();
          }
          break;
        case "openFeedbackFile":
          if (__DEV_BUILD__) {
            const feedbackPath = path.join(
              os.homedir(),
              ".agentlink",
              "agentlink-feedback.jsonl",
            );
            vscode.window.showTextDocument(vscode.Uri.file(feedbackPath));
          }
          break;
        // Codebase index commands
        case "rebuildIndex":
          vscode.commands.executeCommand("agentlink.rebuildIndex");
          break;
        case "cancelIndex":
          vscode.commands.executeCommand("agentlink.cancelIndex");
          break;
        case "resumeIndex":
          vscode.commands.executeCommand("agentlink.resumeIndex");
          break;
        case "setOpenaiApiKey":
          vscode.commands.executeCommand("agentlink.setOpenaiApiKey");
          break;
        case "setOpenaiModelsAndEmbeddingsApiKey":
          vscode.commands.executeCommand("agentlink.codexSignIn", "apiKeyOnly");
          break;
        case "setupSemanticSearch":
          vscode.commands.executeCommand(
            "agentlink.setupSemanticSearch",
            message.reason,
          );
          break;
      }
    });
  }

  getState(): SidebarState {
    return { ...this.state };
  }

  updateState(partial: Partial<SidebarState>): void {
    Object.assign(this.state, partial);
    this.refreshApprovalState();
  }

  private async editRule(
    oldPattern: string,
    oldMode: string,
    scope: RuleScope,
    sessionId?: string,
  ): Promise<void> {
    if (!this.approvalManager) return;
    const result = await editRuleViaQuickPick({
      oldPattern,
      oldMode,
      title: "Edit rule pattern, then pick match mode",
      modes: [
        {
          label: "$(symbol-text) Prefix Match",
          mode: "prefix" as const,
          alwaysShow: true as const,
        },
        {
          label: "$(symbol-key) Exact Match",
          mode: "exact" as const,
          alwaysShow: true as const,
        },
        {
          label: "$(regex) Regex Match",
          mode: "regex" as const,
          alwaysShow: true as const,
        },
      ],
    });
    if (result) {
      this.approvalManager.editCommandRule(
        oldPattern,
        result,
        scope,
        sessionId,
      );
    }
  }

  private async editPathRule(
    oldPattern: string,
    oldMode: string,
    scope: RuleScope,
    sessionId?: string,
  ): Promise<void> {
    if (!this.approvalManager) return;
    const result = await editRuleViaQuickPick({
      oldPattern,
      oldMode,
      title: "Edit path pattern, then pick match mode",
      modes: [
        {
          label: "$(symbol-misc) Glob Match",
          mode: "glob" as const,
          alwaysShow: true as const,
        },
        {
          label: "$(symbol-text) Prefix Match",
          mode: "prefix" as const,
          alwaysShow: true as const,
        },
        {
          label: "$(symbol-key) Exact Match",
          mode: "exact" as const,
          alwaysShow: true as const,
        },
      ],
    });
    if (result) {
      this.approvalManager.editPathRule(oldPattern, result, scope, sessionId);
    }
  }

  private async editWriteRule(
    oldPattern: string,
    oldMode: string,
    scope: RuleScope,
    sessionId?: string,
  ): Promise<void> {
    if (!this.approvalManager) return;
    const result = await editRuleViaQuickPick({
      oldPattern,
      oldMode,
      title: "Edit write rule pattern, then pick match mode",
      modes: [
        {
          label: "$(symbol-misc) Glob Match",
          mode: "glob" as const,
          alwaysShow: true as const,
        },
        {
          label: "$(symbol-text) Prefix Match",
          mode: "prefix" as const,
          alwaysShow: true as const,
        },
        {
          label: "$(symbol-key) Exact Match",
          mode: "exact" as const,
          alwaysShow: true as const,
        },
      ],
    });
    if (result) {
      this.approvalManager.editWriteRule(oldPattern, result, scope, sessionId);
    }
  }

  private refreshApprovalState(): void {
    // Always sync tool call state before full re-render to avoid races
    // where a postMessage update is lost during webview reload.
    this.activeToolCalls = this.toolCallTracker?.getActiveCalls() ?? [];

    const mcpSessions = this.mcpSessionProvider?.() ?? [];

    if (this.approvalManager) {
      const sessions = this.approvalManager.getActiveSessions();
      // Show the "best" write approval state across all sessions
      const writeState = this.approvalManager.getWriteApprovalState("_none");
      if (writeState === "global" || writeState === "project") {
        this.state.writeApproval = writeState;
      } else if (sessions.some((s) => s.writeApproved)) {
        this.state.writeApproval = "session";
      } else {
        this.state.writeApproval = "prompt";
      }
      // Use a dummy session ID to get global/project rules
      const dummyId = "_sidebar";
      const commandRules = this.approvalManager.getCommandRules(dummyId);
      const pathRules = this.approvalManager.getPathRules(dummyId);
      const writeRules = this.approvalManager.getWriteRules(dummyId);
      this.state.globalCommandRules = commandRules.global;
      this.state.projectCommandRules = commandRules.project;
      this.state.globalPathRules = pathRules.global;
      this.state.projectPathRules = pathRules.project;
      this.state.globalWriteRules = writeRules.global;
      this.state.projectWriteRules = writeRules.project;
      this.state.settingsWriteRules = writeRules.settings;
      // Merge MCP session client info into approval sessions
      const mcpMap = new Map(mcpSessions.map((s) => [s.id, s]));

      this.state.activeSessions = sessions.map((s) => {
        const mcp = mcpMap.get(s.id);
        return {
          id: s.id,
          writeApproved: s.writeApproved,
          commandRules: this.approvalManager!.getCommandRules(s.id).session,
          pathRules: this.approvalManager!.getPathRules(s.id).session,
          writeRules: this.approvalManager!.getWriteRules(s.id).session,
          clientName: mcp?.clientName,
          clientVersion: mcp?.clientVersion,
          agentId: mcp?.clientName
            ? matchClientName(mcp.clientName)
            : undefined,
        };
      });
    }

    // Build connected agents list from all MCP sessions (not just approval sessions).
    // This is outside the approvalManager block so trust-state changes always
    // propagate to the sidebar even before any approval interaction.
    const STALE_REMOVE_MS = 2 * 60_000;
    const now = Date.now();
    this.state.connectedAgents = mcpSessions
      .filter((s) => now - s.lastActivity < STALE_REMOVE_MS)
      .map((s) => {
        const agentId = s.clientName
          ? matchClientName(s.clientName)
          : undefined;
        return {
          sessionId: s.id,
          clientName: s.clientName,
          clientVersion: s.clientVersion,
          agentId,
          agentDisplayName: agentId ? getAgentById(agentId)?.name : undefined,
          lastActivity: s.lastActivity,
          trustState: s.trusted ? ("trusted" as const) : ("untrusted" as const),
        };
      });
    this.state.masterBypass = this.getMasterBypass();
    // Send state via postMessage instead of full HTML replacement
    this.view?.webview.postMessage({ type: "stateUpdate", state: this.state });
  }

  private copyMcpConfig(): void {
    if (!this.state.port) {
      vscode.window.showWarningMessage("Server is not running.");
      return;
    }

    const config = {
      agentlink: {
        type: "http",
        url: `http://localhost:${this.state.port}/mcp`,
      },
    };

    vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
    vscode.window.showInformationMessage("MCP config copied to clipboard.");
  }

  private copyCliCommand(): void {
    if (!this.state.port) {
      vscode.window.showWarningMessage("Server is not running.");
      return;
    }

    const cmd = `claude mcp add --transport http agentlink http://localhost:${this.state.port}/mcp`;
    vscode.env.clipboard.writeText(cmd);
    vscode.window.showInformationMessage("CLI command copied to clipboard.");
  }

  private async installViaCli(): Promise<void> {
    if (!this.state.port) {
      vscode.window.showWarningMessage("Server is not running.");
      return;
    }

    const terminal = vscode.window.createTerminal({
      name: "AgentLink Setup",
    });
    terminal.show();
    terminal.sendText(
      `claude mcp add --transport http agentlink http://localhost:${this.state.port}/mcp`,
      true,
    );
  }

  private async saveAgentSelection(agentIds: string[]): Promise<void> {
    if (!agentIds || agentIds.length === 0) return;
    await vscode.workspace
      .getConfiguration("agentlink")
      .update("agents", agentIds, vscode.ConfigurationTarget.Global);
    this.log(`Configured agents: ${agentIds.join(", ")}`);

    // Transition to step 2 (confirmation + verification)
    this.state.onboardingStep = 2;
    this.state.configuredAgentIds = agentIds;
    this.refreshApprovalState();

    // Trigger re-config via command (extension.ts handles the actual config writing)
    // Skip auto-update — user will manually click buttons on step 2
    vscode.commands.executeCommand("agentlink.applyAgentConfig", {
      skipAutoUpdate: true,
    });
  }

  private dismissOnboarding(): void {
    this.state.onboardingStep = undefined;
    this.state.configuredAgentIds = undefined;
    this.state.knownAgents = undefined;
    this.refreshApprovalState();
  }

  private openConfigFile(scope: "global" | "project"): void {
    let filePath: string;
    if (scope === "global") {
      filePath = path.join(os.homedir(), ".agentlink", "agentlink.json");
    } else {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage("No workspace folder open.");
        return;
      }
      filePath = path.join(
        folders[0].uri.fsPath,
        ".agentlink",
        "agentlink.json",
      );
    }
    vscode.window.showTextDocument(vscode.Uri.file(filePath));
  }

  private getMasterBypass(): boolean {
    return vscode.workspace
      .getConfiguration("agentlink")
      .get<boolean>("masterBypass", false);
  }

  private getHtml(): string {
    const webview = this.view!.webview;
    const nonce = randomUUID().replace(/-/g, "");

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "sidebar.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "sidebar.css"),
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>AgentLink</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
