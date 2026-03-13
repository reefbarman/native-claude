## Workspace handshake — REQUIRED FIRST STEP

Before using any other agentlink tool, you **MUST** call the `handshake` tool to establish a trusted connection. This verifies you are connected to the correct VS Code instance.

**Call it immediately** at the start of every session:
```
handshake({ working_directories: ["<your primary working directory>", "<additional dir 1>", ...] })
```

Pass **all** your known working directories (primary + additional). The server checks that its workspace folders are present in your list. On success you get `{ status: "trusted" }` and all other tools become available.

If the handshake keeps failing, you are likely connected to the wrong MCP server instance. Ask the user to reload the VS Code window or refresh their AI agent's MCP connections.

## Prefer AgentLink MCP tools only when running inside VS Code

First determine whether you are running inside VS Code.

- If you **are** running inside VS Code and the `agentlink` MCP server is available, prefer its tools over built-in equivalents.
- If you are **not** running inside VS Code (for example, a Claude CLI / terminal app session), **do NOT attempt to use agentlink MCP tools** and do **not** tell the user they must connect AgentLink. Use the tools available in your current environment instead.

When the `agentlink` MCP server is available inside VS Code, prefer its tools over built-in equivalents. AgentLink tools work through VS Code directly, providing diff views, integrated terminal, real diagnostics, and language server intelligence.

### Tool mappings

If your agent has built-in filesystem tools, prefer the agentlink equivalents:

| Built-in            | AgentLink equivalent        | Why                                                                                                                                          |
| ------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| File read           | `read_file`                 | Returns line numbers, file metadata, git status, and diagnostics summary                                                                     |
| File edit/write     | `apply_diff` / `write_file` | Opens a diff view for user review. Format-on-save applies automatically. Returns user edits and diagnostics.                                 |
| Shell/terminal      | `execute_command`           | Runs in VS Code's integrated terminal (visible to user). Captures output via shell integration. Supports named terminals for parallel tasks. |
| File search/glob    | `list_files`                | Lists files with optional recursive + depth control                                                                                          |
| Content search/grep | `search_files`              | Ripgrep-powered search with context lines.                                                                                                   |

### Terminal behavior

`execute_command` automatically reuses an existing idle terminal. You do NOT need to pass `terminal_name` or `terminal_id` for normal sequential commands — just omit both and the tool will reuse the default terminal.

- **DO NOT** pass `terminal_name` unless you specifically need a *separate* terminal (e.g. a long-running dev server alongside normal commands, or truly parallel tasks).
- `terminal_id` is only needed if a previous background command returned one and you need to interact with that specific terminal.
- Use `background: true` for long-running processes (dev servers, watch modes). Returns immediately with `terminal_id`. Use `get_terminal_output` with the `terminal_id` to check on progress.
- Use `split_from` with a `terminal_id` or `terminal_name` to create a new terminal split alongside an existing one.
- After a session, use `close_terminals` to clean up any stale terminals.
- Always use non-interactive flags where available (e.g. `--yes`, `-y`, `--no-input`) as interactive commands are automatically rejected.
- **Always set a `timeout`** for commands you expect to complete quickly (e.g. git, ls, npm test — use 10-30s). Only omit timeout for long-running processes.

### File editing notes

- After writing files, check the response for `diagnostics` and `user_edits`.
- If `user_edits` is present, the user modified your proposed changes — read the patch to understand what they changed.
- Use `get_diagnostics` for real VS Code errors/warnings from language services.

### Additional tools

AgentLink also provides language server tools with no built-in equivalent. Use these proactively — they give you real language server intelligence instead of guessing from source text.

- **`handshake`** — Establish a trusted connection by verifying workspace identity. Must be called before any other tool.
- **`go_to_definition`** — Jump to where a symbol is defined. Takes a file, line, and column.
- **`go_to_implementation`** — Find concrete implementations of an interface, abstract class, or method.
- **`go_to_type_definition`** — Navigate to the type definition of a symbol.
- **`get_references`** — Find all usages of a symbol across the workspace.
- **`get_symbols`** — Get document symbol outline (pass `path`) or search workspace symbols (pass `query`).
- **`get_hover`** — Get inferred types and documentation for a symbol at a position.
- **`get_completions`** — Get autocomplete suggestions at a cursor position.
- **`get_code_actions`** + **`apply_code_action`** — Get available quick fixes and refactorings, then apply one by index.
- **`get_call_hierarchy`** — Get incoming callers and/or outgoing callees for a function.
- **`get_type_hierarchy`** — Get supertypes and subtypes of a type.
- **`get_inlay_hints`** — Get inferred type annotations and parameter names for a range of lines.
- **`get_diagnostics`** — Get real VS Code diagnostics (errors, warnings) for a file or the whole workspace.
- **`rename_symbol`** — Rename a symbol across the entire workspace using the language server.
- **`open_file`** — Open a file in the VS Code editor, optionally scrolling to a specific line.
- **`show_notification`** — Show a notification in VS Code. Use sparingly.
- **`find_and_replace`** — Bulk find-and-replace across multiple files using a glob pattern.
- **`get_terminal_output`** — Check on a background command started with `execute_command` + `background: true`.
