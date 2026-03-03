import * as vscode from "vscode";
import * as http from "http";
import { randomUUID } from "crypto";

import { McpServerHost } from "./server/McpServerHost.js";
import { disposeQuickPickQueue } from "./util/quickPickQueue.js";
import {
  disposeTerminalManager,
  initializeTerminalManager,
} from "./integrations/TerminalManager.js";
import {
  resolveCurrentDiff,
  showDiffMoreOptions,
} from "./integrations/DiffViewProvider.js";
import { SidebarProvider } from "./sidebar/SidebarProvider.js";
import {
  ApprovalManager,
  type CommandRule,
} from "./approvals/ApprovalManager.js";
import { ApprovalPanelProvider } from "./approvals/ApprovalPanelProvider.js";
import { ConfigStore } from "./approvals/ConfigStore.js";
import { ToolCallTracker } from "./server/ToolCallTracker.js";
import { KNOWN_AGENTS, getAgentById } from "./agents/registry.js";
import { createConfigWriter } from "./agents/configWriters.js";
import type { ConfigWriter } from "./agents/types.js";
import {
  setupInstructions,
  setupAllInstructions,
  installHooks,
} from "./setup.js";
import { setSecretStorage } from "./services/semanticSearch.js";
import { IndexerManager } from "./indexer/IndexerManager.js";

export const DIFF_VIEW_URI_SCHEME = "agentlink-diff";

let outputChannel: vscode.OutputChannel;
let httpServer: http.Server | null = null;
let mcpHost: McpServerHost | null = null;
let statusBarItem: vscode.StatusBarItem;
let sidebarProvider: SidebarProvider;
let approvalManager: ApprovalManager;
let approvalPanel: ApprovalPanelProvider;
let toolCallTracker: ToolCallTracker;
let activePort: number | null = null;
let activeAuthToken: string | undefined;
let indexerManager: IndexerManager | null = null;

function log(message: string): void {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);
}

function getConfig<T>(key: string): T {
  return vscode.workspace.getConfiguration("agentlink").get(key) as T;
}

function getOrCreateAuthToken(context: vscode.ExtensionContext): string {
  let token = context.globalState.get<string>("authToken");
  if (!token) {
    token = randomUUID();
    context.globalState.update("authToken", token);
    log("Generated new auth token");
  }
  return token;
}

// --- Multi-agent config management ---
// Uses the agent abstraction layer to write/cleanup config for all configured agents.

let activeConfigWriters: ConfigWriter[] = [];

function getConfiguredAgentIds(): string[] {
  return getConfig<string[]>("agents") ?? ["claude-code"];
}

function updateAllAgentConfigs(port: number, authToken?: string): boolean {
  const agentIds = getConfiguredAgentIds();
  activeConfigWriters = [];
  let anyConfigured = false;

  for (const id of agentIds) {
    const agent = getAgentById(id);
    if (!agent) {
      log(`Unknown agent ID in agentlink.agents: "${id}" — skipping`);
      continue;
    }
    const writer = createConfigWriter(agent, log);
    if (!writer) continue;

    if (writer.write(port, authToken)) {
      anyConfigured = true;
    }
    activeConfigWriters.push(writer);
  }

  return anyConfigured;
}

function cleanupAllAgentConfigs(): void {
  for (const writer of activeConfigWriters) {
    writer.cleanup();
  }
  activeConfigWriters = [];
}

function updateAgentConfigsForFolder(
  folderPath: string,
  port: number,
  authToken?: string,
): void {
  for (const writer of activeConfigWriters) {
    writer.writeForFolder?.(folderPath, port, authToken);
  }
}

function cleanupAgentConfigsForFolder(folderPath: string): void {
  for (const writer of activeConfigWriters) {
    writer.cleanupFolder?.(folderPath);
  }
}

function collectRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function startServer(context: vscode.ExtensionContext): Promise<void> {
  if (httpServer) {
    log("Server already running");
    return;
  }

  const port = getConfig<number>("port");
  const requireAuth = getConfig<boolean>("requireAuth");
  const authToken = requireAuth ? getOrCreateAuthToken(context) : undefined;

  mcpHost = new McpServerHost(
    authToken,
    approvalManager,
    approvalPanel,
    toolCallTracker,
    context.extensionUri,
  );

  // Notify sidebar when sessions change (connect/disconnect/initialize)
  mcpHost.onSessionChanged = () => {
    sidebarProvider?.updateState({
      sessions: mcpHost?.sessionCount ?? 0,
    });
  };
  sidebarProvider?.setMcpSessionProvider(
    () => mcpHost?.getSessionInfos() ?? [],
  );

  httpServer = http.createServer(async (req, res) => {
    const url = req.url ?? "";

    if (url === "/mcp" || url.startsWith("/mcp?")) {
      // Buffer and parse the body — SDK expects parsedBody as 3rd arg to handleRequest
      let parsedBody: unknown;
      try {
        const body = await collectRequestBody(req);
        const text = body.toString();
        if (text.length > 0) {
          parsedBody = JSON.parse(text);
        }
      } catch {
        // GET/DELETE requests may have no body — that's fine
      }

      // Detect client disconnect so tool handlers can react
      let clientDisconnected = false;
      res.on("close", () => {
        if (!res.writableFinished) {
          clientDisconnected = true;
          log(
            `Client disconnected before response completed (${req.method} ${url})`,
          );
        }
      });

      try {
        await mcpHost!.handleRequest(req, res, parsedBody);
      } catch (err) {
        if (clientDisconnected) {
          log(`MCP request aborted (client disconnected): ${err}`);
        } else {
          log(`MCP request error: ${err}`);
        }
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
      return;
    }

    // Health check
    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ status: "ok", sessions: mcpHost!.sessionCount }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const onListening = (actualPort: number) => {
    activePort = actualPort;
    activeAuthToken = authToken;
    log(`MCP server listening on http://127.0.0.1:${actualPort}/mcp`);
    const configured = updateAllAgentConfigs(actualPort, authToken);
    updateStatusBar(actualPort, configured);

    // Auto-update instruction files + hooks if opted in
    const agentIds = getConfiguredAgentIds();
    if (getConfig<boolean>("autoUpdateInstructions")) {
      setupAllInstructions(context.extensionUri, agentIds, log, {
        silent: true,
      });
    }
    if (getConfig<boolean>("autoUpdateHooks")) {
      installHooks(context.extensionUri, log, { silent: true });
    }
  };

  return new Promise<void>((resolve, reject) => {
    httpServer!.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log(`Port ${port} in use, trying OS-assigned port...`);
        httpServer!.listen(0, "127.0.0.1", () => {
          const addr = httpServer!.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : 0;
          onListening(actualPort);
          resolve();
        });
      } else {
        log(`Server error: ${err.message}`);
        reject(err);
      }
    });

    httpServer!.listen(port, "127.0.0.1", () => {
      const addr = httpServer!.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      onListening(actualPort);
      resolve();
    });
  });
}

async function stopServer(): Promise<void> {
  cleanupAllAgentConfigs();
  activePort = null;
  activeAuthToken = undefined;

  if (mcpHost) {
    await mcpHost.close();
    mcpHost = null;
  }
  if (httpServer) {
    return new Promise<void>((resolve) => {
      httpServer!.close(() => {
        httpServer = null;
        log("MCP server stopped");
        updateStatusBar(null);
        resolve();
      });
    });
  }
}

function updateStatusBar(port: number | null, agentConfigured?: boolean): void {
  if (port !== null) {
    statusBarItem.text = `$(chip) AgentLink :${port}`;
    statusBarItem.tooltip = `AgentLink MCP server running on port ${port}`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(chip) AgentLink`;
    statusBarItem.tooltip = "AgentLink MCP server stopped";
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
  }
  statusBarItem.show();

  // Update sidebar
  sidebarProvider?.updateState({
    serverRunning: port !== null,
    port,
    sessions: mcpHost?.sessionCount ?? 0,
    authEnabled: getConfig<boolean>("requireAuth"),
    agentConfigured: agentConfigured ?? false,
  });
}

async function addTrustedCommandViaUI(): Promise<void> {
  const pattern = await vscode.window.showInputBox({
    title: "Trusted Command Pattern",
    prompt: "Enter a command pattern to trust",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : "Pattern cannot be empty"),
  });
  if (!pattern) return;

  const modes: Array<vscode.QuickPickItem & { mode: CommandRule["mode"] }> = [
    {
      label: "Prefix Match",
      description: `Trust commands starting with "${pattern.trim()}"`,
      mode: "prefix",
    },
    {
      label: "Exact Match",
      description: `Trust only "${pattern.trim()}"`,
      mode: "exact",
    },
    {
      label: "Regex Match",
      description: `Trust commands matching /${pattern.trim()}/`,
      mode: "regex",
    },
  ];

  const picked = await vscode.window.showQuickPick(modes, {
    title: "Match Mode",
    placeHolder: "How should this pattern match commands?",
    ignoreFocusOut: true,
  });
  if (!picked) return;

  // Scope selection
  const scopeItems: Array<
    vscode.QuickPickItem & { scope: "project" | "global" }
  > = [];
  const roots = vscode.workspace.workspaceFolders;
  if (roots && roots.length > 0) {
    scopeItems.push({
      label: "$(folder) This Project",
      description: ".agentlink/agentlink.json",
      scope: "project",
    });
  }
  scopeItems.push({
    label: "$(globe) Global",
    description: "~/.agentlink/agentlink.json",
    scope: "global",
  });

  const scopePick = await vscode.window.showQuickPick(scopeItems, {
    title: "Rule Scope",
    placeHolder: "Where should this rule be saved?",
    ignoreFocusOut: true,
  });
  if (!scopePick) return;

  approvalManager.addCommandRule(
    "_global",
    { pattern: pattern.trim(), mode: picked.mode },
    scopePick.scope,
  );
  vscode.window.showInformationMessage(
    `Added trusted command (${scopePick.scope}): ${picked.mode} "${pattern.trim()}"`,
  );
}

function showAgentPickerInSidebar(): void {
  const currentAgents = getConfiguredAgentIds();
  sidebarProvider?.updateState({
    ...sidebarProvider.getState(),
    onboardingStep: 1,
    knownAgents: KNOWN_AGENTS.map((a) => ({
      id: a.id,
      name: a.name,
      selected: currentAgents.includes(a.id),
    })),
  });
  // Reveal the sidebar so the user sees the picker
  vscode.commands.executeCommand("agentLink.statusView.focus");
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("AgentLink");
  context.subscriptions.push(outputChannel);

  initializeTerminalManager(context.extensionUri, log);

  // Initialize secret storage for secure API key access
  setSecretStorage(context.secrets);

  log("Activating AgentLink extension");

  // Config store for disk-based approval rules
  const configStore = new ConfigStore();
  context.subscriptions.push({ dispose: () => configStore.dispose() });

  // Approval manager (must be created before server start)
  approvalManager = new ApprovalManager(context.globalState, configStore);
  approvalManager.migrateFromGlobalState().catch((err) => {
    log(`Migration warning: ${err}`);
  });

  // Register TextDocumentContentProvider for diff view (readonly left side)
  const diffContentProvider = new (class
    implements vscode.TextDocumentContentProvider
  {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return Buffer.from(uri.query, "base64").toString("utf-8");
    }
  })();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      DIFF_VIEW_URI_SCHEME,
      diffContentProvider,
    ),
  );

  // Tool call tracker (wraps tool handlers for cancel/complete from sidebar)
  const extVersion =
    (context.extension.packageJSON as { version?: string })?.version ??
    "unknown";
  toolCallTracker = new ToolCallTracker(log, extVersion);

  // Approval panel (WebView-based approval UI for commands and path access)
  approvalPanel = new ApprovalPanelProvider(context.extensionUri);
  context.subscriptions.push(approvalPanel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ApprovalPanelProvider.viewType,
      approvalPanel,
    ),
  );

  // Sidebar
  sidebarProvider = new SidebarProvider(context.extensionUri, log);
  sidebarProvider.setApprovalManager(approvalManager);
  sidebarProvider.setToolCallTracker(toolCallTracker);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider,
    ),
  );

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "agentlink.showStatus";
  context.subscriptions.push(statusBarItem);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("agentlink.acceptDiff", () =>
      resolveCurrentDiff("accept"),
    ),
    vscode.commands.registerCommand("agentlink.acceptDiffMore", () =>
      showDiffMoreOptions(),
    ),
    vscode.commands.registerCommand("agentlink.rejectDiff", () =>
      resolveCurrentDiff("reject"),
    ),
    vscode.commands.registerCommand("agentlink.addTrustedCommand", () =>
      addTrustedCommandViaUI(),
    ),
    vscode.commands.registerCommand("agentLink.focusApproval", () =>
      approvalPanel.focusApproval(),
    ),
    vscode.commands.registerCommand("agentlink.cancelToolCall", (id: string) =>
      toolCallTracker.cancelCall(id, approvalPanel),
    ),
    vscode.commands.registerCommand(
      "agentlink.completeToolCall",
      (id: string) => toolCallTracker.completeCall(id, approvalPanel),
    ),
    vscode.commands.registerCommand("agentlink.clearSessionApprovals", () => {
      for (const s of approvalManager.getActiveSessions()) {
        approvalManager.clearSession(s.id);
      }
      approvalManager.resetWriteApproval();
      vscode.window.showInformationMessage("All session approvals cleared.");
    }),
    vscode.commands.registerCommand("agentlink.setOpenaiApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "OpenAI API Key",
        prompt: "Enter your OpenAI API key for semantic search embeddings",
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : "API key cannot be empty"),
      });
      if (!key) return;
      await context.secrets.store("openaiApiKey", key.trim());
      vscode.window.showInformationMessage("OpenAI API key stored securely.");
    }),
    vscode.commands.registerCommand("agentlink.configureAgents", () =>
      showAgentPickerInSidebar(),
    ),
    vscode.commands.registerCommand("agentlink.resetOnboarding", () => {
      // Only show picker in current window — don't touch globalState
      showAgentPickerInSidebar();
    }),
    vscode.commands.registerCommand(
      "agentlink.applyAgentConfig",
      (opts?: { skipAutoUpdate?: boolean }) => {
        if (activePort !== null) {
          cleanupAllAgentConfigs();
          const configured = updateAllAgentConfigs(activePort, activeAuthToken);
          updateStatusBar(activePort, configured);

          if (!opts?.skipAutoUpdate) {
            const ids = getConfiguredAgentIds();
            if (getConfig<boolean>("autoUpdateInstructions")) {
              setupAllInstructions(context.extensionUri, ids, log, {
                silent: true,
              });
            }
            if (getConfig<boolean>("autoUpdateHooks")) {
              installHooks(context.extensionUri, log, { silent: true });
            }
          }
        }
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.setupInstructions",
      (agentId?: string) => {
        if (agentId) {
          setupInstructions(context.extensionUri, agentId, log);
        } else {
          // Run for all configured agents
          for (const id of getConfiguredAgentIds()) {
            setupInstructions(context.extensionUri, id, log);
          }
        }
      },
    ),
    vscode.commands.registerCommand("agentlink.installHooks", () => {
      installHooks(context.extensionUri, log);
    }),
    vscode.commands.registerCommand("agentlink.startServer", () =>
      startServer(context),
    ),
    vscode.commands.registerCommand("agentlink.stopServer", () => stopServer()),
    vscode.commands.registerCommand("agentlink.showStatus", () => {
      const port = httpServer?.address();
      const portNum = typeof port === "object" && port ? port.port : null;
      if (portNum) {
        vscode.window.showInformationMessage(
          `AgentLink MCP server running on port ${portNum} with ${mcpHost?.sessionCount ?? 0} active session(s).`,
        );
      } else {
        vscode.window.showWarningMessage(
          "AgentLink MCP server is not running.",
        );
      }
    }),
  );

  // Handle workspace folders being added/removed
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      if (activePort === null) return;
      for (const added of e.added) {
        updateAgentConfigsForFolder(
          added.uri.fsPath,
          activePort,
          activeAuthToken,
        );
      }
      for (const removed of e.removed) {
        cleanupAgentConfigsForFolder(removed.uri.fsPath);
      }
    }),
  );

  // --- Codebase indexer ---
  const semanticEnabled = vscode.workspace
    .getConfiguration("agentlink")
    .get<boolean>("semanticSearchEnabled", false);

  if (semanticEnabled) {
    indexerManager = new IndexerManager(
      context.extensionUri,
      context.globalStorageUri,
      log,
    );
    context.subscriptions.push(indexerManager);

    // Forward index status to sidebar
    indexerManager.onStatusChanged((status) => {
      sidebarProvider.updateIndexStatus(status);
    });

    // Start file watching for incremental updates
    indexerManager.startWatching();

    // Register index commands
    context.subscriptions.push(
      vscode.commands.registerCommand("agentlink.rebuildIndex", () =>
        indexerManager?.startIndexing(true),
      ),
      vscode.commands.registerCommand("agentlink.cancelIndex", () =>
        indexerManager?.cancelIndexing(),
      ),
      vscode.commands.registerCommand("agentlink.resumeIndex", () =>
        indexerManager?.startIndexing(false),
      ),
      // Internal command for IndexerManager to retrieve the OpenAI API key
      vscode.commands.registerCommand(
        "agentlink.getOpenAiApiKeyInternal",
        async () => {
          const key = await context.secrets.get("openaiApiKey");
          return key || "";
        },
      ),
    );
  }

  // Cleanup on deactivation
  context.subscriptions.push({
    dispose: () => {
      stopServer();
      disposeTerminalManager();
      disposeQuickPickQueue();
    },
  });

  // Onboarding: show agent picker in sidebar on first activation
  const onboardingComplete =
    context.globalState.get<boolean>("onboardingComplete");
  if (!onboardingComplete) {
    context.globalState.update("onboardingComplete", true);
    showAgentPickerInSidebar();
  }

  // Auto-start with retry
  const autoStart = getConfig<boolean>("autoStart");
  if (autoStart) {
    const MAX_RETRIES = 3;
    const startWithRetry = async (attempt: number): Promise<void> => {
      try {
        await startServer(context);
        // Trigger auto-index after server starts (first attempt only)
        if (attempt === 0 && indexerManager) {
          const autoIndex = vscode.workspace
            .getConfiguration("agentlink")
            .get<boolean>("autoIndex", true);
          if (autoIndex) {
            indexerManager.startIndexing();
          }
        }
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          const delay = 1000 * 2 ** attempt; // 2s, 4s, 8s
          log(
            `Server start attempt ${attempt + 1} failed, retrying in ${delay}ms: ${err}`,
          );
          setTimeout(() => startWithRetry(attempt + 1), delay);
        } else {
          log(
            `Failed to start server after ${MAX_RETRIES + 1} attempts: ${err}`,
          );
          vscode.window.showErrorMessage(
            `AgentLink: Failed to start MCP server after ${MAX_RETRIES + 1} attempts: ${err}`,
          );
        }
      }
    };
    startWithRetry(0);
  } else {
    updateStatusBar(null);
  }
}

export function deactivate(): void {
  stopServer();
}
