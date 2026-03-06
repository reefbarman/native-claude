/**
 * Single source of truth for all AgentLink tools.
 *
 * Used by:
 * - registerTools.ts — registers schemas / handlers, looks up descriptions here
 * - AvailableTools.tsx — sidebar renders this list with hover descriptions
 *
 * When adding a new tool, add it here FIRST, then add its handler in registerTools.ts.
 */

export interface ToolMeta {
  /** Short label shown in the sidebar (keep concise) */
  label: string;
  /** Full description sent to the MCP client, shown on hover in sidebar */
  description: string;
  /** If true, only included in dev builds */
  devOnly?: boolean;
}

/**
 * Tool name → metadata. The keys are the canonical tool names — they appear
 * only here and nowhere else.
 */
export const TOOL_REGISTRY: Record<string, ToolMeta> = {
  // --- Session lifecycle ---

  handshake: {
    label: "Workspace handshake",
    description:
      "Establish a trusted connection by verifying workspace identity. Must be called before any other tool. Pass all your known working directories — the server validates that its workspace folders are present in your list. Returns { status: 'trusted' } on success or { status: 'rejected' } on failure.",
  },

  // --- File operations ---

  read_file: {
    label: "Read with line numbers",
    description:
      "Read the contents of a file with line numbers. Returns content in 'line_number | content' format. Includes file metadata (size, modified, language), git status, and diagnostics summary when available. Supports optional 'query' param to semantically jump to the most relevant section using the codebase index.",
  },
  list_files: {
    label: "Directory listing",
    description:
      "List files and directories at a given path. Directories have a trailing '/' suffix. Use 'pattern' to find files matching a glob (e.g. '*.test.ts'). Supports optional 'query' param to find files by meaning using the codebase index, returning files ranked by semantic relevance.",
  },
  search_files: {
    label: "Regex & semantic search",
    description:
      "Search file contents using regex, or perform semantic codebase search. Default: fast ripgrep regex search with context lines. When semantic=true, uses vector similarity search against the codebase index \u2014 'regex' is interpreted as a natural language query in this mode.",
  },
  write_file: {
    label: "Create/overwrite with diff review",
    description:
      "Create a new file or overwrite an existing file. Opens a diff view in VS Code for the user to review, optionally edit, and accept or reject the changes. Benefits from VS Code's format-on-save. Returns any user edits and new diagnostics.",
  },
  apply_diff: {
    label: "Search/replace with diff review",
    description:
      "Edit an existing file using search/replace blocks. Opens a diff view for user review. Each SEARCH block must match exactly one location. Supports multiple hunks in a single call \u2014 include multiple SEARCH/REPLACE blocks to make several edits at once. Format:\n<<<<<<< SEARCH\nexact content to find\n======= DIVIDER =======\nreplacement content\n>>>>>>> REPLACE",
  },
  find_and_replace: {
    label: "Bulk find-and-replace across files",
    description:
      "Bulk find-and-replace across MULTIPLE files using a glob pattern. Shows a preview of affected files for approval before applying. Supports literal strings and regex with capture groups. IMPORTANT: For single-file edits, prefer apply_diff instead \u2014 it provides better diff review and format-on-save. Only use find_and_replace for single files when making many identical replacements (e.g. renaming a variable throughout a file).",
  },

  // --- Diagnostics & language server ---

  get_diagnostics: {
    label: "Errors & warnings",
    description:
      "Get VS Code diagnostics (errors, warnings) for a file or the entire workspace.",
  },
  go_to_definition: {
    label: "Jump to symbol definition",
    description:
      "Resolve the definition location of a symbol using VS Code's language server. Returns the file path and position where the symbol is defined. Works across files and languages.",
  },
  go_to_implementation: {
    label: "Find concrete implementations",
    description:
      "Find implementations of an interface, abstract class, or method. Unlike go_to_definition which shows the declaration, this shows concrete implementations. Essential for navigating interface-heavy codebases (TypeScript, Java, C#).",
  },
  go_to_type_definition: {
    label: "Navigate to type definition",
    description:
      "Navigate to the type definition of a symbol. For 'const x = getFoo()', go_to_definition goes to getFoo's declaration, but go_to_type_definition goes to the return type. Useful for exploring API return types and inferred types.",
  },
  get_references: {
    label: "Find all usages",
    description:
      "Find all references to a symbol using VS Code's language server. Returns locations across the workspace where the symbol is used.",
  },
  get_symbols: {
    label: "Document/workspace symbols",
    description:
      "Get symbols from a document or search workspace symbols. Provide 'path' for document symbols (full hierarchy with children) or 'query' for workspace-wide symbol search. Returns symbol names, kinds, and locations.",
  },
  get_hover: {
    label: "Types & documentation",
    description:
      "Get hover information (inferred types, documentation) for a symbol at a specific position. Uses VS Code's language server to provide the same information shown when hovering in the editor.",
  },
  get_completions: {
    label: "Autocomplete suggestions",
    description:
      "Get autocomplete suggestions at a cursor position. Uses VS Code's language server to provide completion items \u2014 useful for discovering available methods, properties, and APIs.",
  },
  get_code_actions: {
    label: "Quick fixes & refactorings",
    description:
      "Get available code actions (quick fixes, refactorings) at a position or range. Returns actions like 'Add missing import', 'Extract function', 'Organize imports', 'Fix ESLint error', etc. Use apply_code_action to apply one. Provide end_line/end_column to get actions for a selection range.",
  },
  apply_code_action: {
    label: "Apply a code action",
    description:
      "Apply a code action returned by get_code_actions. Pass the index from the actions list. Modifies files directly (workspace edits are applied and saved). Call get_code_actions first to see available actions.",
  },
  get_call_hierarchy: {
    label: "Incoming/outgoing call chains",
    description:
      "Get incoming callers and/or outgoing callees for a function or method. Shows who calls this function (incoming) and what this function calls (outgoing). Supports recursive depth for exploring call chains.",
  },
  get_type_hierarchy: {
    label: "Supertypes & subtypes",
    description:
      "Get supertypes (parent classes/interfaces) and/or subtypes (child classes/implementations) of a type. Useful for understanding inheritance hierarchies and finding all implementations of an interface.",
  },
  get_inlay_hints: {
    label: "Inferred types & parameter names",
    description:
      "Get inlay hints (inferred types, parameter names) for a range of lines. Shows the same inline type annotations and parameter labels that VS Code displays in the editor. Useful for understanding type inference without hovering each symbol.",
  },
  rename_symbol: {
    label: "Rename across workspace",
    description:
      "Rename a symbol across the workspace using VS Code's language server. Performs a precise rename refactoring that updates all references, imports, and re-exports. Shows affected files for approval before applying.",
  },

  // --- Terminal & editor ---

  execute_command: {
    label: "Integrated terminal",
    description:
      "Run a command in VS Code's integrated terminal. The terminal is visible to the user. Output is captured when shell integration is available.\n\nWorking directory: Commands run in the workspace root by default. Use 'cwd' to set the initial directory when creating a new terminal. The response includes a 'cwd' field showing the terminal's actual working directory after the command finished — this reflects any directory changes made by the command (e.g. `cd subdir && ...`). Do NOT run `pwd` — read the 'cwd' field from the response instead. Note: 'cwd' is omitted from the response when shell integration is unavailable.\n\nTerminal reuse: By default, reuses an existing idle terminal \u2014 do NOT pass terminal_name or terminal_id for normal commands. Only use terminal_name when you need a genuinely separate terminal for parallel execution (e.g. a background dev server running alongside normal commands). Do not create named terminals for one-off commands.\n\nTerminal splitting: Use split_from with a terminal_id or terminal_name to create a new terminal split alongside an existing one, forming a visual group in VS Code's terminal panel. Only affects new terminal creation \u2014 if the target terminal_name already exists and is idle, it is reused without re-splitting.\n\nBackground commands: Use background=true for long-running processes (dev servers, watch modes). Returns immediately with terminal_id. Use get_terminal_output with the terminal_id to check on progress, read accumulated output, and see if the command has finished. Background terminals are never auto-reused \u2014 always use terminal_name or terminal_id to target them.\n\nOutput is capped to the last 200 lines by default. Full output is saved to a temp file (returned as output_file) for on-demand access via read_file. Use output_head, output_tail, or output_grep to customize filtering. IMPORTANT: Commands that pipe through head, tail, or grep (e.g. `cmd | head -5`) will be automatically REJECTED. Use the output_head, output_tail, and output_grep parameters instead \u2014 they filter the output returned to you while keeping the full output visible to the user in the terminal. If a command is wrongly rejected, retry with force=true to bypass validation.\n\nInteractive commands: Commands that require interactive input (editors like vim/nano, REPLs without scripts, TUI apps like htop, bare database CLIs, interactive git flags like -i/-p, scaffolders without --yes) will be automatically REJECTED with a helpful suggestion. Always use non-interactive alternatives: pass -y/--yes flags, use -c/-e for inline execution, provide all arguments upfront, or use the appropriate agentlink tool (write_file, apply_diff) instead of editors.",
  },
  get_terminal_output: {
    label: "Read background terminal output",
    description:
      "Get the output and status of a background or timed-out command running in a terminal. Use after execute_command with background=true, or after a foreground command that timed out (returns timed_out: true with terminal_id). Check on progress, read accumulated output, and see if the command has finished. Supports the same output filtering parameters as execute_command.\n\nUse kill=true to send Ctrl+C (SIGINT) to the running command and return captured output.",
  },
  close_terminals: {
    label: "Clean up terminals",
    description:
      "Close managed terminals to clean up clutter. With no arguments, closes all terminals created by agentlink. Pass specific names to close only those (e.g. ['Server'] to close a background dev server terminal).",
  },
  open_file: {
    label: "Open in editor",
    description:
      "Open a file in the VS Code editor, optionally scrolling to a specific line and column. Supports range selection to highlight code.",
  },
  show_notification: {
    label: "VS Code notification",
    description:
      "Show a notification message in VS Code. Use sparingly \u2014 best for important status updates or completion of long-running tasks.",
  },
  codebase_search: {
    label: "Semantic code search",
    description:
      'Search the codebase by meaning, not exact text. Uses a Qdrant vector index to find code semantically similar to your natural language query. Best for exploratory questions like "how does authentication work" or "where are database connections configured". Falls back gracefully with a helpful error if the index is not available.',
  },

  // --- Dev-only tools ---

  send_feedback: {
    label: "Submit tool feedback",
    devOnly: true,
    description:
      "Submit feedback about a agentlink tool \u2014 report issues, suggest improvements, or note missing features/parameters. Feedback is stored locally for the extension developer to review.",
  },
  get_feedback: {
    label: "Read tool feedback",
    devOnly: true,
    description:
      "Read all previously submitted feedback about agentlink tools. Optionally filter by tool name.",
  },
  delete_feedback: {
    label: "Delete feedback entries",
    devOnly: true,
    description:
      "Delete specific feedback entries by their 0-based index (as returned by get_feedback). Use after addressing feedback to keep the list clean.",
  },
};

/** All tool names (non-dev) */
export const TOOL_NAMES = new Set(
  Object.entries(TOOL_REGISTRY)
    .filter(([, t]) => !t.devOnly)
    .map(([name]) => name),
);

/** Dev-only tool names */
export const DEV_TOOL_NAMES = new Set(
  Object.entries(TOOL_REGISTRY)
    .filter(([, t]) => t.devOnly)
    .map(([name]) => name),
);
