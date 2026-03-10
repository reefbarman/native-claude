import * as fs from "fs/promises";
import * as path from "path";

export interface AgentMode {
  slug: string;
  name: string;
  /** VS Code codicon name (without 'codicon-' prefix) */
  icon: string;
  roleDefinition?: string;
  toolGroups: string[];
  customInstructions?: string;
}

export const BUILT_IN_MODES: AgentMode[] = [
  {
    slug: "code",
    name: "Code",
    icon: "code",
    toolGroups: ["read", "edit", "command", "language", "search", "mcp"],
  },
  {
    slug: "architect",
    name: "Architect",
    icon: "organization",
    toolGroups: ["read", "language", "search", "mcp", "plan"],
  },
  {
    slug: "ask",
    name: "Ask",
    icon: "question",
    toolGroups: ["read", "search"],
  },
  {
    slug: "debug",
    name: "Debug",
    icon: "debug",
    toolGroups: ["read", "command", "language", "search", "mcp"],
  },
  {
    slug: "review",
    name: "Review",
    icon: "checklist",
    toolGroups: ["read", "language", "search"],
  },
];

/** Custom mode schema as stored in .agentlink/modes.json */
interface CustomModeJson {
  slug: string;
  name: string;
  icon?: string;
  roleDefinition?: string;
  toolGroups?: string[];
  customInstructions?: string;
}

/**
 * Load custom mode definitions from .agentlink/modes.json.
 * Returns an empty array if the file doesn't exist or is malformed.
 */
export async function loadCustomModes(cwd: string): Promise<AgentMode[]> {
  const filePath = path.join(cwd, ".agentlink", "modes.json");
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as CustomModeJson[];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (m): m is CustomModeJson =>
          typeof m?.slug === "string" && typeof m?.name === "string",
      )
      .map((m) => ({
        slug: m.slug,
        name: m.name,
        icon: m.icon ?? "symbol-misc",
        roleDefinition: m.roleDefinition,
        toolGroups: Array.isArray(m.toolGroups)
          ? m.toolGroups
          : ["read", "search"],
        customInstructions: m.customInstructions,
      }));
  } catch {
    return [];
  }
}

/**
 * Merge built-in and custom modes. Custom modes with the same slug as a
 * built-in replace the built-in (allows users to override descriptions/tools).
 */
export function getAllModes(customModes: AgentMode[] = []): AgentMode[] {
  const customSlugs = new Set(customModes.map((m) => m.slug));
  const builtIns = BUILT_IN_MODES.filter((m) => !customSlugs.has(m.slug));
  return [...builtIns, ...customModes];
}

/**
 * Look up a mode by slug. Falls back to the 'code' mode if not found.
 */
export function resolveMode(slug: string, allModes: AgentMode[]): AgentMode {
  return (
    allModes.find((m) => m.slug === slug) ??
    allModes.find((m) => m.slug === "code") ??
    BUILT_IN_MODES[0]
  );
}
