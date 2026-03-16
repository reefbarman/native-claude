import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import { McpServerHost } from "./server/McpServerHost.js";
import { StatusBarManager } from "./util/StatusBarManager.js";
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

import { setStoredAnthropicApiKey } from "./agent/clientFactory.js";
import { IndexerManager } from "./indexer/IndexerManager.js";
import { ChatViewProvider } from "./agent/ChatViewProvider.js";
import { AgentSessionManager } from "./agent/AgentSessionManager.js";
import {
  getConfiguredBaseThresholdForModel,
  getMigratedModelCondenseThresholdMap,
} from "./agent/modelCondenseThresholds.js";
import { SessionStore } from "./agent/SessionStore.js";
import type { AgentConfig } from "./agent/types.js";
import { AgentCodeActionProvider } from "./agent/AgentCodeActionProvider.js";
import { AnthropicProvider } from "./agent/providers/anthropic/index.js";
import {
  providerRegistry,
  CodexProvider,
  openAiCodexAuthManager,
} from "./agent/providers/index.js";

export const DIFF_VIEW_URI_SCHEME = "agentlink-diff";

let outputChannel: vscode.OutputChannel;
let httpServer: http.Server | null = null;
let mcpHost: McpServerHost | null = null;
let statusBarManager: StatusBarManager;
let sidebarProvider: SidebarProvider;
let approvalManager: ApprovalManager;
let approvalPanel: ApprovalPanelProvider;
let toolCallTracker: ToolCallTracker;
let builtinApprovalPanel: ApprovalPanelProvider;
let activePort: number | null = null;
let activeAuthToken: string | undefined;
let indexerManager: IndexerManager | null = null;
let chatViewProvider: ChatViewProvider;
let agentSessionManager: AgentSessionManager;

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

/** Read the port from the first workspace's .mcp.json, if it exists. */
function readPortFromMcpJson(): number | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  try {
    const mcpPath = path.join(folder.uri.fsPath, ".mcp.json");
    const raw = fs.readFileSync(mcpPath, "utf-8");
    const config = JSON.parse(raw);
    const url = config?.mcpServers?.agentlink?.url as string | undefined;
    if (!url) return undefined;
    const match = url.match(/:(\d+)\//);
    if (!match) return undefined;
    const port = parseInt(match[1], 10);
    if (port > 0 && port < 65536) {
      log(`Found previous port ${port} in .mcp.json`);
      return port;
    }
  } catch {
    // file doesn't exist or is malformed — ignore
  }
  return undefined;
}

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

  const port = getConfig<number>("port") || readPortFromMcpJson();
  const requireAuth = getConfig<boolean>("requireAuth");
  const authToken = requireAuth ? getOrCreateAuthToken(context) : undefined;

  mcpHost = new McpServerHost(
    authToken,
    approvalManager,
    approvalPanel,
    toolCallTracker,
    context.extensionUri,
  );

  // Notify sidebar + status bar when sessions change (connect/disconnect/trust)
  mcpHost.onSessionChanged = () => {
    const sessions = mcpHost?.getSessionInfos() ?? [];
    sidebarProvider?.updateState({
      sessions: sessions.length,
    });
    if (activePort !== null) {
      statusBarManager.setRunning(activePort, sessions);
    }
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
        if (!mcpHost) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Server is shutting down" }));
          return;
        }
        await mcpHost.handleRequest(req, res, parsedBody);
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
        JSON.stringify({ status: "ok", sessions: mcpHost?.sessionCount ?? 0 }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "not_found",
        error_description:
          "This server does not support OAuth. Authentication is managed via Bearer tokens configured automatically by the extension.",
      }),
    );
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
      const actualPort =
        typeof addr === "object" && addr ? addr.port : (port ?? 0);
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
    const sessions = mcpHost?.getSessionInfos() ?? [];
    statusBarManager.setRunning(port, sessions);
  } else {
    statusBarManager.setStopped();
  }

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

  // Load stored Anthropic API key into memory so createAnthropicClient can use it synchronously.
  void context.secrets.get("anthropicApiKey").then((key) => {
    setStoredAnthropicApiKey(key || undefined);
  });

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

  // Status bar manager (unified status bar for port info + approval alerts)
  statusBarManager = new StatusBarManager();
  context.subscriptions.push(statusBarManager);

  // Approval panel (WebView-based approval UI for commands and path access)
  approvalPanel = new ApprovalPanelProvider(
    context.extensionUri,
    statusBarManager,
  );
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

  // Agent chat view
  const agentConfiguration = vscode.workspace.getConfiguration("agentlink");
  const configuredModel =
    agentConfiguration.get<string>("agentModel") ?? "claude-sonnet-4-6";
  const migratedThresholds = getMigratedModelCondenseThresholdMap(
    agentConfiguration,
    configuredModel,
  );
  const agentConfig: AgentConfig = {
    model: configuredModel,
    maxTokens: agentConfiguration.get<number>("agentMaxTokens") ?? 8192,
    thinkingBudget: agentConfiguration.get<number>("thinkingBudget") ?? 10000,
    showThinking: agentConfiguration.get<boolean>("showThinking") ?? true,
    autoCondense: agentConfiguration.get<boolean>("autoCondense") ?? true,
    autoCondenseThreshold:
      migratedThresholds[configuredModel] ??
      getConfiguredBaseThresholdForModel(agentConfiguration, configuredModel),
  };

  const workspaceCwd =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const isDevMode = context.extensionMode === vscode.ExtensionMode.Development;
  chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    context.globalState,
  );

  // Register providers after chatViewProvider is created so all auth logs
  // (including initial client construction) go to the agent output channel.
  const agentLog = (msg: string) => chatViewProvider.log(msg);
  providerRegistry.register(new AnthropicProvider(undefined, agentLog));

  // Register the OpenAI/Codex provider with unified OAuth + API key auth.
  openAiCodexAuthManager.initialize(context);
  providerRegistry.register(
    new CodexProvider(openAiCodexAuthManager, agentLog),
  );

  // Re-send model list to webview when OpenAI/Codex auth state changes.
  openAiCodexAuthManager.onAuthStateChanged = () => {
    chatViewProvider.refreshModels();
  };
  const sessionStore = new SessionStore(workspaceCwd);
  agentSessionManager = new AgentSessionManager(
    agentConfig,
    workspaceCwd,
    undefined,
    isDevMode,
    sessionStore,
    log,
  );

  // Initialize modes, slash commands, MCP hub, and file watchers
  chatViewProvider.initialize(workspaceCwd).catch((err) => {
    log(`[agent] ChatViewProvider.initialize failed: ${err}`);
  });

  // Dedicated approval panel for the built-in agent — routes rich approval cards
  // (CommandCard, WriteCard, etc.) inline into the chat webview instead of the
  // separate approval panel (which is reserved for external MCP agents like Claude Code).
  builtinApprovalPanel = new ApprovalPanelProvider(
    context.extensionUri,
    statusBarManager,
  );
  context.subscriptions.push(builtinApprovalPanel);
  builtinApprovalPanel.onForwardApproval = (req, respond) =>
    chatViewProvider.forwardApproval(req, respond);
  builtinApprovalPanel.onForwardApprovalIdle = () =>
    chatViewProvider.sendApprovalIdle();

  // Wire up tool dispatch context (mcpHub provided by ChatViewProvider after initialize)
  agentSessionManager.setToolContext({
    approvalManager,
    approvalPanel: builtinApprovalPanel,
    sessionId: "agent", // synthetic session ID for the built-in agent
    extensionUri: context.extensionUri,
    mcpHub: chatViewProvider.getMcpHub(),
    onModeSwitch: (mode, reason) =>
      chatViewProvider.handleModeSwitch(mode, reason),
    onApprovalRequest: (request) => chatViewProvider.requestApproval(request),
    onQuestion: (questions, sessionId) =>
      chatViewProvider.requestQuestion(questions, sessionId),
    onFileRead: (filePath) => {
      agentSessionManager.getForegroundSession()?.trackFileRead(filePath);
    },
    onSpawnBackground: (request) =>
      agentSessionManager.spawnBackground(request),
    onGetBackgroundStatus: (sessionId) =>
      agentSessionManager.getBackgroundStatus(sessionId),
    onGetBackgroundResult: (sessionId) =>
      agentSessionManager.waitForBackground(sessionId),
    onKillBackground: (sessionId, reason) =>
      agentSessionManager.killBackground(sessionId, reason),
    toolCallTracker,
  });

  chatViewProvider.setApprovalManager(approvalManager);
  chatViewProvider.setToolCallTracker(toolCallTracker);
  chatViewProvider.setSessionManager(agentSessionManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // Update agent config when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("agentlink.agentModel") ||
        e.affectsConfiguration("agentlink.agentMaxTokens") ||
        e.affectsConfiguration("agentlink.thinkingBudget") ||
        e.affectsConfiguration("agentlink.showThinking") ||
        e.affectsConfiguration("agentlink.autoCondense") ||
        e.affectsConfiguration("agentlink.autoCondenseThreshold") ||
        e.affectsConfiguration("agentlink.modelCondenseThresholds")
      ) {
        const config = vscode.workspace.getConfiguration("agentlink");
        const model = config.get<string>("agentModel") ?? "claude-sonnet-4-6";
        agentSessionManager.updateConfig({
          model,
          maxTokens: config.get<number>("agentMaxTokens") ?? 8192,
          thinkingBudget: config.get<number>("thinkingBudget") ?? 10000,
          showThinking: config.get<boolean>("showThinking") ?? true,
          autoCondense: config.get<boolean>("autoCondense") ?? true,
          autoCondenseThreshold: getConfiguredBaseThresholdForModel(
            config,
            model,
          ),
        });
      }
    }),
  );

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
        prompt:
          "Enter your OpenAI API key to use OpenAI models, semantic search, and indexing. If you also sign in with ChatGPT/Codex, that OAuth session will be preferred.",
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : "API key cannot be empty"),
      });
      if (!key) return;
      await openAiCodexAuthManager.storeApiKey(key.trim());
      vscode.window.showInformationMessage(
        "OpenAI API key stored securely. It will be used for models, semantic search, and indexing when no ChatGPT/Codex OAuth session is available.",
      );
    }),
    vscode.commands.registerCommand(
      "agentlink.setAnthropicApiKey",
      async () => {
        const key = await vscode.window.showInputBox({
          title: "Anthropic API Key",
          prompt:
            "Get your API key at https://platform.claude.com/settings/keys — or set ANTHROPIC_API_KEY as an environment variable instead",
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() ? null : "API key cannot be empty"),
        });
        if (!key) return;
        await context.secrets.store("anthropicApiKey", key.trim());
        setStoredAnthropicApiKey(key.trim());
        chatViewProvider.refreshModels();
        vscode.window.showInformationMessage(
          "Anthropic API key stored securely.",
        );
      },
    ),
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
    vscode.commands.registerCommand("agentlink.codexSignIn", async () => {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: "Sign in with ChatGPT/Codex",
            description:
              "Use your ChatGPT/Codex OAuth session for models, semantic search, and indexing",
            value: "oauth",
          },
          {
            label: "Use OpenAI API key",
            description:
              "Use usage-based OpenAI Platform billing for models, semantic search, and indexing",
            value: "apiKey",
          },
        ],
        {
          title: "OpenAI/Codex Authentication",
          placeHolder:
            "Choose an auth method for models, semantic search, and indexing. If both are configured, ChatGPT/Codex OAuth is preferred.",
          ignoreFocusOut: true,
        },
      );
      if (!choice) return;

      if (choice.value === "apiKey") {
        await vscode.commands.executeCommand("agentlink.setOpenaiApiKey");
        return;
      }

      try {
        const authUrl = openAiCodexAuthManager.startAuthorizationFlow();
        await vscode.env.openExternal(vscode.Uri.parse(authUrl));
        log("[codex] Opened browser for OAuth sign-in");
        const creds = await openAiCodexAuthManager.waitForCallback();
        log(`[codex] Signed in as ${creds.email ?? "unknown"}`);
        vscode.window.showInformationMessage(
          `Signed in with ChatGPT/Codex${creds.email ? ` as ${creds.email}` : ""}. This OAuth session will be used for models, semantic search, and indexing, and will be preferred over any stored OpenAI API key.`,
        );
      } catch (err) {
        log(`[codex] Sign-in failed: ${err}`);
        vscode.window.showErrorMessage(
          `Codex sign-in failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }),
    vscode.commands.registerCommand("agentlink.codexSignOut", async () => {
      const hasOAuth = await openAiCodexAuthManager.hasOAuth();
      const hasApiKey = await openAiCodexAuthManager.hasApiKey();

      if (hasOAuth && hasApiKey) {
        const choice = await vscode.window.showQuickPick(
          [
            {
              label: "Remove ChatGPT/Codex sign-in",
              description: "Removes the preferred OAuth session",
              value: "oauth",
            },
            {
              label: "Remove OpenAI API key",
              description: "Keeps ChatGPT/Codex OAuth if present",
              value: "apiKey",
            },
            {
              label: "Remove both",
              description: "Clears both OAuth and API-key auth",
              value: "both",
            },
          ],
          {
            title: "Manage OpenAI/Codex Authentication",
            placeHolder:
              "Choose which auth method to remove. OAuth is preferred when both are present.",
            ignoreFocusOut: true,
          },
        );
        if (!choice) return;
        if (choice.value === "oauth") {
          await openAiCodexAuthManager.clearOAuth();
        } else if (choice.value === "apiKey") {
          await openAiCodexAuthManager.clearApiKey();
        } else {
          await openAiCodexAuthManager.clearAll();
        }
        vscode.window.showInformationMessage(
          "Updated OpenAI/Codex authentication. If both methods remain configured, ChatGPT/Codex OAuth will be preferred for models, semantic search, and indexing.",
        );
        log(`[codex] Removed auth method: ${choice.value}`);
        return;
      }

      if (hasOAuth) {
        await openAiCodexAuthManager.clearOAuth();
        vscode.window.showInformationMessage(
          "Removed ChatGPT/Codex sign-in. AgentLink will use your OpenAI API key for models, semantic search, and indexing instead if one is configured.",
        );
        log("[codex] Signed out OAuth session");
        return;
      }

      if (hasApiKey) {
        await openAiCodexAuthManager.clearApiKey();
        vscode.window.showInformationMessage(
          "Removed OpenAI API key. Sign in with ChatGPT/Codex to continue using models, semantic search, and indexing.",
        );
        log("[codex] Removed OpenAI API key");
        return;
      }

      vscode.window.showInformationMessage(
        "No OpenAI/Codex credentials are currently configured for models, semantic search, or indexing.",
      );
      log("[codex] Sign-out requested, but no credentials were configured");
    }),
    vscode.commands.registerCommand("agentlink.startServer", () =>
      startServer(context),
    ),
    vscode.commands.registerCommand("agentlink.stopServer", () => stopServer()),
    vscode.commands.registerCommand("agentlink.showStatus", () => {
      vscode.commands.executeCommand("agentLink.statusView.focus");
    }),
  );

  // ── Code Actions & Context Menu Commands ──

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new AgentCodeActionProvider(),
      {
        providedCodeActionKinds:
          AgentCodeActionProvider.providedCodeActionKinds,
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentlink.fixWithAgent",
      (
        uri: vscode.Uri,
        range: vscode.Range,
        diagnostics: vscode.Diagnostic[],
      ) => {
        const relPath = vscode.workspace.asRelativePath(uri);
        const diagText = diagnostics
          .map(
            (d) =>
              `[${d.source ?? ""}] ${d.message} (line ${d.range.start.line + 1})`,
          )
          .join("\n");
        const prompt = `Fix the following issue(s) in \`${relPath}\`:\n\n${diagText}`;
        chatViewProvider.injectPrompt(prompt, [relPath]);
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.explainWithAgent",
      (uri?: vscode.Uri, range?: vscode.Range) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        // When invoked from context menu, no args are passed — use editor selection
        const targetUri = uri ?? editor.document.uri;
        const targetRange = range ?? editor.selection;
        if (targetRange.isEmpty) return;
        const selection = editor.document.getText(targetRange);
        const relPath = vscode.workspace.asRelativePath(targetUri);
        const startLine = targetRange.start.line + 1;
        const endLine = targetRange.end.line + 1;
        const prompt = `Explain this code from \`${relPath}\` (lines ${startLine}-${endLine}):\n\n\`\`\`\n${selection}\n\`\`\``;
        chatViewProvider.injectPrompt(prompt, [], true);
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.addFileToChat",
      (uri?: vscode.Uri) => {
        const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) return;
        const relPath = vscode.workspace.asRelativePath(targetUri);
        chatViewProvider.injectAttachment(relPath);
      },
    ),
    vscode.commands.registerCommand("agentlink.addSelectionToChat", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return;
      const selection = editor.document.getText(editor.selection);
      const relPath = vscode.workspace.asRelativePath(editor.document.uri);
      const startLine = editor.selection.start.line + 1;
      const endLine = editor.selection.end.line + 1;
      const context = `From \`${relPath}\` (lines ${startLine}-${endLine}):\n\`\`\`\n${selection}\n\`\`\``;
      chatViewProvider.injectContext(context);
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

    // Forward index status to sidebar + status bar error
    indexerManager.onStatusChanged((status) => {
      sidebarProvider.updateIndexStatus(status);
      if (status.state === "error" && status.error) {
        statusBarManager.setError(`Indexing: ${status.error}`);
      } else if (status.state !== "error") {
        statusBarManager.clearError();
      }
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
    );
  }

  // Cleanup on deactivation
  context.subscriptions.push({
    dispose: () => {
      stopServer();
      disposeTerminalManager();
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
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Track retry timer for cleanup on deactivation
    context.subscriptions.push({
      dispose: () => {
        if (retryTimer) clearTimeout(retryTimer);
      },
    });
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
          retryTimer = setTimeout(() => startWithRetry(attempt + 1), delay);
        } else {
          log(
            `Failed to start server after ${MAX_RETRIES + 1} attempts: ${err}`,
          );
          statusBarManager.setError(`Server failed to start: ${err}`);
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
