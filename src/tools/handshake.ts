import * as fs from "fs";
import * as path from "path";

import { getWorkspaceRoots } from "../util/paths.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

type LogFn = (msg: string) => void;

/**
 * Normalize a path for comparison: resolve to absolute, resolve symlinks, and
 * lowercase on Windows.
 */
function normalizePath(p: string): string {
  let resolved = path.resolve(p);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // Path doesn't exist — use the resolved form
  }
  if (process.platform === "win32") {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

export async function handleHandshake(
  params: { working_directories: string[] },
  markTrusted: () => void,
  log: LogFn,
  shortSessionId: string,
): Promise<ToolResult> {
  const workspaceRoots = getWorkspaceRoots();

  log(
    `Handshake attempt for session ${shortSessionId}: agent sent ${params.working_directories.length} directories`,
  );

  // No workspace folders → auto-approve
  if (workspaceRoots.length === 0) {
    markTrusted();
    log(
      `Handshake auto-approved for session ${shortSessionId}: no workspace folders to validate`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "trusted" }),
        },
      ],
    };
  }

  const normalizedAgentDirs = new Set(
    params.working_directories.map(normalizePath),
  );
  const normalizedRoots = workspaceRoots.map(normalizePath);

  const missingRoots = normalizedRoots.filter(
    (root) => !normalizedAgentDirs.has(root),
  );

  if (missingRoots.length === 0) {
    markTrusted();
    log(
      `Handshake succeeded for session ${shortSessionId}: all ${workspaceRoots.length} workspace folders matched`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "trusted" }),
        },
      ],
    };
  }

  // Rejection — log missing paths server-side only (never send to agent)
  log(
    `Handshake failed for session ${shortSessionId}: ${missingRoots.length} of ${workspaceRoots.length} workspace folders not found in agent's list. Missing: ${missingRoots.join(", ")}`,
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "rejected",
          missing_count: missingRoots.length,
        }),
      },
    ],
  };
}
