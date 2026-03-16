/**
 * Single source of truth for all tool input schemas.
 *
 * Used by:
 * - src/server/tools/*.ts — MCP tool registration (zod schemas)
 * - src/agent/toolAdapter.ts — Claude SDK tool definitions (converted to JSON Schema)
 *
 * Each tool's schema is exported as a record of zod types, matching the format
 * expected by McpServer.registerTool's inputSchema parameter.
 */

import { z } from "zod";

// ─── File tools ──────────────────────────────────────────────────────────────

export const readFileSchema = {
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
  query: z
    .string()
    .optional()
    .describe(
      "Semantic search query to jump to the most relevant section of the file. Uses the codebase index to find the best matching code chunk and auto-sets the offset. Ignored if offset is explicitly provided. Requires codebase index.",
    ),
};

export const listFilesSchema = {
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
  query: z
    .string()
    .optional()
    .describe(
      "Semantic search query to find files by meaning (e.g. 'authentication logic', 'database migrations'). Returns files ranked by relevance using the codebase index. Other params (recursive, depth, pattern) are ignored when query is provided. Requires codebase index.",
    ),
};

export const searchFilesSchema = {
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
      "Use semantic/vector search instead of regex. Requires a codebase index and OpenAI/Codex authentication (ChatGPT/Codex OAuth or an OpenAI API key). Default: false",
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
};

export const getDiagnosticsSchema = {
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
};

// ─── Write tools ─────────────────────────────────────────────────────────────

export const writeFileSchema = {
  path: z
    .string()
    .describe("File path (absolute or relative to workspace root)"),
  content: z.string().describe("Complete file content to write"),
};

export const applyDiffSchema = {
  path: z
    .string()
    .describe("File path (absolute or relative to workspace root)"),
  diff: z
    .string()
    .describe(
      "Search/replace blocks in <<<<<<< SEARCH / ======= DIVIDER ======= / >>>>>>> REPLACE format",
    ),
};

export const findAndReplaceSchema = {
  find: z
    .string()
    .describe("Text to find. Treated as a literal string unless regex=true."),
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
};

export const renameSymbolSchema = {
  path: z
    .string()
    .describe(
      "File path containing the symbol (absolute or relative to workspace root)",
    ),
  line: z.coerce.number().describe("Line number of the symbol (1-indexed)"),
  column: z.coerce.number().describe("Column number of the symbol (1-indexed)"),
  new_name: z.string().describe("The new name for the symbol"),
};

// ─── Editor tools ────────────────────────────────────────────────────────────

export const openFileSchema = {
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
    .describe("Column number for cursor placement (1-indexed, requires line)"),
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
};

export const showNotificationSchema = {
  message: z.string().describe("The notification message to display"),
  type: z
    .enum(["info", "warning", "error"])
    .optional()
    .describe("Notification type (default: 'info')"),
};

// ─── Terminal tools ──────────────────────────────────────────────────────────

export const executeCommandSchema = {
  command: z.string().describe("Shell command to execute"),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory (absolute or relative to workspace root). Reused unnamed terminals are only selected when their current tracked cwd matches this value; otherwise a new terminal is created.",
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
    .describe("Run in a named terminal, creating it if needed."),
  split_from: z
    .string()
    .optional()
    .describe(
      "Split a new terminal alongside an existing terminal or terminal group.",
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
      "Timeout in seconds. Always set one for quick commands; omit it only when you intentionally want to wait indefinitely.",
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
      "Bypass command validation only for false-positive rejections of direct file-reading commands.",
    ),
  force_reason: z
    .string()
    .optional()
    .describe(
      "Required when force=true; explain why the rejection was a false positive.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Short reason explaining why you need to run this command (shown to the user in the approval dialog). Keep it to one sentence.",
    ),
};

export const getTerminalOutputSchema = {
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
};

export const closeTerminalsSchema = {
  names: z
    .array(z.string())
    .optional()
    .describe(
      "Terminal names to close (e.g. ['Server', 'Tests']). Omit to close all managed terminals.",
    ),
};

// ─── Language tools ──────────────────────────────────────────────────────────

/** Common schema for go_to_definition, go_to_implementation, go_to_type_definition, get_hover */
export const positionSchema = {
  path: z
    .string()
    .describe("File path (absolute or relative to workspace root)"),
  line: z.coerce.number().describe("Line number (1-indexed)"),
  column: z.coerce.number().describe("Column number (1-indexed)"),
};

export const getReferencesSchema = {
  ...positionSchema,
  include_declaration: z
    .boolean()
    .optional()
    .describe("Include the declaration itself in results (default: true)"),
};

export const getSymbolsSchema = {
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
};

export const getCompletionsSchema = {
  ...positionSchema,
  limit: z.coerce
    .number()
    .optional()
    .describe("Maximum number of completion items to return (default: 50)"),
};

export const getCodeActionsSchema = {
  ...positionSchema,
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
    .describe("Only return preferred/recommended actions (default: false)."),
};

export const applyCodeActionSchema = {
  index: z.coerce
    .number()
    .describe(
      "0-based index of the action to apply (from get_code_actions result).",
    ),
};

export const getCallHierarchySchema = {
  ...positionSchema,
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
};

export const getTypeHierarchySchema = {
  ...positionSchema,
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
};

export const getInlayHintsSchema = {
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
};

// ─── Search tools ────────────────────────────────────────────────────────────

export const codebaseSearchSchema = {
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
  exclude_globs: z
    .array(z.string())
    .optional()
    .describe(
      "Glob patterns to exclude from semantic results after retrieval (e.g. ['**/.agentlink/**', '**/dist/**']). Useful for suppressing noisy indexed paths without rebuilding the index.",
    ),
};

// ─── Session tools ───────────────────────────────────────────────────────────

export const handshakeSchema = {
  working_directories: z
    .array(z.string())
    .describe(
      "All working directories known to the agent (primary + additional)",
    ),
};
