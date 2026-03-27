// Shared types between extension and webview.
// Imported by both SidebarProvider.ts (Node) and webview components (browser).

import type { SemanticReadinessReason } from "../../shared/semanticReadiness.js";

export interface CommandRule {
  pattern: string;
  mode: "prefix" | "regex" | "exact";
}

export interface PathRule {
  pattern: string;
  mode: "glob" | "prefix" | "exact";
}

export interface SessionInfo {
  id: string;
  writeApproved: boolean;
  commandRules: CommandRule[];
  pathRules: PathRule[];
  writeRules: PathRule[];
  clientName?: string;
  clientVersion?: string;
  agentId?: string;
}

export interface ConnectedAgent {
  sessionId: string;
  clientName?: string;
  clientVersion?: string;
  agentId?: string;
  agentDisplayName?: string;
  /** Epoch ms of last MCP activity for this session. */
  lastActivity: number;
  /** Whether this session has completed the workspace handshake. */
  trustState: "trusted" | "untrusted";
}

export interface AgentInfo {
  id: string;
  name: string;
  selected: boolean;
}

export interface IndexStatusInfo {
  state: "idle" | "discovering" | "indexing" | "error";
  phase?: string;
  current?: number;
  total?: number;
  detail?: string;
  lastCompleted?: {
    filesIndexed: number;
    totalFilesInIndex: number;
    chunksCreated: number;
    totalChunksInIndex: number;
    durationMs: number;
    errorCount?: number;
    cancelled?: boolean;
  };
  error?: string;
  readinessReason?: SemanticReadinessReason;
  readinessMessage?: string;
}

export interface SidebarState {
  serverRunning: boolean;
  port: number | null;
  sessions: number;
  authEnabled: boolean;
  agentConfigured: boolean;
  masterBypass: boolean;
  hasWorkspace: boolean;
  onboardingStep?: number;
  knownAgents?: AgentInfo[];
  configuredAgentIds?: string[];
  writeApproval?: "prompt" | "session" | "project" | "global";
  globalCommandRules?: CommandRule[];
  projectCommandRules?: CommandRule[];
  globalPathRules?: PathRule[];
  projectPathRules?: PathRule[];
  globalWriteRules?: PathRule[];
  projectWriteRules?: PathRule[];
  settingsWriteRules?: string[];
  activeSessions?: SessionInfo[];
  connectedAgents?: ConnectedAgent[];
  indexStatus?: IndexStatusInfo;
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
  source: "mcp" | "agent";
}

export interface FeedbackEntry {
  timestamp: string;
  tool_name: string;
  feedback: string;
  session_id?: string;
  workspace?: string;
  extension_version: string;
  tool_params?: string;
  tool_result_summary?: string;
}

// Extension → Webview messages
export type ExtensionMessage =
  | { type: "stateUpdate"; state: SidebarState }
  | { type: "updateToolCalls"; calls: TrackedCallInfo[] }
  | { type: "updateFeedback"; entries: FeedbackEntry[] }
  | { type: "updateIndexStatus"; status: IndexStatusInfo };

// Webview → Extension messages
export type WebviewCommand =
  | { command: "startServer" }
  | { command: "stopServer" }
  | { command: "showStatus" }
  | { command: "openSettings" }
  | { command: "openOutput" }
  | { command: "clearSessionApprovals" }
  | { command: "rebuildIndex" }
  | { command: "cancelIndex" }
  | { command: "resumeIndex" }
  | { command: "setOpenaiApiKey" }
  | { command: "setOpenaiModelsAndEmbeddingsApiKey" }
  | { command: "setupSemanticSearch"; reason?: string }
  | { command: "addTrustedCommand" }
  | { command: "configureAgents" }
  | { command: "cancelToolCall"; id: string }
  | { command: "completeToolCall"; id: string }
  | { command: "saveAgents"; agentIds: string[] }
  | { command: "deleteRule"; ruleType: string; index: number; scope: string }
  | { command: "editRule"; ruleType: string; index: number; scope: string }
  | { command: string; [key: string]: unknown };

// Helper type for the postCommand function passed via props
export type PostCommand = (
  command: string,
  data?: Record<string, string>,
) => void;
