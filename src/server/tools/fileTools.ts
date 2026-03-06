import { z } from "zod";
import { handleReadFile } from "../../tools/readFile.js";
import { handleListFiles } from "../../tools/listFiles.js";
import { handleSearchFiles } from "../../tools/searchFiles.js";
import { handleGetDiagnostics } from "../../tools/getDiagnostics.js";
import type { ToolRegistrationContext } from "./types.js";

export function registerFileTools(ctx: ToolRegistrationContext): void {
  const { server, tracker, approvalManager, approvalPanel, sid, touch, desc } =
    ctx;

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
        query: z
          .string()
          .optional()
          .describe(
            "Semantic search query to jump to the most relevant section of the file. Uses the codebase index to find the best matching code chunk and auto-sets the offset. Ignored if offset is explicitly provided. Requires codebase index.",
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
        query: z
          .string()
          .optional()
          .describe(
            "Semantic search query to find files by meaning (e.g. 'authentication logic', 'database migrations'). Returns files ranked by relevance using the codebase index. Other params (recursive, depth, pattern) are ignored when query is provided. Requires codebase index.",
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
}
