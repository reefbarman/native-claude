## Workspace handshake — REQUIRED FIRST STEP

Before using any other agentlink tool, you **MUST** call the `handshake` tool to establish a trusted connection. This verifies you are connected to the correct VS Code instance.

**Call it immediately** at the start of every session:
```
handshake({ working_directories: ["<your primary working directory>", "<additional dir 1>", ...] })
```

Pass **all** your known working directories (primary + additional). The server checks that its workspace folders are present in your list. On success you get `{ status: "trusted" }` and all other tools become available. On failure you get `{ status: "rejected" }`.

If the handshake keeps failing, you are likely connected to the wrong MCP server instance. Tell the user to reload the VS Code window or refresh their AI agent's MCP connections.

## MANDATORY: Use agentlink MCP tools only when running inside VS Code

**Environment check**: First determine whether you are running inside VS Code. You should only use `agentlink` MCP tools when they are actually available in your tool list.

- If you **are** running inside VS Code and the `agentlink` MCP server is connected, follow all AgentLink MCP rules below.
- If you are **not** running inside VS Code (for example, a Claude CLI / terminal app session), **do NOT attempt to use agentlink MCP tools** and do **not** tell the user they must connect AgentLink. In that case, use the tools available in your current environment instead.

**STOP CHECK for VS Code sessions**: Before doing ANY work inside VS Code, verify that the `agentlink` MCP server is connected by confirming you have access to its tools (e.g. `read_file`, `execute_command`, `apply_diff`). If this is supposed to be a VS Code session and agentlink tools are NOT available in your tool list, **STOP IMMEDIATELY** and tell the user:

> "The agentlink MCP server is not connected. I cannot proceed with VS Code actions until it is available. Please check that the AgentLink extension is running and reload the MCP connection."

**Do NOT fall back to built-in tools** in a VS Code session with AgentLink available. Do NOT silently continue with `Read`, `Edit`, `Write`, `Bash`, `Glob`, or `Grep`. Wait for the user to fix the connection.

When the `agentlink` MCP server is available inside VS Code, NEVER use built-in `Read`, `Edit`, `Write`, `Bash`, `Glob`, or `Grep` tools. ALWAYS use the agentlink MCP equivalents instead:

- `Read` → `read_file`
- `Edit` / `Write` → `apply_diff` / `write_file`
- `Bash` → `execute_command`
- `Glob` → `list_files`
- `Grep` → `search_files`

These MCP tools open diff views for user review, run commands in visible terminals, and return VS Code diagnostics.

**Exception — non-text files:** The built-in `Read` tool may be used for file types that `read_file` cannot handle: **images** (PNG, JPG, GIF, etc. — Claude is multimodal), **PDFs** (with the `pages` parameter), and **Jupyter notebooks** (`.ipynb` — rendered with cells + outputs). A PreToolUse hook enforces this automatically.

### Regex escaping — IMPORTANT

The `search_files` `regex` parameter is passed directly to ripgrep. Use **single** backslash escapes (`\s`, `\d`, `\(`). Do NOT double-escape — `\\s` in the JSON string value is correct for matching whitespace. Common mistake: sending `\\\\s` (which ripgrep sees as literal backslash + `s`) instead of `\\s` (which ripgrep sees as `\s` = whitespace). The same applies to `\d`, `\w`, `\b`, `\n`, `\(`, `\{`, etc.

### Common mistakes — DO NOT DO THESE

These are the most frequent violations. Check yourself before every tool call:

- **DO NOT use `Bash` to run builds, tests, git commands, or any shell command.** Use `execute_command`. If `execute_command` fails (e.g. parameter validation error), fix the parameters and retry — do NOT fall back to `Bash`.
- **DO NOT use `Grep` to search code.** Use `search_files`. If you need to search the workspace root, pass `path: "."`.
- **DO NOT use `Read` to read files.** Use `read_file`. **Exception:** built-in `Read` is allowed for images, PDFs, and Jupyter notebooks (file types `read_file` cannot handle).
- **DO NOT use `Edit` or `Write` to modify files.** Use `apply_diff`, `write_file`, or `find_and_replace`. The built-in `Edit` tool's `replace_all` feature is NOT a reason to use it — use `find_and_replace` instead.
- **DO NOT use `Glob` to find files.** Use `list_files`.
- **DO NOT fall back to built-in tools when a agentlink tool returns an error.** Fix the issue (wrong parameter type, missing required param, etc.) and retry with the agentlink tool.

### Tool details

| Instead of (built-in) | Use (agentlink MCP)         | Why                                                                                                                                          |
| --------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Read`                | `read_file`                 | Returns line numbers, file metadata, git status, and diagnostics summary. Supports `query` param for semantic offset.                        |
| `Edit` / `Write`      | `apply_diff` / `write_file` | Opens a diff view for user review. Format-on-save applies automatically. Returns user edits and diagnostics.                                 |
| `Bash`                | `execute_command`           | Runs in VS Code's integrated terminal (visible to user). Captures output via shell integration. Supports named terminals for parallel tasks. |
| `Glob`                | `list_files`                | Lists files with optional recursive + depth control. Supports `query` param for semantic file discovery.                                     |
| `Grep`                | `search_files`              | Ripgrep-powered search with context lines.                                                                                                   |

### Terminal behavior — IMPORTANT

`execute_command` automatically reuses an existing idle terminal. You do NOT need to pass `terminal_name` or `terminal_id` for normal sequential commands — just omit both and the tool will reuse the default terminal.

- **Working directory**: The response includes a `cwd` field showing the terminal's actual working directory after the command finished. This reflects any `cd` commands — do NOT run `pwd`, just read `cwd` from the response. The `cwd` parameter only applies when creating a new terminal; on reused terminals it is ignored. If `cwd` is absent from the response, shell integration was unavailable and the directory is unknown.
- **DO NOT** pass `terminal_name` unless you specifically need a *separate* terminal (e.g. a long-running dev server alongside normal commands, or truly parallel tasks).
- **DO NOT** invent terminal names like "Build", "Git", "Lint" for one-off commands — this creates unnecessary terminals that clutter the user's workspace.
- `terminal_id` is only needed if a previous background command returned one and you need to interact with that specific terminal.
- Use `background: true` for long-running processes (dev servers, watch modes). Returns immediately with `terminal_id`. Use `get_terminal_output` with the `terminal_id` to check on progress, read accumulated output, and see if the command has finished. Background terminals are never auto-reused — always use `terminal_name` or `terminal_id` to target them.
- Use `split_from` with a `terminal_id` or `terminal_name` to create a new terminal split alongside an existing one, forming a visual group in VS Code's terminal panel. Only affects new terminal creation — if the target `terminal_name` already exists and is idle, it is reused without re-splitting. Example: start a backend server with `terminal_name='Backend'`, then use `split_from='Backend'` with `terminal_name='Frontend'` to group them side-by-side.
- After a session, use `close_terminals` to clean up any stale terminals.
- `execute_command` runs in a real PTY terminal. Known interactive commands (editors, TUI apps, bare REPLs, scaffolders without `--yes`, git `-i`/`-p` flags, etc.) are **automatically rejected** with a helpful suggestion. Still, always use non-interactive flags where available (e.g. `--yes`, `-y`, `--no-input`, `--non-interactive`, `CI=true`) for commands the validator may not catch.
- **Always set a `timeout`** for commands you expect to complete quickly (e.g. git, ls, npm test — use 10-30s). This prevents the session from hanging if a command unexpectedly blocks. Only omit timeout for long-running processes (dev servers, watch modes) where you want to wait indefinitely.
- **`reason` parameter** — Always provide a short `reason` string explaining **why** you need to run this command. It's shown to the user in the approval dialog to help them decide quickly (e.g. `reason: "Check if tests pass after the refactor"`). Keep it to one sentence.
- **`force` parameter** — Commands using `grep`, `cat`, `head`, `tail`, or `sed` are auto-rejected with a suggestion to use the equivalent agentlink tool. Two categories of rejections exist:
  - **Direct file commands** (e.g. `grep pattern file.txt`, `cat file.txt`) — can be bypassed with `force: true` + `force_reason` when the rejection is a false positive (e.g. shell expansion like `$(...)` or env vars). You MUST provide `force_reason` explaining why.
  - **Piped filtering** (e.g. `cmd | grep pattern`, `cmd | tail -5`) — **NEVER bypassable**, even with `force: true`. Use `output_grep`, `output_head`, `output_tail` parameters instead. Do NOT retry with force.
- **`output_file` — CRITICAL** — If the response contains `output_file`, the output was **truncated** and the full output was saved to that path. Call `read_file(output_file)` to access the rest. **NEVER re-run the command** to see more output or to search it with different `output_grep` patterns — this is a costly anti-pattern that wastes time. The temp file already contains the complete output; just read it (use `read_file` with `query` or `offset` to find what you need). If you need to search it, read the file and scan its contents — do not re-execute.

### File editing notes

- After writing files, check the response for `diagnostics` and `user_edits`.
- If `user_edits` is present, the user modified your proposed changes — read the patch to understand what they changed.
- Use `get_diagnostics` for real VS Code errors/warnings from language services.

### Semantic navigation — `query` param on `read_file` and `list_files`

When the codebase index is available, `read_file` and `list_files` both accept an optional `query` parameter for semantic navigation:

- **`read_file` with `query`** — Jumps to the most relevant section of a file. Instead of reading from line 1 or guessing an offset, pass a natural language query (e.g. `read_file("src/server.ts", query: "error handling middleware")`) and the tool auto-sets the offset to the best matching chunk. Ignored if `offset` is explicitly provided. The response includes a `semantic_match` field showing the matched line range.
- **`list_files` with `query`** — Finds files by meaning, not name. Pass a natural language query (e.g. `list_files("src/", query: "authentication")`) and get files ranked by semantic relevance. Other params (`recursive`, `depth`, `pattern`) are ignored when `query` is provided.

Use these to reduce context-gathering round-trips: `list_files` with `query` to find relevant files, then `read_file` with `query` to land on the right section.

### Search strategy — use `codebase_search` FIRST

When exploring code, understanding architecture, or investigating how something works, **always start with `codebase_search`** before falling back to `search_files` regex search. Semantic search finds conceptually related code even when you don't know the exact names, patterns, or file locations.

**Use `codebase_search` when:**

- Exploring unfamiliar code ("how does auth work?", "where are API routes?")
- You don't know exact function/variable/class names
- Looking for conceptual matches ("error handling", "database connections", "file uploads")
- Starting a new task and need to understand the relevant parts of the codebase
- The user asks a broad question about the codebase

**Use `search_files` (regex) when:**

- You know the exact symbol name, string literal, or pattern
- You need precise text matching (e.g. finding all imports of a specific module)
- You need to count occurrences or find-and-replace

**Combine both:** Start with `codebase_search` to discover relevant files and concepts, then use `search_files` for precise lookups within those files.

**Prefer `list_files` with `query` over `codebase_search` when:**

- You need to know *which files* are relevant, not see code snippets — e.g. "which files handle auth?" → `list_files("src/", query: "authentication")`
- You're planning edits and need a file list to work through
- You already know the directory to scope to

**Always use `read_file` with `query` when:**

- You know the file but not the exact line — e.g. `read_file("src/server.ts", query: "error handling")` instead of reading from line 1 and scrolling
- The file is large (>200 lines) and you need a specific section
- You're following up on a `codebase_search` or `list_files` result — pass the same query to `read_file` to land on the right spot

**Do NOT** read a file from line 1 and then search within it when a `query` param would find the section directly. The `query` param saves a round-trip.

### Additional tools (no built-in equivalent)

agentlink also provides tools that Claude Code doesn't have natively. Use these proactively — they give you real language server intelligence instead of guessing from source text.

- **`handshake`** — Establish a trusted connection by verifying workspace identity. Must be called before any other tool. Pass all your known working directories — the server validates that its workspace folders are present in your list.
- **`codebase_search`** — Search the codebase by meaning, not exact text. Uses a vector index for semantic similarity search. Pass a natural language `query` and optionally a `path` to scope to a directory. Use `exclude_globs` to suppress noisy indexed paths for a specific query (for example `**/dist/**` or other generated folders) without rebuilding the index. Best for exploratory questions. Requires the codebase index to be built (see Codebase Index in the sidebar).
- **`go_to_definition`** — Jump to where a symbol is defined. Takes a file, line, and column.
- **`go_to_implementation`** — Find concrete implementations of an interface, abstract class, or method. Unlike `go_to_definition` which shows the declaration, this shows where the code actually runs. Essential for interface-heavy codebases (TypeScript, Java, C#).
- **`go_to_type_definition`** — Navigate to the type definition of a symbol. For `const x = getFoo()`, `go_to_definition` goes to `getFoo`'s declaration, but `go_to_type_definition` goes to the return type. Useful for exploring API return types.
- **`get_references`** — Find all usages of a symbol across the workspace.
- **`get_symbols`** — Get document symbol outline (pass `path`) or search workspace symbols (pass `query`).
- **`get_hover`** — Get inferred types and documentation for a symbol at a position. Same info shown on editor hover.
- **`get_completions`** — Get autocomplete suggestions at a cursor position. Useful for discovering available methods, properties, and APIs.
- **`get_code_actions`** + **`apply_code_action`** — Get available quick fixes and refactorings at a position (add missing import, extract function, organize imports, fix lint errors, etc.), then apply one by index. **Use this instead of manually writing imports or refactoring code** — the language server knows the exact edits needed.
- **`get_call_hierarchy`** — Get incoming callers and/or outgoing callees for a function. Shows who calls this function (`incoming`), what it calls (`outgoing`), or `both`. Supports recursive depth (max 3) for exploring call chains.
- **`get_type_hierarchy`** — Get supertypes (parent classes/interfaces) and subtypes (child classes/implementations) of a type. Useful for understanding inheritance hierarchies.
- **`get_inlay_hints`** — Get inferred type annotations and parameter names for a range of lines. Shows the same inline hints VS Code displays in the editor. Pass `start_line`/`end_line` to scope the range.
- **`get_diagnostics`** — Get real VS Code diagnostics (errors, warnings) for a file or the whole workspace. Use after edits to check for problems without running a build. Filter by `severity` and/or `source` (e.g. `typescript`, `eslint`).
- **`rename_symbol`** — Rename a symbol across the entire workspace using the language server. Updates all references, imports, and re-exports.
- **`open_file`** — Open a file in the VS Code editor, optionally scrolling to a specific line. Supports range selection with `end_line`/`end_column` to highlight code.
- **`show_notification`** — Show a notification in VS Code. Use sparingly for important status updates.
- **`find_and_replace`** — Bulk find-and-replace across **multiple files** using a glob pattern (e.g. `src/**/*.ts`). Supports literal strings and regex with capture groups. Opens a rich preview panel showing each match in context with inline diffs — the user can toggle individual matches on/off before accepting. **For single-file edits, prefer `apply_diff`** — it provides better diff review and format-on-save. Only use `find_and_replace` on a single file when making many identical replacements (e.g. renaming a variable throughout a file).
- **`get_terminal_output`** — Check on a background or timed-out command. Pass the `terminal_id` returned by `execute_command`. Works for both `background: true` commands and foreground commands that timed out (indicated by `timed_out: true` in the response). Returns accumulated output, whether the command is still running, and the exit code when finished. Use `wait_seconds` to poll for new output (avoids needing two calls when a command was just started). Use `kill: true` to send Ctrl+C (SIGINT) and stop the command. Supports the same output filtering params as `execute_command` (`output_head`, `output_tail`, `output_grep`, etc.).
