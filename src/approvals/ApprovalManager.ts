import * as vscode from "vscode";
import picomatch from "picomatch";

import { tryGetFirstWorkspaceRoot, getRelativePath } from "../util/paths.js";
import type { ConfigStore } from "./ConfigStore.js";

export interface CommandRule {
  pattern: string;
  mode: "prefix" | "regex" | "exact";
}

export interface PathRule {
  pattern: string;
  mode: "glob" | "prefix" | "exact";
}

export type RuleScope = "session" | "project" | "global";

interface SessionState {
  writeApproved: boolean;
  agentWriteApproved: boolean;
  commandRules: CommandRule[];
  pathRules: PathRule[];
  writeRules: PathRule[];
  lastActivity: number;
}

interface PersistedApprovalSessions {
  version: 1;
  sessions: Record<string, SessionState>;
}

const SESSION_TTL = 24 * 60 * 60_000; // 24 hours
const PRUNE_INTERVAL = 60 * 60_000; // 1 hour
const APPROVAL_SESSIONS_KEY = "approvalSessions";

export class ApprovalManager {
  private pruneTimer: ReturnType<typeof setInterval>;
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  // Session-scoped approvals, keyed by chat session ID.
  // Persisted so restored chat sessions keep their session-level approvals.
  private sessions = new Map<string, SessionState>();

  // Per-session MCP tool approvals: key is "sessionId:toolName" or "sessionId:server:*"
  private mcpApprovals = new Set<string>();
  private configStoreListener: vscode.Disposable;

  constructor(
    private globalState: vscode.Memento, // kept for migration
    private configStore: ConfigStore,
  ) {
    this.loadPersistedSessions();
    this.pruneExpiredSessions();
    this.pruneTimer = setInterval(
      () => this.pruneExpiredSessions(),
      PRUNE_INTERVAL,
    );
    // Forward config file changes to our own onDidChange
    this.configStoreListener = configStore.onDidChange(() =>
      this._onDidChange.fire(),
    );
  }

  // --- MCP tool approvals (in-memory, session-scoped) ---

  /** True if this tool (or its server) has been approved for this session. */
  isMcpApproved(sessionId: string, toolName: string): boolean {
    const server = toolName.split("__")[0];
    return (
      this.mcpApprovals.has(`${sessionId}:tool:${toolName}`) ||
      this.mcpApprovals.has(`${sessionId}:server:${server}`)
    );
  }

  /** Approve a single tool for the rest of this session. */
  approveMcpTool(sessionId: string, toolName: string): void {
    this.mcpApprovals.add(`${sessionId}:tool:${toolName}`);
  }

  /** Approve all tools from a server for the rest of this session. */
  approveMcpServer(sessionId: string, serverName: string): void {
    this.mcpApprovals.add(`${sessionId}:server:${serverName}`);
  }

  dispose(): void {
    clearInterval(this.pruneTimer);
    this.configStoreListener.dispose();
    this._onDidChange.dispose();
  }

  // --- Migration from globalState to config files ---

  async migrateFromGlobalState(): Promise<void> {
    if (this.globalState.get<boolean>("configMigrated")) return;

    const oldCommands = this.globalState.get<CommandRule[]>(
      "globalCommandRules",
      [],
    );
    const oldWriteApproved = this.globalState.get<boolean>(
      "globalWriteApproved",
      false,
    );
    const oldPathRules = this.globalState.get<PathRule[]>(
      "globalPathRules",
      [],
    );
    const oldWriteRules = this.globalState.get<PathRule[]>(
      "globalWriteRules",
      [],
    );

    const hasData =
      oldCommands.length > 0 ||
      oldWriteApproved ||
      oldPathRules.length > 0 ||
      oldWriteRules.length > 0;

    if (hasData) {
      const migrated = this.configStore.updateGlobalConfig((config) => {
        config.writeApproved = config.writeApproved || oldWriteApproved;
        config.commandRules = deduplicateRules([
          ...(config.commandRules ?? []),
          ...oldCommands,
        ]);
        config.pathRules = deduplicateRules([
          ...(config.pathRules ?? []),
          ...oldPathRules,
        ]);
        config.writeRules = deduplicateRules([
          ...(config.writeRules ?? []),
          ...oldWriteRules,
        ]);
      });

      if (!migrated) return; // Don't mark as done if config write failed

      // Clear old globalState keys
      await this.globalState.update("globalCommandRules", undefined);
      await this.globalState.update("globalWriteApproved", undefined);
      await this.globalState.update("globalPathRules", undefined);
      await this.globalState.update("globalWriteRules", undefined);
    }

    await this.globalState.update("configMigrated", true);
  }

  // --- Session management ---

  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId) ?? this.newSession();
    session.lastActivity = Date.now();
    this.sessions.set(sessionId, session);
    this.persistSessions();
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.clearMcpApprovalsForSession(sessionId);
    this.persistSessions();
  }

  pruneExpiredSessions(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_TTL) {
        this.sessions.delete(id);
        this.clearMcpApprovalsForSession(id);
        changed = true;
      }
    }
    if (changed) {
      this.persistSessions();
    }
  }

  // --- Write approval (MCP / sidebar path) ---

  isWriteApproved(sessionId: string, filePath?: string): boolean {
    // Global blanket approval
    if (this.configStore.getGlobalConfig().writeApproved) {
      return true;
    }
    // Project blanket approval
    const projectConfig = this.configStore.getProjectConfigForFirstRoot();
    if (projectConfig?.writeApproved) {
      return true;
    }
    // Session blanket approval
    const session = this.getSession(sessionId);
    if (session.writeApproved) {
      return true;
    }
    // File-level checks (only when filePath provided)
    if (filePath) {
      return this.isFileWriteApproved(sessionId, filePath);
    }
    return false;
  }

  setWriteApproval(sessionId: string, scope: RuleScope): void {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((c) => {
        c.writeApproved = true;
      });
    } else if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return;
      this.configStore.updateProjectConfig(folder, (c) => {
        c.writeApproved = true;
      });
    } else {
      const session = this.sessions.get(sessionId) ?? this.newSession();
      session.writeApproved = true;
      session.lastActivity = Date.now();
      this.sessions.set(sessionId, session);
      this.persistSessions();
    }
    this._onDidChange.fire();
  }

  resetWriteApproval(): void {
    this.configStore.updateGlobalConfig((c) => {
      c.writeApproved = false;
    });
    // Also reset project-level
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      for (const folder of folders) {
        const config = this.configStore.getProjectConfig(folder.uri.fsPath);
        if (config.writeApproved) {
          this.configStore.updateProjectConfig(folder.uri.fsPath, (c) => {
            c.writeApproved = false;
          });
        }
      }
    }
    // Also clear all session write approvals
    for (const session of this.sessions.values()) {
      session.writeApproved = false;
    }
    this.persistSessions();
    this._onDidChange.fire();
  }

  getWriteApprovalState(
    sessionId: string,
  ): "prompt" | "session" | "project" | "global" {
    if (this.configStore.getGlobalConfig().writeApproved) {
      return "global";
    }
    const projectConfig = this.configStore.getProjectConfigForFirstRoot();
    if (projectConfig?.writeApproved) {
      return "project";
    }
    const session = this.getSession(sessionId);
    if (session.writeApproved) {
      return "session";
    }
    return "prompt";
  }

  // --- Agent write approval (independent from MCP/sidebar path) ---

  isAgentWriteApproved(sessionId: string, filePath?: string): boolean {
    // Global blanket approval
    if (this.configStore.getGlobalConfig().agentWriteApproved) {
      return true;
    }
    // Project blanket approval
    const projectConfig = this.configStore.getProjectConfigForFirstRoot();
    if (projectConfig?.agentWriteApproved) {
      return true;
    }
    // Session blanket approval
    const session = this.getSession(sessionId);
    if (session.agentWriteApproved) {
      return true;
    }
    // File-level checks (only when filePath provided)
    if (filePath) {
      return this.isFileWriteApproved(sessionId, filePath);
    }
    return false;
  }

  setAgentWriteApproval(sessionId: string, scope: RuleScope): void {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((c) => {
        c.agentWriteApproved = true;
      });
    } else if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return;
      this.configStore.updateProjectConfig(folder, (c) => {
        c.agentWriteApproved = true;
      });
    } else {
      const session = this.sessions.get(sessionId) ?? this.newSession();
      session.agentWriteApproved = true;
      session.lastActivity = Date.now();
      this.sessions.set(sessionId, session);
      this.persistSessions();
    }
    this._onDidChange.fire();
  }

  /**
   * Migrate all session-level approval state from one ID to another.
   * Used when a session is created after approval state was stored under
   * a placeholder ID (e.g. "agent").
   */
  migrateSessionState(fromId: string, toId: string): void {
    const source = this.sessions.get(fromId);
    if (!source) return;
    this.sessions.set(toId, { ...source, lastActivity: Date.now() });
    this.sessions.delete(fromId);
    this.persistSessions();
    this._onDidChange.fire();
  }

  /** Reset session-level agent write approval for a single session (e.g. on mode switch). */
  resetSessionAgentWriteApproval(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.agentWriteApproved) {
      session.agentWriteApproved = false;
      this.persistSessions();
      this._onDidChange.fire();
    }
  }

  resetAgentWriteApproval(): void {
    this.configStore.updateGlobalConfig((c) => {
      c.agentWriteApproved = false;
    });
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      for (const folder of folders) {
        const config = this.configStore.getProjectConfig(folder.uri.fsPath);
        if (config.agentWriteApproved) {
          this.configStore.updateProjectConfig(folder.uri.fsPath, (c) => {
            c.agentWriteApproved = false;
          });
        }
      }
    }
    for (const session of this.sessions.values()) {
      session.agentWriteApproved = false;
    }
    this.persistSessions();
    this._onDidChange.fire();
  }

  getAgentWriteApprovalState(
    sessionId: string,
  ): "prompt" | "session" | "project" | "global" {
    if (this.configStore.getGlobalConfig().agentWriteApproved) {
      return "global";
    }
    const projectConfig = this.configStore.getProjectConfigForFirstRoot();
    if (projectConfig?.agentWriteApproved) {
      return "project";
    }
    const session = this.getSession(sessionId);
    if (session.agentWriteApproved) {
      return "session";
    }
    return "prompt";
  }

  // --- Path trust (outside-workspace access) ---

  isPathTrusted(sessionId: string, filePath: string): boolean {
    // Check session path rules first
    const session = this.getSession(sessionId);
    if (
      (session.pathRules ?? []).some((r) => this.matchesPathRule(filePath, r))
    ) {
      return true;
    }
    // Check project path rules
    const projectConfig = this.configStore.getProjectConfigForFirstRoot();
    if (
      projectConfig &&
      (projectConfig.pathRules ?? []).some((r) =>
        this.matchesPathRule(filePath, r),
      )
    ) {
      return true;
    }
    // Check global path rules
    const globalConfig = this.configStore.getGlobalConfig();
    if (
      (globalConfig.pathRules ?? []).some((r) =>
        this.matchesPathRule(filePath, r),
      )
    ) {
      return true;
    }
    return false;
  }

  addPathRule(sessionId: string, rule: PathRule, scope: RuleScope): void {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((c) => {
        const rules = c.pathRules ?? [];
        if (
          !rules.some((r) => r.pattern === rule.pattern && r.mode === rule.mode)
        ) {
          rules.push(rule);
          c.pathRules = rules;
        }
      });
    } else if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return;
      this.configStore.updateProjectConfig(folder, (c) => {
        const rules = c.pathRules ?? [];
        if (
          !rules.some((r) => r.pattern === rule.pattern && r.mode === rule.mode)
        ) {
          rules.push(rule);
          c.pathRules = rules;
        }
      });
    } else {
      const session = this.sessions.get(sessionId) ?? this.newSession();
      const pathRules = session.pathRules ?? [];
      if (
        !pathRules.some(
          (r) => r.pattern === rule.pattern && r.mode === rule.mode,
        )
      ) {
        pathRules.push(rule);
        session.pathRules = pathRules;
        session.lastActivity = Date.now();
        this.sessions.set(sessionId, session);
        this.persistSessions();
      }
    }
    this._onDidChange.fire();
  }

  removePathRule(pattern: string, scope: RuleScope, sessionId?: string): void {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((c) => {
        c.pathRules = (c.pathRules ?? []).filter((r) => r.pattern !== pattern);
      });
    } else if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return;
      this.configStore.updateProjectConfig(folder, (c) => {
        c.pathRules = (c.pathRules ?? []).filter((r) => r.pattern !== pattern);
      });
    } else if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.pathRules = (session.pathRules ?? []).filter(
          (r) => r.pattern !== pattern,
        );
        this.persistSessions();
      }
    }
    this._onDidChange.fire();
  }

  editPathRule(
    oldPattern: string,
    newRule: PathRule,
    scope: RuleScope,
    sessionId?: string,
  ): void {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((c) => {
        const rules = c.pathRules ?? [];
        const idx = rules.findIndex((r) => r.pattern === oldPattern);
        if (idx !== -1) rules[idx] = newRule;
      });
    } else if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return;
      this.configStore.updateProjectConfig(folder, (c) => {
        const rules = c.pathRules ?? [];
        const idx = rules.findIndex((r) => r.pattern === oldPattern);
        if (idx !== -1) rules[idx] = newRule;
      });
    } else if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        const pathRules = session.pathRules ?? [];
        const idx = pathRules.findIndex((r) => r.pattern === oldPattern);
        if (idx !== -1) {
          pathRules[idx] = newRule;
          this.persistSessions();
        }
      }
    }
    this._onDidChange.fire();
  }

  getPathRules(sessionId: string): {
    session: PathRule[];
    project: PathRule[];
    global: PathRule[];
  } {
    const session = this.getSession(sessionId);
    const projectConfig = this.configStore.getProjectConfigForFirstRoot();
    return {
      session: [...(session.pathRules ?? [])],
      project: [...(projectConfig?.pathRules ?? [])],
      global: [...(this.configStore.getGlobalConfig().pathRules ?? [])],
    };
  }

  // --- File-level write approval ---

  isFileWriteApproved(sessionId: string, filePath: string): boolean {
    const relPath = getRelativePath(filePath);
    const candidates = relPath !== filePath ? [relPath, filePath] : [filePath];

    // Settings-based patterns (match against both relative and absolute)
    const settingsPatterns = vscode.workspace
      .getConfiguration("agentlink")
      .get<string[]>("writeRules", []);
    if (
      settingsPatterns.some((p) =>
        candidates.some((c) =>
          this.matchesPathRule(c, { pattern: p, mode: "glob" }),
        ),
      )
    ) {
      return true;
    }

    // Session write rules
    const session = this.getSession(sessionId);
    if (
      (session.writeRules ?? []).some((r) =>
        candidates.some((c) => this.matchesPathRule(c, r)),
      )
    ) {
      return true;
    }

    // Project write rules
    const projectConfig = this.configStore.getProjectConfigForFirstRoot();
    if (
      projectConfig &&
      (projectConfig.writeRules ?? []).some((r) =>
        candidates.some((c) => this.matchesPathRule(c, r)),
      )
    ) {
      return true;
    }

    // Global write rules
    const globalConfig = this.configStore.getGlobalConfig();
    if (
      (globalConfig.writeRules ?? []).some((r) =>
        candidates.some((c) => this.matchesPathRule(c, r)),
      )
    ) {
      return true;
    }

    return false;
  }

  addWriteRule(sessionId: string, rule: PathRule, scope: RuleScope): void {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((c) => {
        const rules = c.writeRules ?? [];
        if (
          !rules.some((r) => r.pattern === rule.pattern && r.mode === rule.mode)
        ) {
          rules.push(rule);
          c.writeRules = rules;
        }
      });
    } else if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return;
      this.configStore.updateProjectConfig(folder, (c) => {
        const rules = c.writeRules ?? [];
        if (
          !rules.some((r) => r.pattern === rule.pattern && r.mode === rule.mode)
        ) {
          rules.push(rule);
          c.writeRules = rules;
        }
      });
    } else {
      const session = this.sessions.get(sessionId) ?? this.newSession();
      const writeRules = session.writeRules ?? [];
      if (
        !writeRules.some(
          (r) => r.pattern === rule.pattern && r.mode === rule.mode,
        )
      ) {
        writeRules.push(rule);
        session.writeRules = writeRules;
        session.lastActivity = Date.now();
        this.sessions.set(sessionId, session);
        this.persistSessions();
      }
    }
    this._onDidChange.fire();
  }

  removeWriteRule(pattern: string, scope: RuleScope, sessionId?: string): void {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((c) => {
        c.writeRules = (c.writeRules ?? []).filter(
          (r) => r.pattern !== pattern,
        );
      });
    } else if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return;
      this.configStore.updateProjectConfig(folder, (c) => {
        c.writeRules = (c.writeRules ?? []).filter(
          (r) => r.pattern !== pattern,
        );
      });
    } else if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.writeRules = (session.writeRules ?? []).filter(
          (r) => r.pattern !== pattern,
        );
        this.persistSessions();
      }
    }
    this._onDidChange.fire();
  }

  editWriteRule(
    oldPattern: string,
    newRule: PathRule,
    scope: RuleScope,
    sessionId?: string,
  ): void {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((c) => {
        const rules = c.writeRules ?? [];
        const idx = rules.findIndex((r) => r.pattern === oldPattern);
        if (idx !== -1) rules[idx] = newRule;
      });
    } else if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return;
      this.configStore.updateProjectConfig(folder, (c) => {
        const rules = c.writeRules ?? [];
        const idx = rules.findIndex((r) => r.pattern === oldPattern);
        if (idx !== -1) rules[idx] = newRule;
      });
    } else if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        const writeRules = session.writeRules ?? [];
        const idx = writeRules.findIndex((r) => r.pattern === oldPattern);
        if (idx !== -1) {
          writeRules[idx] = newRule;
          this.persistSessions();
        }
      }
    }
    this._onDidChange.fire();
  }

  getWriteRules(sessionId: string): {
    session: PathRule[];
    project: PathRule[];
    global: PathRule[];
    settings: string[];
  } {
    const session = this.getSession(sessionId);
    const projectConfig = this.configStore.getProjectConfigForFirstRoot();
    return {
      session: [...(session.writeRules ?? [])],
      project: [...(projectConfig?.writeRules ?? [])],
      global: [...(this.configStore.getGlobalConfig().writeRules ?? [])],
      settings: vscode.workspace
        .getConfiguration("agentlink")
        .get<string[]>("writeRules", []),
    };
  }

  // --- Command approval ---

  isCommandApproved(sessionId: string, command: string): boolean {
    return this.findMatchingCommandRule(sessionId, command) !== null;
  }

  /**
   * Find the first command rule that matches the given command.
   * Returns the rule and its scope, or null if no match.
   * Checks session → project → global (same priority as isCommandApproved).
   */
  findMatchingCommandRule(
    sessionId: string,
    command: string,
  ): { rule: CommandRule; scope: RuleScope } | null {
    const trimmed = command.trim();

    // Check session rules first
    const session = this.getSession(sessionId);
    for (const rule of session.commandRules) {
      if (this.matchesRule(trimmed, rule)) return { rule, scope: "session" };
    }

    // Check project rules
    const projectConfig = this.configStore.getProjectConfigForFirstRoot();
    if (projectConfig) {
      for (const rule of projectConfig.commandRules ?? []) {
        if (this.matchesRule(trimmed, rule)) return { rule, scope: "project" };
      }
    }

    // Check global rules
    const globalConfig = this.configStore.getGlobalConfig();
    for (const rule of globalConfig.commandRules ?? []) {
      if (this.matchesRule(trimmed, rule)) return { rule, scope: "global" };
    }

    return null;
  }

  addCommandRule(sessionId: string, rule: CommandRule, scope: RuleScope): void {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((c) => {
        const rules = c.commandRules ?? [];
        if (
          !rules.some((r) => r.pattern === rule.pattern && r.mode === rule.mode)
        ) {
          rules.push(rule);
          c.commandRules = rules;
        }
      });
    } else if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return;
      this.configStore.updateProjectConfig(folder, (c) => {
        const rules = c.commandRules ?? [];
        if (
          !rules.some((r) => r.pattern === rule.pattern && r.mode === rule.mode)
        ) {
          rules.push(rule);
          c.commandRules = rules;
        }
      });
    } else {
      const session = this.sessions.get(sessionId) ?? this.newSession();
      if (
        !session.commandRules.some(
          (r) => r.pattern === rule.pattern && r.mode === rule.mode,
        )
      ) {
        session.commandRules.push(rule);
        session.lastActivity = Date.now();
        this.sessions.set(sessionId, session);
        this.persistSessions();
      }
    }
    this._onDidChange.fire();
  }

  editCommandRule(
    oldPattern: string,
    newRule: CommandRule,
    scope: RuleScope,
    sessionId?: string,
  ): void {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((c) => {
        const rules = c.commandRules ?? [];
        const idx = rules.findIndex((r) => r.pattern === oldPattern);
        if (idx !== -1) rules[idx] = newRule;
      });
    } else if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return;
      this.configStore.updateProjectConfig(folder, (c) => {
        const rules = c.commandRules ?? [];
        const idx = rules.findIndex((r) => r.pattern === oldPattern);
        if (idx !== -1) rules[idx] = newRule;
      });
    } else if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        const idx = session.commandRules.findIndex(
          (r) => r.pattern === oldPattern,
        );
        if (idx !== -1) {
          session.commandRules[idx] = newRule;
          this.persistSessions();
        }
      }
    }
    this._onDidChange.fire();
  }

  removeCommandRule(
    pattern: string,
    scope: RuleScope,
    sessionId?: string,
  ): void {
    if (scope === "global") {
      this.configStore.updateGlobalConfig((c) => {
        c.commandRules = (c.commandRules ?? []).filter(
          (r) => r.pattern !== pattern,
        );
      });
    } else if (scope === "project") {
      const folder = tryGetFirstWorkspaceRoot();
      if (!folder) return;
      this.configStore.updateProjectConfig(folder, (c) => {
        c.commandRules = (c.commandRules ?? []).filter(
          (r) => r.pattern !== pattern,
        );
      });
    } else if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.commandRules = session.commandRules.filter(
          (r) => r.pattern !== pattern,
        );
        this.persistSessions();
      }
    }
    this._onDidChange.fire();
  }

  getCommandRules(sessionId: string): {
    session: CommandRule[];
    project: CommandRule[];
    global: CommandRule[];
  } {
    const session = this.getSession(sessionId);
    const projectConfig = this.configStore.getProjectConfigForFirstRoot();
    return {
      session: [...session.commandRules],
      project: [...(projectConfig?.commandRules ?? [])],
      global: [...(this.configStore.getGlobalConfig().commandRules ?? [])],
    };
  }

  clearSessionCommandRules(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.commandRules = [];
      this.persistSessions();
    }
    this._onDidChange.fire();
  }

  // --- State for sidebar ---

  getActiveSessions(): Array<{
    id: string;
    writeApproved: boolean;
    commandRuleCount: number;
    pathRuleCount: number;
    writeRuleCount: number;
    lastActivity: number;
  }> {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      writeApproved: s.writeApproved,
      commandRuleCount: s.commandRules.length,
      pathRuleCount: (s.pathRules ?? []).length,
      writeRuleCount: (s.writeRules ?? []).length,
      lastActivity: s.lastActivity,
    }));
  }

  // --- Internal ---

  private matchesPathRule(filePath: string, rule: PathRule): boolean {
    try {
      switch (rule.mode) {
        case "exact":
          return filePath === rule.pattern;
        case "prefix":
          return filePath.startsWith(rule.pattern);
        case "glob":
          return picomatch.isMatch(filePath, rule.pattern);
      }
    } catch {
      return false;
    }
  }

  private matchesRule(command: string, rule: CommandRule): boolean {
    try {
      switch (rule.mode) {
        case "exact":
          return command === rule.pattern.trim();
        case "prefix":
          return command.startsWith(rule.pattern.trim());
        case "regex":
          return new RegExp(rule.pattern).test(command);
      }
    } catch {
      // Invalid regex — treat as no match
      return false;
    }
  }

  /** Get session state for reading. Returns an empty session if none exists (no side effect). */
  private getSession(sessionId: string): Readonly<SessionState> {
    return this.sessions.get(sessionId) ?? this.emptySession;
  }

  private clearMcpApprovalsForSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.mcpApprovals) {
      if (key.startsWith(prefix)) {
        this.mcpApprovals.delete(key);
      }
    }
  }

  private loadPersistedSessions(): void {
    const persisted = this.globalState.get<
      PersistedApprovalSessions | SessionState[] | undefined
    >(APPROVAL_SESSIONS_KEY);
    if (!persisted) return;

    if (Array.isArray(persisted)) {
      return;
    }

    if (persisted.version !== 1 || !persisted.sessions) {
      return;
    }

    for (const [sessionId, session] of Object.entries(persisted.sessions)) {
      this.sessions.set(sessionId, {
        writeApproved: !!session.writeApproved,
        agentWriteApproved: !!session.agentWriteApproved,
        commandRules: [...(session.commandRules ?? [])],
        pathRules: [...(session.pathRules ?? [])],
        writeRules: [...(session.writeRules ?? [])],
        lastActivity: session.lastActivity || Date.now(),
      });
    }
  }

  private persistSessions(): void {
    const sessions = Object.fromEntries(this.sessions.entries());
    void this.globalState.update(APPROVAL_SESSIONS_KEY, {
      version: 1,
      sessions,
    } satisfies PersistedApprovalSessions);
  }

  private readonly emptySession: Readonly<SessionState> = Object.freeze({
    writeApproved: false,
    agentWriteApproved: false,
    commandRules: [],
    pathRules: [],
    writeRules: [],
    lastActivity: 0,
  });

  private newSession(): SessionState {
    return {
      writeApproved: false,
      agentWriteApproved: false,
      commandRules: [],
      pathRules: [],
      writeRules: [],
      lastActivity: Date.now(),
    };
  }
}

function deduplicateRules<T extends { pattern: string; mode: string }>(
  rules: T[],
): T[] {
  const seen = new Set<string>();
  return rules.filter((r) => {
    const key = `${r.pattern}\0${r.mode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
