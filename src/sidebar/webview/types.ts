// Shared types between extension and webview.
// Imported by both SidebarProvider.ts (Node) and webview components (browser).

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
}

export interface SidebarState {
  serverRunning: boolean;
  port: number | null;
  sessions: number;
  authEnabled: boolean;
  agentConfigured: boolean;
  masterBypass: boolean;
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
  status: "active" | "completed";
  completedAt?: number;
  lastHeartbeatAt?: number;
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
export interface WebviewCommand {
  command: string;
  [key: string]: unknown;
}

// Helper type for the postCommand function passed via props
export type PostCommand = (
  command: string,
  data?: Record<string, string>,
) => void;
