import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

import { resolveAndValidatePath, getRelativePath } from "../util/paths.js";
import {
  DiffViewProvider,
  withFileLock,
  snapshotDiagnostics,
} from "../integrations/DiffViewProvider.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { decisionToScope, saveWriteTrustRules } from "./writeApprovalUI.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

interface SearchReplaceBlock {
  search: string;
  replace: string;
  index: number;
}

const SEARCH_MARKER = "<<<<<<< SEARCH";
const DIVIDER_MARKER = "======= DIVIDER =======";
const REPLACE_MARKER = ">>>>>>> REPLACE";

// Legacy delimiter for backward compatibility
const LEGACY_DIVIDER = "=======";

// ── Unified diff support ───────────────────────────────────────────────────

/**
 * Detect whether a diff string is in unified diff format (--- / +++ / @@ headers).
 */
export function isUnifiedDiff(diff: string): boolean {
  return (
    /^---\s+\S/m.test(diff) &&
    /^\+\+\+\s+\S/m.test(diff) &&
    /^@@\s+[+-]/m.test(diff)
  );
}

/**
 * Parse a unified diff into SearchReplaceBlock[].
 *
 * Each @@ hunk becomes one block:
 * - Context lines (no prefix or space prefix) appear in both search and replace
 * - `-` lines appear only in search
 * - `+` lines appear only in replace
 * - File headers (`---`, `+++`) and `\ No newline at end of file` are skipped
 */
export function parseUnifiedDiff(diff: string): ParseResult {
  const lines = diff.split("\n");
  const blocks: SearchReplaceBlock[] = [];
  let blockIndex = 0;
  let i = 0;

  while (i < lines.length) {
    // Skip until we find a hunk header
    if (!lines[i].startsWith("@@ ")) {
      i++;
      continue;
    }

    // Found a hunk header — skip it and parse the hunk body
    i++;
    const searchLines: string[] = [];
    const replaceLines: string[] = [];

    while (i < lines.length) {
      const line = lines[i];

      // Stop at next hunk header, next file header, or end of meaningful content
      if (
        line.startsWith("@@ ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
      ) {
        break;
      }

      // Skip "no newline" markers
      if (line.startsWith("\\ ")) {
        i++;
        continue;
      }

      if (line.startsWith("-")) {
        searchLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        replaceLines.push(line.slice(1));
      } else {
        // Context line (starts with space or is empty)
        const content = line.startsWith(" ") ? line.slice(1) : line;
        searchLines.push(content);
        replaceLines.push(content);
      }
      i++;
    }

    if (searchLines.length > 0 || replaceLines.length > 0) {
      blocks.push({
        search: searchLines.join("\n"),
        replace: replaceLines.join("\n"),
        index: blockIndex,
      });
      blockIndex++;
    }
  }

  return { blocks, malformedBlocks: 0 };
}

// ── Search/replace block support ───────────────────────────────────────────

/**
 * Parse search/replace blocks from the diff string.
 * Format:
 * <<<<<<< SEARCH
 * content to find
 * ======= DIVIDER =======
 * replacement content
 * >>>>>>> REPLACE
 */
interface ParseResult {
  blocks: SearchReplaceBlock[];
  malformedBlocks: number;
}

export function parseSearchReplaceBlocks(diff: string): ParseResult {
  const blocks: SearchReplaceBlock[] = [];
  const lines = diff.split("\n");

  let i = 0;
  let blockIndex = 0;
  let malformedBlocks = 0;

  // Detect whether this diff uses the new or legacy delimiter.
  // If the new delimiter appears anywhere, use strict mode (only match new delimiter).
  // Otherwise fall back to the legacy bare "=======" for backward compatibility.
  const useNewDelimiter = lines.some((l) => l.trimEnd() === DIVIDER_MARKER);

  while (i < lines.length) {
    // Look for <<<<<<< SEARCH — compare without leading/trailing whitespace
    if (lines[i].trimEnd() === SEARCH_MARKER) {
      i++;
      const searchLines: string[] = [];
      const replaceLines: string[] = [];
      let inReplace = false;
      let foundReplace = false;

      while (i < lines.length) {
        const trimmed = lines[i].trimEnd();

        const isDivider = useNewDelimiter
          ? trimmed === DIVIDER_MARKER
          : trimmed === LEGACY_DIVIDER || trimmed === DIVIDER_MARKER;

        if (isDivider && !inReplace) {
          inReplace = true;
          i++;
          continue;
        }

        if (trimmed === REPLACE_MARKER) {
          blocks.push({
            search: searchLines.join("\n"),
            replace: replaceLines.join("\n"),
            index: blockIndex,
          });
          foundReplace = true;
          blockIndex++;
          i++;
          break;
        }

        if (inReplace) {
          replaceLines.push(lines[i]);
        } else {
          searchLines.push(lines[i]);
        }
        i++;
      }

      if (!foundReplace) {
        malformedBlocks++;
        blockIndex++;
      }
    } else {
      i++;
    }
  }

  return { blocks, malformedBlocks };
}

/**
 * Apply search/replace blocks to content sequentially.
 * Returns the new content and list of failed block indices.
 */
export function applyBlocks(
  content: string,
  blocks: SearchReplaceBlock[],
): { result: string; failedBlocks: number[] } {
  let result = content;
  const failedBlocks: number[] = [];

  for (const block of blocks) {
    const occurrences = countOccurrences(result, block.search);

    if (occurrences === 0) {
      // Fallback 1: try whitespace-flexible matching (tabs ≈ spaces)
      const flexMatch = tryFlexibleMatch(result, block.search);
      if (flexMatch) {
        result =
          result.slice(0, flexMatch.start) +
          block.replace +
          result.slice(flexMatch.end);
        continue;
      }

      // Fallback 2: try escape-aware matching (\\n in file → \n in search)
      const escMatch = tryEscapeAwareMatch(result, block.search);
      if (escMatch) {
        // Apply the same escape transformation to the replacement content
        const transformedReplace = block.replace.replace(
          /\n/g,
          escMatch.escapeSequence,
        );
        result =
          result.slice(0, escMatch.start) +
          transformedReplace +
          result.slice(escMatch.end);
        continue;
      }

      failedBlocks.push(block.index);
      continue;
    }

    if (occurrences > 1) {
      failedBlocks.push(block.index);
      continue;
    }

    // Exactly one match — apply replacement using indexOf + slice.
    // Do NOT use String.prototype.replace here — it interprets $& $` $'
    // and $$ as special patterns in the replacement string, which silently
    // corrupts source code that contains those character sequences.
    const idx = result.indexOf(block.search);
    result =
      result.slice(0, idx) +
      block.replace +
      result.slice(idx + block.search.length);
  }

  return { result, failedBlocks };
}

/**
 * Normalize a line for whitespace-flexible comparison:
 * - Convert leading tabs to 4 spaces
 * - Trim trailing whitespace
 *
 * This allows matching when Claude generates spaces but the file uses tabs
 * (or vice versa), which commonly happens because read_file output can make
 * tabs and spaces visually indistinguishable.
 */
export function normalizeForComparison(line: string): string {
  const trimmedEnd = line.trimEnd();
  const leadingMatch = trimmedEnd.match(/^(\s*)/);
  const leadingWS = leadingMatch?.[1] ?? "";
  const rest = trimmedEnd.slice(leadingWS.length);
  return leadingWS.replace(/\t/g, "    ") + rest;
}

/**
 * Try to find a unique match for `search` within `content` using
 * whitespace-flexible line-by-line comparison (tabs ≈ spaces in leading
 * indentation, trailing whitespace ignored).
 *
 * Returns the character offset range { start, end } in the original content,
 * or null if no unique match (0 or 2+) is found.
 */
export function tryFlexibleMatch(
  content: string,
  search: string,
): { start: number; end: number } | null {
  const contentLines = content.split("\n");
  const searchLines = search.split("\n");

  if (searchLines.length === 0) return null;

  const normSearch = searchLines.map(normalizeForComparison);
  const normContent = contentLines.map(normalizeForComparison);

  let matchCount = 0;
  let matchLineStart = -1;

  for (let i = 0; i <= normContent.length - normSearch.length; i++) {
    let isMatch = true;
    for (let j = 0; j < normSearch.length; j++) {
      if (normContent[i + j] !== normSearch[j]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      matchCount++;
      matchLineStart = i;
      if (matchCount > 1) return null; // Ambiguous — bail early
    }
  }

  if (matchCount !== 1) return null;

  // Convert line indices to character offsets in the original content
  let start = 0;
  for (let i = 0; i < matchLineStart; i++) {
    start += contentLines[i].length + 1; // +1 for \n
  }

  let end = start;
  for (let i = 0; i < searchLines.length; i++) {
    end += contentLines[matchLineStart + i].length;
    if (i < searchLines.length - 1) end += 1; // +1 for \n between lines
  }

  return { start, end };
}

/**
 * Try to match search content against file content when escape sequences
 * may have been corrupted during JSON serialization.
 *
 * Common case: file has `\\n` (literal backslash + n) on a single line, but
 * JSON serialization collapsed the escapes into real newline characters,
 * splitting the search content across multiple lines.
 *
 * Returns the character offset range { start, end } in the content plus the
 * escape string that was used (so the caller can apply the same transformation
 * to the replacement content), or null if no unique match is found.
 */
export function tryEscapeAwareMatch(
  content: string,
  search: string,
): { start: number; end: number; escapeSequence: string } | null {
  // Only relevant when search has newlines that might be escaped in the file
  if (!search.includes("\n")) return null;

  // Variants: replace actual newlines with escape sequences that might appear in the file
  const escapeVariants = [
    "\\n", // 2 chars: \ + n  (e.g. \n in a raw string)
    "\\\\n", // 3 chars: \ + \ + n  (e.g. \\n in JS/TS source)
  ];

  for (const esc of escapeVariants) {
    const variant = search.replace(/\n/g, esc);

    // Skip if identical to original (shouldn't happen since we checked for \n)
    if (variant === search) continue;

    const count = countOccurrences(content, variant);
    if (count === 1) {
      const start = content.indexOf(variant);
      return { start, end: start + variant.length, escapeSequence: esc };
    }
  }

  return null;
}

function countOccurrences(text: string, search: string): number {
  if (search.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

export async function handleApplyDiff(
  params: { path: string; diff: string },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  try {
    const { absolutePath: filePath, inWorkspace } = resolveAndValidatePath(
      params.path,
    );
    const relPath = getRelativePath(filePath);

    // Note: for writes, the diff view acts as the approval gate for outside-workspace paths.
    // No separate path access prompt — that would be double-prompting. The PathRule is stored
    // as a side effect when the user clicks "For Session"/"Always" on the diff view.

    // File must exist for apply_diff
    let originalContent: string;
    try {
      originalContent = await fs.readFile(filePath, "utf-8");
    } catch {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "File not found",
              path: params.path,
            }),
          },
        ],
      };
    }

    // Parse blocks — try SEARCH/REPLACE format first, fall back to unified diff
    let blocks: SearchReplaceBlock[];
    let malformedBlocks: number;

    if (isUnifiedDiff(params.diff)) {
      ({ blocks, malformedBlocks } = parseUnifiedDiff(params.diff));
    } else {
      ({ blocks, malformedBlocks } = parseSearchReplaceBlocks(params.diff));
    }

    if (blocks.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No valid search/replace blocks found in diff",
              path: params.path,
              ...(malformedBlocks > 0 && {
                malformed_blocks: malformedBlocks,
                hint: "Some blocks were missing a >>>>>>> REPLACE marker",
              }),
            }),
          },
        ],
      };
    }

    // Apply blocks
    const { result: newContent, failedBlocks } = applyBlocks(
      originalContent,
      blocks,
    );

    // If all blocks failed, return error without opening diff
    if (failedBlocks.length === blocks.length) {
      const failedSearches = failedBlocks.map((i) => {
        const block = blocks[i];
        const occurrences = countOccurrences(originalContent, block.search);
        if (occurrences === 0) {
          return `Block ${i}: Search content not found`;
        } else {
          return `Block ${i}: Ambiguous match (${occurrences} occurrences found)`;
        }
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "All search/replace blocks failed",
              failed_blocks: failedSearches,
              path: params.path,
            }),
          },
        ],
      };
    }

    // If content unchanged (all blocks matched but produced same result)
    if (newContent === originalContent) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "accepted",
              path: relPath,
              operation: "modified",
              note: "No changes resulted from the diff application",
            }),
          },
        ],
      };
    }

    const diagnosticDelay = vscode.workspace
      .getConfiguration("agentlink")
      .get<number>("diagnosticDelay", 1500);

    const masterBypass = vscode.workspace
      .getConfiguration("agentlink")
      .get<boolean>("masterBypass", false);

    // Auto-approve check (includes recent single-use approvals within TTL)
    const canAutoApprove = inWorkspace
      ? masterBypass ||
        approvalManager.isWriteApproved(sessionId, filePath) ||
        approvalPanel.isRecentlyApproved("write", relPath)
      : approvalManager.isFileWriteApproved(sessionId, filePath) ||
        approvalPanel.isRecentlyApproved("write", relPath);

    if (canAutoApprove) {
      // Snapshot diagnostics before the write (registers listener eagerly)
      const snap = snapshotDiagnostics(filePath);

      await fs.writeFile(filePath, newContent, "utf-8");

      // Open the file in VS Code so the user can see what was changed
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: true,
      });

      // Collect new diagnostics
      const newDiagnostics = await snap.collectNewErrors(diagnosticDelay);

      const response: Record<string, unknown> = {
        status: "accepted",
        path: relPath,
        operation: "modified",
      };
      if (failedBlocks.length > 0 || malformedBlocks > 0) {
        response.partial = true;
        if (failedBlocks.length > 0) response.failed_blocks = failedBlocks;
        if (malformedBlocks > 0) response.malformed_blocks = malformedBlocks;
      }
      if (newDiagnostics) {
        response.new_diagnostics = newDiagnostics;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }

    // Use diff view with file lock
    const result = await withFileLock(filePath, async () => {
      const diffView = new DiffViewProvider(diagnosticDelay);
      await diffView.open(filePath, relPath, newContent, {
        outsideWorkspace: !inWorkspace,
      });
      const decision = await diffView.waitForUserDecision(approvalPanel);

      if (decision === "reject") {
        return await diffView.revertChanges(
          diffView.writeApprovalResponse?.rejectionReason,
        );
      }

      // Handle session/always acceptance — save rules.
      const scope = decisionToScope(decision);
      if (scope) {
        await saveWriteTrustRules({
          panelResponse: diffView.writeApprovalResponse,
          approvalManager,
          sessionId,
          scope,
          relPath,
          filePath,
          inWorkspace,
        });
      }

      return await diffView.saveChanges();
    });

    const { finalContent, ...response } = result;
    const responseObj = response as Record<string, unknown>;

    // Add partial failure info if applicable
    if (
      (failedBlocks.length > 0 || malformedBlocks > 0) &&
      result.status === "accepted"
    ) {
      responseObj.partial = true;
      if (failedBlocks.length > 0) responseObj.failed_blocks = failedBlocks;
      if (malformedBlocks > 0) responseObj.malformed_blocks = malformedBlocks;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(responseObj, null, 2) }],
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
