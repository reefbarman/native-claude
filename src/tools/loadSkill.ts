import * as fs from "fs/promises";
import * as path from "path";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolResult } from "../shared/types.js";
import { resolveAndValidatePath } from "../util/paths.js";

interface AllowedSkill {
  name: string;
  skillPath: string;
}

function errorResult(message: string, skillPath?: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: message,
          ...(skillPath ? { path: skillPath } : {}),
        }),
      },
    ],
  };
}

export async function handleLoadSkill(
  params: {
    path: string;
  },
  _approvalManager: ApprovalManager,
  _approvalPanel: ApprovalPanelProvider,
  _sessionId: string,
  advertisedSkills: AllowedSkill[] = [],
): Promise<ToolResult> {
  try {
    const { absolutePath } = resolveAndValidatePath(params.path);
    const allowed = advertisedSkills.find((skill) => {
      try {
        return path.normalize(skill.skillPath) === path.normalize(absolutePath);
      } catch {
        return false;
      }
    });

    if (!allowed) {
      return errorResult(
        "Skill path is not in the current session's advertised skill allowlist",
        params.path,
      );
    }

    const raw = await fs.readFile(absolutePath, "utf-8");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              skill_name: allowed.name,
              path: absolutePath,
              content: raw,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(message, params.path);
  }
}
