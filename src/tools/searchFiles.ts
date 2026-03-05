import * as path from "path";

import {
  resolveAndValidatePath,
  tryGetFirstWorkspaceRoot,
} from "../util/paths.js";
import {
  getRipgrepBinPath,
  execRipgrepSearch,
  parseRipgrepOutput,
} from "../util/ripgrep.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";

const DEFAULT_MAX_RESULTS = 300;

import { type ToolResult } from "../shared/types.js";

/**
 * Fix common regex escaping mistakes that Claude makes.
 *
 * Claude often double-escapes regex patterns due to JSON string escaping
 * confusion. For example, it sends `\\s` (literal backslash + s) when it
 * means `\s` (whitespace metacharacter). This function collapses the most
 * common double-escaped sequences back to single-escaped form.
 *
 * Also strips `\"` which is not a valid ripgrep escape.
 */
export function sanitizeRegex(regex: string): string {
  // Collapse \\X → \X for known regex metacharacters and escape sequences.
  // Covers: \s \S \d \D \w \W \b \B \n \t \r \f and punctuation escapes
  // like \( \) \{ \} \[ \] \. \| \+ \* \? \^ \$ \/
  return regex
    .replace(/\\\\([sSdDwWbBntrf(){}[\].|+*?^$/])/g, "\\$1")
    .replace(/\\["/]/g, (m) => m[1]);
}

/**
 * Check if a regex pattern appears to be double-escaped and return a hint.
 */
/**
 * Check if a sanitized regex requires multiline mode (contains \n).
 */
export function needsMultiline(sanitizedRegex: string): boolean {
  // After sanitization, a literal \n in the regex means the agent wants to match newlines.
  // We look for the two-character sequence backslash + 'n' not preceded by another backslash.
  return /(?<!\\)\\n/.test(sanitizedRegex);
}

export function getEscapingHint(regex: string): string | undefined {
  // Look for patterns like \\s, \\d, \\(, \\{ that suggest double-escaping
  if (/\\\\[sSdDwWbBntrf(){}[\].|+*?^$/]/.test(regex)) {
    return (
      "Your regex appears double-escaped (e.g. \\\\s instead of \\s). " +
      "The regex parameter is passed directly to ripgrep — only single " +
      "backslash escapes are needed (e.g. \\s, \\d, \\(). JSON string " +
      "escaping is handled automatically by the transport layer."
    );
  }
  return undefined;
}

export async function handleSearchFiles(
  params: {
    path: string;
    regex: string;
    file_pattern?: string;
    semantic?: boolean;
    context?: number;
    context_before?: number;
    context_after?: number;
    case_insensitive?: boolean;
    multiline?: boolean;
    max_results?: number;
    offset?: number;
    output_mode?: string;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { absolutePath: dirPath, inWorkspace } = resolveAndValidatePath(
      params.path,
    );

    // Outside-workspace gate
    if (!inWorkspace && !approvalManager.isPathTrusted(sessionId, dirPath)) {
      const { approved, reason } = await approveOutsideWorkspaceAccess(
        dirPath,
        approvalManager,
        approvalPanel,
        sessionId,
      );
      if (!approved) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected",
                path: params.path,
                ...(reason && { reason }),
              }),
            },
          ],
        };
      }
    }

    // Semantic search is handled separately
    if (params.semantic) {
      const { semanticSearch } = await import("../services/semanticSearch.js");
      return semanticSearch(dirPath, params.regex, params.max_results);
    }

    const maxResults = params.max_results ?? DEFAULT_MAX_RESULTS;
    const outputMode = params.output_mode ?? "content";

    // Ripgrep regex search
    const rgPath = await getRipgrepBinPath();
    const cwd = tryGetFirstWorkspaceRoot() ?? path.resolve(".");

    // --- files_with_matches mode ---
    if (outputMode === "files_with_matches") {
      return await searchFilesOnly(rgPath, dirPath, params);
    }

    // --- count mode ---
    if (outputMode === "count") {
      return await searchCount(rgPath, dirPath, params);
    }

    // --- content mode (default) ---
    const contextBefore = params.context_before ?? params.context ?? 1;
    const contextAfter = params.context_after ?? params.context ?? 1;
    const offset = params.offset ?? 0;
    const sanitized = sanitizeRegex(params.regex);
    const args = ["--json", "-e", sanitized, "--no-messages"];

    // Use asymmetric -B/-A when they differ, symmetric -C when equal
    if (contextBefore === contextAfter) {
      args.push("--context", String(contextBefore));
    } else {
      args.push("-B", String(contextBefore), "-A", String(contextAfter));
    }

    if (params.case_insensitive) {
      args.push("--ignore-case");
    }
    if (params.multiline || needsMultiline(sanitized)) {
      args.push("--multiline", "--multiline-dotall");
    }

    // Only add --glob if a specific file pattern is provided
    // Using --glob "*" overrides .gitignore behavior
    if (params.file_pattern) {
      args.push("--glob", params.file_pattern);
    }

    args.push(dirPath);

    let output: string;
    try {
      output = await execRipgrepSearch(rgPath, args);
    } catch (error) {
      // Ripgrep error — may be invalid regex syntax etc.
      const message = error instanceof Error ? error.message : String(error);
      const hint = getEscapingHint(params.regex);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: message,
              regex: params.regex,
              ...(hint && { hint }),
            }),
          },
        ],
      };
    }

    if (!output.trim()) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              total_matches: 0,
              truncated: false,
              results: "No results found",
            }),
          },
        ],
      };
    }

    const { results: fileResults, totalMatches } = parseRipgrepOutput(
      output,
      cwd,
    );

    // Format output — keep ## file.ts + "> linenum | content" format
    const formatted: string[] = [];
    let matchCount = 0;
    let skipped = 0;

    for (const file of fileResults) {
      if (matchCount >= maxResults) break;

      const relPath = path.relative(dirPath, file.file);
      const fileLines: string[] = [];
      let fileMatchCount = 0;

      for (const result of file.searchResults) {
        if (matchCount >= maxResults) break;

        const groupMatches = result.lines.filter((l) => l.isMatch).length;

        // Skip this group entirely if all its matches fall within the offset
        if (offset > 0 && skipped + groupMatches <= offset) {
          skipped += groupMatches;
          continue;
        }

        for (const line of result.lines) {
          const prefix = line.isMatch ? ">" : " ";
          fileLines.push(`${prefix} ${line.line} | ${line.text.trimEnd()}`);
        }
        fileLines.push("---");

        // Count only the matches past the offset threshold
        const countable = Math.max(
          0,
          groupMatches - Math.max(0, offset - skipped),
        );
        fileMatchCount += countable;
        matchCount += countable;
        skipped += groupMatches;
      }

      if (fileLines.length > 0) {
        const countLabel =
          fileMatchCount === 1 ? "1 match" : `${fileMatchCount} matches`;
        formatted.push(
          `## ${relPath} (${countLabel})\n${fileLines.join("\n")}`,
        );
      }
    }

    const result = {
      total_matches: Math.min(totalMatches, maxResults),
      truncated: totalMatches > maxResults + offset,
      ...(offset > 0 && { offset }),
      results: formatted.join("\n\n"),
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message, path: params.path }),
        },
      ],
    };
  }
}

// --- files_with_matches mode ---

async function searchFilesOnly(
  rgPath: string,
  dirPath: string,
  params: {
    regex: string;
    file_pattern?: string;
    case_insensitive?: boolean;
    multiline?: boolean;
    max_results?: number;
    offset?: number;
  },
): Promise<ToolResult> {
  const sanitized = sanitizeRegex(params.regex);
  const args = ["--files-with-matches", "-e", sanitized, "--no-messages"];

  if (params.case_insensitive) args.push("--ignore-case");
  if (params.multiline || needsMultiline(sanitized))
    args.push("--multiline", "--multiline-dotall");
  if (params.file_pattern) args.push("--glob", params.file_pattern);
  args.push(dirPath);

  let output: string;
  try {
    output = await execRipgrepSearch(rgPath, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = getEscapingHint(params.regex);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: message,
            regex: params.regex,
            ...(hint && { hint }),
          }),
        },
      ],
    };
  }

  const files = output.trim().split("\n").filter(Boolean);
  const maxResults = params.max_results ?? DEFAULT_MAX_RESULTS;
  const offsetVal = params.offset ?? 0;
  const sliced = files.slice(offsetVal, offsetVal + maxResults);
  const limited = sliced.map((f) => path.relative(dirPath, f));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            total_files: limited.length,
            truncated: files.length > offsetVal + maxResults,
            ...(offsetVal > 0 && { offset: offsetVal }),
            files: limited,
          },
          null,
          2,
        ),
      },
    ],
  };
}

// --- count mode ---

async function searchCount(
  rgPath: string,
  dirPath: string,
  params: {
    regex: string;
    file_pattern?: string;
    case_insensitive?: boolean;
    multiline?: boolean;
    max_results?: number;
    offset?: number;
  },
): Promise<ToolResult> {
  const sanitized = sanitizeRegex(params.regex);
  const args = ["--count", "-e", sanitized, "--no-messages"];

  if (params.case_insensitive) args.push("--ignore-case");
  if (params.multiline || needsMultiline(sanitized))
    args.push("--multiline", "--multiline-dotall");
  if (params.file_pattern) args.push("--glob", params.file_pattern);
  args.push(dirPath);

  let output: string;
  try {
    output = await execRipgrepSearch(rgPath, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = getEscapingHint(params.regex);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: message,
            regex: params.regex,
            ...(hint && { hint }),
          }),
        },
      ],
    };
  }

  const lines = output.trim().split("\n").filter(Boolean);
  const maxResults = params.max_results ?? DEFAULT_MAX_RESULTS;
  const offsetVal = params.offset ?? 0;
  let totalMatches = 0;
  const allCounts: Array<{ file: string; count: number }> = [];

  for (const line of lines) {
    const sepIdx = line.lastIndexOf(":");
    if (sepIdx === -1) continue;
    const file = path.relative(dirPath, line.substring(0, sepIdx));
    const count = parseInt(line.substring(sepIdx + 1), 10);
    if (!isNaN(count)) {
      allCounts.push({ file, count });
      totalMatches += count;
    }
  }

  const sliced = allCounts.slice(offsetVal, offsetVal + maxResults);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            total_files: sliced.length,
            total_matches: totalMatches,
            truncated: allCounts.length > offsetVal + maxResults,
            ...(offsetVal > 0 && { offset: offsetVal }),
            counts: sliced,
          },
          null,
          2,
        ),
      },
    ],
  };
}
