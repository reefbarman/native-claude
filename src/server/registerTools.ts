import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolCallTracker } from "./ToolCallTracker.js";
import { handleReadFile } from "../tools/readFile.js";
import { handleListFiles } from "../tools/listFiles.js";
import { handleSearchFiles } from "../tools/searchFiles.js";
import { handleGetDiagnostics } from "../tools/getDiagnostics.js";
import { handleWriteFile } from "../tools/writeFile.js";
import { handleApplyDiff } from "../tools/applyDiff.js";
import { handleExecuteCommand } from "../tools/executeCommand.js";
import { handleGoToDefinition } from "../tools/goToDefinition.js";
import { handleGetReferences } from "../tools/getReferences.js";
import { handleGetSymbols } from "../tools/getSymbols.js";
import { handleGetHover } from "../tools/getHover.js";
import { handleGetCompletions } from "../tools/getCompletions.js";
import { handleOpenFile } from "../tools/openFile.js";
import { handleShowNotification } from "../tools/showNotification.js";
import { handleRenameSymbol } from "../tools/renameSymbol.js";
import { handleCloseTerminals } from "../tools/closeTerminals.js";
import { handleGetTerminalOutput } from "../tools/getTerminalOutput.js";
import { handleSendFeedback } from "../tools/sendFeedback.js";
import { handleGetFeedback } from "../tools/getFeedback.js";
import { handleDeleteFeedback } from "../tools/deleteFeedback.js";
import { handleFindAndReplace } from "../tools/findAndReplace.js";
import { handleGoToImplementation } from "../tools/goToImplementation.js";
import { handleGoToTypeDefinition } from "../tools/goToTypeDefinition.js";
import {
  handleGetCodeActions,
  handleApplyCodeAction,
} from "../tools/codeActions.js";
import { handleGetCallHierarchy } from "../tools/getCallHierarchy.js";
import { handleGetTypeHierarchy } from "../tools/getTypeHierarchy.js";
import { handleGetInlayHints } from "../tools/getInlayHints.js";
import { handleHandshake } from "../tools/handshake.js";
import {
  TOOL_REGISTRY,
  TOOL_NAMES,
  DEV_TOOL_NAMES,
} from "../shared/toolRegistry.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

/** Closures for per-session trust state, provided by McpServerHost. */
export interface TrustGate {
  isSessionTrusted: () => boolean;
  markSessionTrusted: () => void;
  getTrustAttempts: () => number;
  incrementTrustAttempts: () => void;
}

/** Look up a tool's description from the registry. Throws if not found. */
function desc(name: string): string {
  const entry = TOOL_REGISTRY[name];
  if (!entry) throw new Error(`Tool "${name}" not found in TOOL_REGISTRY`);
  return entry.description;
}

export function registerTools(
  server: McpServer,
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  getSessionId: () => string | undefined,
  tracker: ToolCallTracker,
  extensionUri: import("vscode").Uri,
  trust: TrustGate,
): void {
  const sid = () => getSessionId() ?? "unknown";
  const touch = () => approvalManager.touchSession(sid());
  const log = (msg: string) => console.log(`[AgentLink] ${msg}`);

  /**
   * Gate wrapper — rejects tool calls from untrusted sessions with an
   * escalating error message. After 3+ failed attempts, tells the agent
   * it's likely connected to the wrong MCP server instance.
   */
  function requireTrust<P extends Record<string, unknown>>(
    handler: (params: P, ...rest: unknown[]) => Promise<ToolResult>,
  ): (params: P, ...rest: unknown[]) => Promise<ToolResult> {
    return async (params: P, ...rest: unknown[]) => {
      if (!trust.isSessionTrusted()) {
        trust.incrementTrustAttempts();
        const attempts = trust.getTrustAttempts();
        const shortId = sid().substring(0, 12);
        log(
          `Rejected tool call for untrusted session ${shortId} (attempt ${attempts})`,
        );
        const base =
          "Session not trusted. Call the 'handshake' tool first with your working_directories parameter (an array of all your known working directories).";
        const escalation =
          attempts >= 3
            ? "\n\nYou appear to be connected to the wrong MCP server instance. Ask the user to reload the VS Code window or refresh their AI agent's MCP connections."
            : "";
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: base + escalation }) },
          ],
        };
      }
      return handler(params, ...rest);
    };
  }

  // Track registered tool names for validation against the registry.
  // Also wraps all tool handlers (except "handshake") with the requireTrust
  // gate so untrusted sessions are rejected before any tool logic runs.
  const registeredTools = new Set<string>();
  const origRegisterTool = server.registerTool.bind(server);
  server.registerTool = ((...args: unknown[]) => {
    const toolName = typeof args[0] === "string" ? args[0] : undefined;
    if (toolName) registeredTools.add(toolName);

    // Wrap the handler (3rd arg) with requireTrust for all tools except handshake
    if (toolName && toolName !== "handshake" && typeof args[2] === "function") {
      const originalHandler = args[2] as (
        params: Record<string, unknown>,
        extra?: unknown,
      ) => Promise<ToolResult>;
      args[2] = requireTrust(originalHandler);
    }

    return (origRegisterTool as Function)(...args);
  }) as typeof server.registerTool;

  // --- Session lifecycle ---

  server.registerTool(
    "handshake",
    {
      description: desc("handshake"),
      inputSchema: {
        working_directories: z
          .array(z.string())
          .describe(
            "All working directories known to the agent (primary + additional)",
          ),
      },
    },
    tracker.wrapHandler(
      "handshake",
      (params) => {
        touch();
        const shortId = sid().substring(0, 12);
        return handleHandshake(
          params,
          trust.markSessionTrusted,
          log,
          shortId,
        );
      },
      (p) =>
        Array.isArray(p.working_directories)
          ? `${(p.working_directories as string[]).length} dirs`
          : "",
      sid,
    ),
  );

  // --- Read-only tools ---

  server.registerTool(
    "read_file",
    {
      description: desc("read_file"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        offset: z.coerce
          .number()
          .optional()
          .describe("Starting line number (1-indexed, default: 1)"),
        limit: z.coerce
          .number()
          .optional()
          .describe("Maximum number of lines to read (default: 2000)"),
        include_symbols: z
          .boolean()
          .optional()
          .describe(
            "Include top-level symbol outline (functions, classes, interfaces). Default: true. Set to false to suppress.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "read_file",
      (params) => {
        touch();
        return handleReadFile(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "list_files",
    {
      description: desc("list_files"),
      inputSchema: {
        path: z
          .string()
          .describe("Directory path (absolute or relative to workspace root)"),
        recursive: z
          .boolean()
          .optional()
          .describe("List recursively (default: false)"),
        depth: z.coerce
          .number()
          .optional()
          .describe(
            "Maximum directory depth for recursive listing (e.g. 2 for two levels deep). Only used when recursive=true.",
          ),
        pattern: z
          .string()
          .optional()
          .describe(
            "Glob pattern to filter files (e.g. '*.ts', '*.test.*'). Implies recursive search. Uses ripgrep glob syntax.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "list_files",
      (params) => {
        touch();
        return handleListFiles(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "search_files",
    {
      description: desc("search_files"),
      inputSchema: {
        path: z
          .string()
          .describe(
            "Directory to search in (absolute or relative to workspace root)",
          ),
        regex: z
          .string()
          .describe(
            "Regular expression pattern for regex search, or natural language query for semantic search",
          ),
        file_pattern: z
          .string()
          .optional()
          .describe(
            "Glob pattern to filter files (e.g. '*.ts'). Only used for regex search.",
          ),
        semantic: z
          .boolean()
          .optional()
          .describe(
            "Use semantic/vector search instead of regex. Requires codebase index and OpenAI API key. Default: false",
          ),
        context: z.coerce
          .number()
          .optional()
          .describe(
            "Number of context lines to show around each match (default: 1). Only used for content output mode. Overridden by context_before/context_after if specified.",
          ),
        context_before: z.coerce
          .number()
          .optional()
          .describe(
            "Number of context lines to show BEFORE each match (like grep -B). Overrides 'context' for before-match lines.",
          ),
        context_after: z.coerce
          .number()
          .optional()
          .describe(
            "Number of context lines to show AFTER each match (like grep -A). Overrides 'context' for after-match lines.",
          ),
        case_insensitive: z
          .boolean()
          .optional()
          .describe(
            "Case-insensitive search (default: false). Only used for regex search.",
          ),
        multiline: z
          .boolean()
          .optional()
          .describe(
            "Enable multiline matching where . matches newlines and patterns can span lines (default: false).",
          ),
        max_results: z.coerce
          .number()
          .optional()
          .describe("Maximum number of matches to return (default: 300)."),
        offset: z.coerce
          .number()
          .optional()
          .describe(
            "Skip first N matches before returning results. Use with max_results for pagination (e.g. offset=100, max_results=100 for second page).",
          ),
        output_mode: z
          .enum(["content", "files_with_matches", "count"])
          .optional()
          .describe(
            "Output format: 'content' shows matching lines with context (default), 'files_with_matches' shows only file paths, 'count' shows match counts per file.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "search_files",
      (params) => {
        touch();
        return handleSearchFiles(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.regex ?? "").slice(0, 60),
      sid,
    ),
  );

  server.registerTool(
    "get_diagnostics",
    {
      description: desc("get_diagnostics"),
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "File path to get diagnostics for (omit for all workspace diagnostics)",
          ),
        severity: z
          .string()
          .optional()
          .describe(
            "Comma-separated severity filter (e.g. 'error', 'error,warning'). Options: error, warning, info/information, hint. Default: all severities.",
          ),
        source: z
          .string()
          .optional()
          .describe(
            "Comma-separated source filter (e.g. 'typescript', 'eslint'). Only show diagnostics from matching sources. Default: all sources.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_diagnostics",
      (params) => {
        touch();
        return handleGetDiagnostics(params);
      },
      (p) => String(p.path ?? "workspace"),
      sid,
    ),
  );

  // --- Language intelligence tools ---

  server.registerTool(
    "go_to_definition",
    {
      description: desc("go_to_definition"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "go_to_definition",
      (params) => {
        touch();
        return handleGoToDefinition(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "get_references",
    {
      description: desc("get_references"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
        include_declaration: z
          .boolean()
          .optional()
          .describe(
            "Include the declaration itself in results (default: true)",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_references",
      (params) => {
        touch();
        return handleGetReferences(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "get_symbols",
    {
      description: desc("get_symbols"),
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "File path for document symbols (absolute or relative to workspace root)",
          ),
        query: z
          .string()
          .optional()
          .describe(
            "Search query for workspace-wide symbol search. Used when path is omitted.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_symbols",
      (params) => {
        touch();
        return handleGetSymbols(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? p.query ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "get_hover",
    {
      description: desc("get_hover"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_hover",
      (params) => {
        touch();
        return handleGetHover(params, approvalManager, approvalPanel, sid());
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "go_to_implementation",
    {
      description: desc("go_to_implementation"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "go_to_implementation",
      (params) => {
        touch();
        return handleGoToImplementation(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "go_to_type_definition",
    {
      description: desc("go_to_type_definition"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "go_to_type_definition",
      (params) => {
        touch();
        return handleGoToTypeDefinition(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "get_code_actions",
    {
      description: desc("get_code_actions"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
        end_line: z.coerce
          .number()
          .optional()
          .describe(
            "End line for range selection (1-indexed). Omit for actions at a single position.",
          ),
        end_column: z.coerce
          .number()
          .optional()
          .describe("End column for range selection (1-indexed)."),
        kind: z
          .string()
          .optional()
          .describe(
            "Filter by action kind (e.g. 'quickfix', 'refactor', 'refactor.extract', 'source.organizeImports', 'source.fixAll').",
          ),
        only_preferred: z
          .boolean()
          .optional()
          .describe(
            "Only return preferred/recommended actions (default: false).",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_code_actions",
      (params) => {
        touch();
        return handleGetCodeActions(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "apply_code_action",
    {
      description: desc("apply_code_action"),
      inputSchema: {
        index: z.coerce
          .number()
          .describe(
            "0-based index of the action to apply (from get_code_actions result).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "apply_code_action",
      (params) => {
        touch();
        return handleApplyCodeAction(params);
      },
      (p) => `action[${p.index}]`,
      sid,
    ),
  );

  server.registerTool(
    "get_call_hierarchy",
    {
      description: desc("get_call_hierarchy"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
        direction: z
          .enum(["incoming", "outgoing", "both"])
          .describe(
            "Which direction to explore: 'incoming' (who calls this), 'outgoing' (what this calls), or 'both'.",
          ),
        max_depth: z.coerce
          .number()
          .optional()
          .describe(
            "Maximum recursion depth for call chain (default: 1, max: 3). Higher values return deeper call trees.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_call_hierarchy",
      (params) => {
        touch();
        return handleGetCallHierarchy(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "get_type_hierarchy",
    {
      description: desc("get_type_hierarchy"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
        direction: z
          .enum(["supertypes", "subtypes", "both"])
          .describe(
            "Which direction to explore: 'supertypes' (parent types), 'subtypes' (child types), or 'both'.",
          ),
        max_depth: z.coerce
          .number()
          .optional()
          .describe(
            "Maximum recursion depth (default: 2, max: 5). Controls how many levels of the hierarchy to return.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_type_hierarchy",
      (params) => {
        touch();
        return handleGetTypeHierarchy(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  server.registerTool(
    "get_inlay_hints",
    {
      description: desc("get_inlay_hints"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        start_line: z.coerce
          .number()
          .optional()
          .describe("Start of range (1-indexed, default: 1)."),
        end_line: z.coerce
          .number()
          .optional()
          .describe("End of range (1-indexed, default: end of file)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_inlay_hints",
      (params) => {
        touch();
        return handleGetInlayHints(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "get_completions",
    {
      description: desc("get_completions"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce.number().describe("Line number (1-indexed)"),
        column: z.coerce.number().describe("Column number (1-indexed)"),
        limit: z.coerce
          .number()
          .optional()
          .describe(
            "Maximum number of completion items to return (default: 50)",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_completions",
      (params) => {
        touch();
        return handleGetCompletions(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => `${p.path}:${p.line}`,
      sid,
    ),
  );

  // --- Editor actions ---

  server.registerTool(
    "open_file",
    {
      description: desc("open_file"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        line: z.coerce
          .number()
          .optional()
          .describe("Line number to scroll to (1-indexed)"),
        column: z.coerce
          .number()
          .optional()
          .describe(
            "Column number for cursor placement (1-indexed, requires line)",
          ),
        end_line: z.coerce
          .number()
          .optional()
          .describe(
            "End line number for range selection (1-indexed, requires line). Highlights the range from line:column to end_line:end_column.",
          ),
        end_column: z.coerce
          .number()
          .optional()
          .describe(
            "End column number for range selection (1-indexed, requires end_line).",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "open_file",
      (params) => {
        touch();
        return handleOpenFile(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "show_notification",
    {
      description: desc("show_notification"),
      inputSchema: {
        message: z.string().describe("The notification message to display"),
        type: z
          .enum(["info", "warning", "error"])
          .optional()
          .describe("Notification type (default: 'info')"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "show_notification",
      (params) => {
        touch();
        return handleShowNotification(params);
      },
      (p) => String(p.message ?? "").slice(0, 60),
      sid,
    ),
  );

  // --- Write tools (diff-view based) ---

  server.registerTool(
    "write_file",
    {
      description: desc("write_file"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        content: z.string().describe("Complete file content to write"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "write_file",
      (params) => {
        touch();
        return handleWriteFile(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "apply_diff",
    {
      description: desc("apply_diff"),
      inputSchema: {
        path: z
          .string()
          .describe("File path (absolute or relative to workspace root)"),
        diff: z
          .string()
          .describe(
            "Search/replace blocks in <<<<<<< SEARCH / ======= DIVIDER ======= / >>>>>>> REPLACE format",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "apply_diff",
      (params) => {
        touch();
        return handleApplyDiff(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  // --- Rename & find-and-replace ---

  server.registerTool(
    "rename_symbol",
    {
      description: desc("rename_symbol"),
      inputSchema: {
        path: z
          .string()
          .describe(
            "File path containing the symbol (absolute or relative to workspace root)",
          ),
        line: z.coerce
          .number()
          .describe("Line number of the symbol (1-indexed)"),
        column: z.coerce
          .number()
          .describe("Column number of the symbol (1-indexed)"),
        new_name: z.string().describe("The new name for the symbol"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "rename_symbol",
      (params) => {
        touch();
        return handleRenameSymbol(
          params,
          approvalManager,
          approvalPanel,
          sid(),
        );
      },
      (p) => String(p.new_name ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "find_and_replace",
    {
      description: desc("find_and_replace"),
      inputSchema: {
        find: z
          .string()
          .describe(
            "Text to find. Treated as a literal string unless regex=true.",
          ),
        replace: z.string().describe("Replacement text"),
        path: z
          .string()
          .optional()
          .describe(
            "Single file path to search in (absolute or relative to workspace root). Mutually exclusive with glob.",
          ),
        glob: z
          .string()
          .optional()
          .describe(
            "Glob pattern to match files (e.g. 'src/**/*.ts'). Mutually exclusive with path.",
          ),
        regex: z
          .boolean()
          .optional()
          .describe(
            "Treat 'find' as a regular expression. Supports capture groups ($1, $2) in 'replace'. Default: false.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "find_and_replace",
      (params) => {
        touch();
        return handleFindAndReplace(
          params,
          approvalManager,
          approvalPanel,
          sid(),
          extensionUri,
        );
      },
      (p) => `${p.find?.slice(0, 30)} → ${p.replace?.slice(0, 30)}`,
      sid,
    ),
  );

  // --- Terminal ---

  server.registerTool(
    "execute_command",
    {
      description: desc("execute_command"),
      inputSchema: {
        command: z.string().describe("Shell command to execute"),
        cwd: z
          .string()
          .optional()
          .describe(
            "Working directory (absolute or relative to workspace root)",
          ),
        terminal_id: z
          .string()
          .optional()
          .describe(
            "Run in a specific terminal by ID (returned from previous commands)",
          ),
        terminal_name: z
          .string()
          .optional()
          .describe(
            "Run in a named terminal (e.g. 'Server', 'Build', 'Tests'). Creates if it doesn't exist. Enables parallel execution in separate terminals.",
          ),
        split_from: z
          .string()
          .optional()
          .describe(
            "Split the new terminal alongside an existing terminal (by terminal_id or terminal_name), creating a visual group. Only takes effect when a new terminal is created — ignored if terminal_name matches an existing idle terminal. Example: start a backend server with terminal_name='Backend', then use split_from='Backend' with terminal_name='Frontend' to group them side-by-side.",
          ),
        background: z
          .boolean()
          .optional()
          .describe(
            "Run without waiting for completion. Use for long-running processes like dev servers. Returns immediately with terminal_id.",
          ),
        timeout: z.coerce
          .number()
          .optional()
          .describe(
            "Timeout in seconds. If set, command output is returned when the timeout is reached, but the command may still be running in the terminal. If omitted, waits indefinitely for the command to finish. IMPORTANT: Always set a timeout for commands you expect to complete quickly (e.g. git, ls, cat, grep, npm test — use 10-30s). This prevents the session from hanging if a command unexpectedly blocks. Only omit timeout for long-running processes where you explicitly want to wait indefinitely.",
          ),
        output_head: z.coerce
          .number()
          .optional()
          .describe(
            "Return only the first N lines of output. Overrides the default 200-line tail cap.",
          ),
        output_tail: z.coerce
          .number()
          .optional()
          .describe(
            "Return only the last N lines of output. Overrides the default 200-line tail cap.",
          ),
        output_offset: z.coerce
          .number()
          .optional()
          .describe(
            'Skip first N lines/entries before applying head/tail, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
          ),
        output_grep: z
          .string()
          .optional()
          .describe(
            "Filter output to lines matching this regex pattern (case-insensitive). Applied before head/tail. Use this instead of piping through grep.",
          ),
        output_grep_context: z.coerce
          .number()
          .optional()
          .describe(
            "Number of context lines around each grep match (like grep -C). Only used with output_grep.",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "Bypass command validation (the auto-rejection of grep, cat, head, tail, sed). Use when the rejection is a false positive — e.g. commands with shell expansion ($(), env vars) in arguments.",
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    tracker.wrapHandler(
      "execute_command",
      (params, ctx) => {
        touch();
        return handleExecuteCommand(
          params,
          approvalManager,
          approvalPanel,
          sid(),
          ctx,
        );
      },
      (p) => String(p.command ?? "").slice(0, 80),
      sid,
    ),
  );

  server.registerTool(
    "close_terminals",
    {
      description: desc("close_terminals"),
      inputSchema: {
        names: z
          .array(z.string())
          .optional()
          .describe(
            "Terminal names to close (e.g. ['Server', 'Tests']). Omit to close all managed terminals.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "close_terminals",
      (params) => {
        touch();
        return handleCloseTerminals(params);
      },
      (p) =>
        Array.isArray(p.names) ? (p.names as string[]).join(", ") : "all",
      sid,
    ),
  );

  server.registerTool(
    "get_terminal_output",
    {
      description: desc("get_terminal_output"),
      inputSchema: {
        terminal_id: z
          .string()
          .describe("Terminal ID returned by execute_command (e.g. 'term_3')"),
        wait_seconds: z.coerce
          .number()
          .optional()
          .describe(
            "Wait up to N seconds for new output to appear before returning. Useful when a background command was just started and you want to avoid a double-call. Polls every 250ms and returns early when new output arrives or the command finishes.",
          ),
        kill: z
          .boolean()
          .optional()
          .describe(
            "Send Ctrl+C (SIGINT) to kill the running command. Returns captured output.",
          ),
        output_head: z.coerce
          .number()
          .optional()
          .describe("Return only the first N lines of output."),
        output_tail: z.coerce
          .number()
          .optional()
          .describe("Return only the last N lines of output."),
        output_offset: z.coerce
          .number()
          .optional()
          .describe("Skip first N lines before applying head/tail."),
        output_grep: z
          .string()
          .optional()
          .describe(
            "Filter output to lines matching this regex pattern (case-insensitive).",
          ),
        output_grep_context: z.coerce
          .number()
          .optional()
          .describe("Number of context lines around each grep match."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_terminal_output",
      (params) => {
        touch();
        return handleGetTerminalOutput(params);
      },
      (p) => String(p.terminal_id ?? ""),
      sid,
    ),
  );

  // --- Semantic search ---

  server.registerTool(
    "codebase_search",
    {
      description: desc("codebase_search"),
      inputSchema: {
        query: z
          .string()
          .describe(
            "Natural language query describing what you're looking for (e.g. 'error handling in API routes', 'how files get uploaded')",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Directory to scope the search to (absolute or relative to workspace root). Omit to search the entire workspace.",
          ),
        limit: z.coerce
          .number()
          .optional()
          .describe(
            "Maximum number of results to return (default: 10). Higher values return more results but increase context size.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "codebase_search",
      async (params) => {
        touch();
        const { semanticSearch } =
          await import("../services/semanticSearch.js");
        const { resolveAndValidatePath, getFirstWorkspaceRoot } =
          await import("../util/paths.js");
        const dirPath = params.path
          ? resolveAndValidatePath(String(params.path)).absolutePath
          : getFirstWorkspaceRoot();
        return semanticSearch(dirPath, String(params.query), params.limit);
      },
      (p) => String(p.query ?? "").slice(0, 60),
      sid,
    ),
  );

  // --- Dev-only tools ---

  if (__DEV_BUILD__) {
    server.registerTool(
      "send_feedback",
      {
        description: desc("send_feedback"),
        inputSchema: {
          tool_name: z
            .string()
            .describe("Name of the tool this feedback is about"),
          feedback: z
            .string()
            .describe(
              "Description of the issue, suggestion, or missing feature",
            ),
          tool_params: z
            .string()
            .optional()
            .describe(
              "The parameters that were passed to the tool (will be truncated to ~500 chars)",
            ),
          tool_result_summary: z
            .string()
            .optional()
            .describe(
              "Summary of what happened or the result received (will be truncated to ~500 chars)",
            ),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      tracker.wrapHandler(
        "send_feedback",
        (params) => {
          touch();
          return handleSendFeedback(params, sid());
        },
        (p) => String(p.tool_name ?? ""),
        sid,
      ),
    );

    server.registerTool(
      "get_feedback",
      {
        description: desc("get_feedback"),
        inputSchema: {
          tool_name: z
            .string()
            .optional()
            .describe(
              "Filter to feedback about a specific tool (omit for all feedback)",
            ),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      tracker.wrapHandler(
        "get_feedback",
        (params) => {
          touch();
          return handleGetFeedback(params);
        },
        (p) => String(p.tool_name ?? "all"),
        sid,
      ),
    );

    server.registerTool(
      "delete_feedback",
      {
        description: desc("delete_feedback"),
        inputSchema: {
          indices: z
            .array(z.coerce.number())
            .describe(
              "Array of 0-based indices to delete (e.g. [0, 2] to delete the first and third entries)",
            ),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
      },
      tracker.wrapHandler(
        "delete_feedback",
        (params) => {
          touch();
          return handleDeleteFeedback(params);
        },
        (p) =>
          Array.isArray(p.indices)
            ? (p.indices as number[]).join(", ")
            : "none",
        sid,
      ),
    );
  }

  // Validate that every registered tool is in the registry and vice versa.
  // This catches forgotten additions to toolRegistry.ts at startup.
  const expected = new Set([
    ...TOOL_NAMES,
    ...(__DEV_BUILD__ ? DEV_TOOL_NAMES : []),
  ]);
  const missingFromRegistry = [...registeredTools].filter(
    (n) => !expected.has(n),
  );
  const missingFromRegister = [...expected].filter(
    (n) => !registeredTools.has(n),
  );
  if (missingFromRegistry.length > 0 || missingFromRegister.length > 0) {
    const parts: string[] = [];
    if (missingFromRegistry.length > 0) {
      parts.push(
        `Tools registered but not in toolRegistry.ts: ${missingFromRegistry.join(", ")}`,
      );
    }
    if (missingFromRegister.length > 0) {
      parts.push(
        `Tools in toolRegistry.ts but not registered: ${missingFromRegister.join(", ")}`,
      );
    }
    console.error(`[AgentLink] Tool registry mismatch!\n${parts.join("\n")}`);
  }
}
