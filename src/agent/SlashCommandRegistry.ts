import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";

export interface SlashCommand {
  name: string;
  description: string;
  source: "builtin" | "project" | "global" | "agentlink";
  /** True if this is a built-in that executes immediately (not a prompt template) */
  builtin: boolean;
  /** Body to inject into the input when selected (for file-based commands) */
  body?: string;
}

/** Parse YAML frontmatter from a markdown file. Returns `{}` if not present. */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const fmLines = content.slice(3, end).trim().split("\n");
  const frontmatter: Record<string, string> = {};
  for (const line of fmLines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    frontmatter[key] = value;
  }
  return { frontmatter, body: content.slice(end + 4).trim() };
}

/**
 * Load slash commands from a directory of .md files.
 * Each file becomes a command named after its basename (without extension).
 */
async function loadCommandsFromDir(
  dir: string,
  source: SlashCommand["source"],
  prefix = "",
): Promise<SlashCommand[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const commands: SlashCommand[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Recurse: subdirectory "foo" gives prefix "foo:"
        const sub = await loadCommandsFromDir(
          path.join(dir, entry.name),
          source,
          prefix ? `${prefix}:${entry.name}` : entry.name,
        );
        commands.push(...sub);
      } else if (entry.name.endsWith(".md")) {
        const base = entry.name.slice(0, -3);
        const name = prefix ? `${prefix}:${base}` : base;
        try {
          const raw = await fs.readFile(path.join(dir, entry.name), "utf-8");
          const { frontmatter, body } = parseFrontmatter(raw);
          commands.push({
            name,
            description: frontmatter.description ?? `Run /${name}`,
            source,
            builtin: false,
            body,
          });
        } catch {
          // skip unreadable files
        }
      }
    }

    return commands;
  } catch {
    return [];
  }
}

/** Built-in slash commands. */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "new",
    description: "Start a new chat session",
    source: "builtin",
    builtin: true,
  },

  {
    name: "mode",
    description: "Switch mode: /mode <slug>",
    source: "builtin",
    builtin: true,
  },
  {
    name: "model",
    description: "Switch model: /model <name>",
    source: "builtin",
    builtin: true,
  },
  {
    name: "condense",
    description: "Condense conversation context",
    source: "builtin",
    builtin: true,
  },
  {
    name: "checkpoint",
    description: "Create a workspace checkpoint",
    source: "builtin",
    builtin: true,
  },
  {
    name: "revert",
    description: "Revert to the latest checkpoint or /revert <checkpoint-id>",
    source: "builtin",
    builtin: true,
  },
  {
    name: "help",
    description: "Show available slash commands",
    source: "builtin",
    builtin: true,
  },
  {
    name: "mcp",
    description: "Show MCP server connection status",
    source: "builtin",
    builtin: true,
  },
  {
    name: "mcp-config",
    description: "Open MCP server config (project or global)",
    source: "builtin",
    builtin: true,
  },
  {
    name: "mcp-refresh",
    description: "Reconnect all MCP servers",
    source: "builtin",
    builtin: true,
  },
  {
    name: "btw",
    description: "Ask a quick side question: /btw <question>",
    source: "builtin",
    builtin: true,
  },
];

export class SlashCommandRegistry {
  private commands: SlashCommand[] = [...BUILTIN_COMMANDS];
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Load all user-defined commands from disk. Call on startup and on file changes.
   *
   * Priority (later entries override earlier for the same command name):
   *   .agents → .claude → .agentlink, global → project
   */
  async reload(): Promise<void> {
    const home = os.homedir();
    const cwd = this.cwd;

    // Load all sources in ascending priority order
    const sources = await Promise.all([
      // Global .agents (lowest)
      loadCommandsFromDir(path.join(home, ".agents", "commands"), "global"),
      // Global .claude
      loadCommandsFromDir(path.join(home, ".claude", "commands"), "global"),
      // Global .agentlink
      loadCommandsFromDir(path.join(home, ".agentlink", "commands"), "global"),
      // Project .agents
      loadCommandsFromDir(path.join(cwd, ".agents", "commands"), "project"),
      // Project .claude
      loadCommandsFromDir(path.join(cwd, ".claude", "commands"), "project"),
      // Project .agentlink (highest)
      loadCommandsFromDir(
        path.join(cwd, ".agentlink", "commands"),
        "agentlink",
      ),
    ]);

    // Build deduplicated list — later sources override earlier for same name
    const byName = new Map<string, SlashCommand>();
    for (const cmds of sources) {
      for (const cmd of cmds) {
        byName.set(cmd.name, cmd);
      }
    }

    this.commands = [...BUILTIN_COMMANDS, ...Array.from(byName.values())];
  }

  getAll(): SlashCommand[] {
    return this.commands;
  }

  /** Filter commands matching a prefix query (case-insensitive). */
  search(query: string): SlashCommand[] {
    const lower = query.toLowerCase();
    return this.commands.filter((c) => c.name.toLowerCase().startsWith(lower));
  }
}
