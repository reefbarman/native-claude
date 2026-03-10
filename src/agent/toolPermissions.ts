import type { AgentMode } from "./modes.js";

/**
 * Static tool groups. The 'mcp' group is populated dynamically at runtime
 * from connected MCP servers.
 */
export const TOOL_GROUPS: Record<string, string[]> = {
  read: ["read_file", "list_files", "open_file"],
  edit: [
    "write_file",
    "apply_diff",
    "find_and_replace",
    "rename_symbol",
    "get_code_actions",
    "apply_code_action",
  ],
  command: ["execute_command", "get_terminal_output", "close_terminals"],
  language: [
    "get_diagnostics",
    "get_hover",
    "get_symbols",
    "get_references",
    "go_to_definition",
    "go_to_implementation",
    "go_to_type_definition",
    "get_completions",
    "get_call_hierarchy",
    "get_type_hierarchy",
    "get_inlay_hints",
  ],
  search: ["codebase_search", "search_files"],
  plan: ["write_file", "apply_diff", "execute_command", "get_terminal_output"],
  mcp: [], // populated dynamically from McpClientHub
};

/**
 * Get the flat set of allowed tool names for a given mode.
 * The optional mcpTools parameter injects dynamically discovered MCP server tools.
 */
export function getToolsForMode(
  mode: AgentMode,
  mcpTools: string[] = [],
): Set<string> {
  const groups: Record<string, string[]> = { ...TOOL_GROUPS, mcp: mcpTools };
  const allowed = new Set<string>();
  for (const group of mode.toolGroups) {
    for (const tool of groups[group] ?? []) {
      allowed.add(tool);
    }
  }
  return allowed;
}
