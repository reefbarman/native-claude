import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";

export interface SkillEntry {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md file — passed to the model so it can load_skill it */
  skillPath: string;
}

interface RawSkill extends SkillEntry {
  /** Mode slugs this skill is restricted to. Undefined = available in all modes. */
  modeSlugs?: string[];
}

/** Parse YAML frontmatter key-value pairs. Returns {} if no frontmatter block present. */
function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  const fm: Record<string, string> = {};
  for (const line of content.slice(3, end).trim().split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fm;
}

function parseModeSlugs(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const slugs = value.split(/[\s,]+/).filter(Boolean);
  return slugs.length > 0 ? slugs : undefined;
}

/**
 * Scan a skills directory for sub-directories containing a SKILL.md.
 * Returns a map of skill name → RawSkill. Only the frontmatter is read, not the body.
 */
async function scanSkillsDir(dir: string): Promise<Map<string, RawSkill>> {
  const result = new Map<string, RawSkill>();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(dir, entry.name, "SKILL.md");
      try {
        const raw = await fs.readFile(skillMd, "utf-8");
        const fm = parseFrontmatter(raw);
        const name = fm.name ?? entry.name;
        const description = fm.description ?? "";
        const modeSlugs = parseModeSlugs(fm.modeSlugs);
        result.set(name, { name, description, skillPath: skillMd, modeSlugs });
      } catch {
        // SKILL.md missing or unreadable — skip
      }
    }
  } catch {
    // Directory doesn't exist — skip
  }
  return result;
}

/**
 * Discover and load all skills visible to the current mode.
 *
 * Sources in ascending priority (later entries win on name collision):
 *   1. ~/.agents/skills/                  — global cross-agent (lowest)
 *   2. ~/.agents/skills-{mode}/           — global cross-agent, mode-specific
 *   3. ~/.claude/skills/                  — global Claude Code
 *   4. ~/.claude/skills-{mode}/           — global Claude Code, mode-specific
 *   5. ~/.agentlink/skills/               — global agentlink
 *   6. ~/.agentlink/skills-{mode}/        — global agentlink, mode-specific
 *   7. <cwd>/.agents/skills/              — project cross-agent
 *   8. <cwd>/.agents/skills-{mode}/       — project cross-agent, mode-specific
 *   9. <cwd>/.claude/skills/              — project Claude Code
 *  10. <cwd>/.claude/skills-{mode}/       — project Claude Code, mode-specific
 *  11. <cwd>/.agentlink/skills/           — project agentlink
 *  12. <cwd>/.agentlink/skills-{mode}/    — project agentlink, mode-specific (highest)
 *
 * Skills that declare `modeSlugs` in their SKILL.md frontmatter are only included
 * when the current mode slug appears in that list.
 */
export async function loadSkills(
  cwd: string,
  modeSlug: string,
): Promise<SkillEntry[]> {
  const home = os.homedir();

  const sources = [
    path.join(home, ".agents", "skills"),
    path.join(home, ".agents", `skills-${modeSlug}`),
    path.join(home, ".claude", "skills"),
    path.join(home, ".claude", `skills-${modeSlug}`),
    path.join(home, ".agentlink", "skills"),
    path.join(home, ".agentlink", `skills-${modeSlug}`),
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".agents", `skills-${modeSlug}`),
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".claude", `skills-${modeSlug}`),
    path.join(cwd, ".agentlink", "skills"),
    path.join(cwd, ".agentlink", `skills-${modeSlug}`),
  ];

  // Merge in priority order — later sources win on name collision
  const merged = new Map<string, RawSkill>();
  for (const dir of sources) {
    const entries = await scanSkillsDir(dir);
    for (const [name, skill] of entries) {
      merged.set(name, skill);
    }
  }

  return Array.from(merged.values())
    .filter((s) => !s.modeSlugs || s.modeSlugs.includes(modeSlug))
    .map(({ name, description, skillPath }) => ({
      name,
      description,
      skillPath,
    }));
}
