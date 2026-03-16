import * as vscode from "vscode";
import * as fs from "fs/promises";

import { resolveAndValidatePath, getRelativePath } from "../util/paths.js";
import {
  DiffViewProvider,
  withFileLock,
  snapshotDiagnostics,
} from "../integrations/DiffViewProvider.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { decisionToScope, saveWriteTrustRules } from "./writeApprovalUI.js";

import {
  type ToolResult,
  type OnApprovalRequest,
  errorResult,
} from "../shared/types.js";
import { handlePendingEditLockError } from "./pendingEditLock.js";

interface SearchReplaceBlock {
  search: string;
  replace: string;
  index: number;
}

export type BlockApplyResult =
  | {
      index: number;
      status: "applied";
      matchType: "exact" | "flexible" | "escape_normalized";
    }
  | {
      index: number;
      status: "failed";
      reason:
        | "empty_search"
        | "not_found"
        | "ambiguous_exact"
        | "ambiguous_flexible"
        | "ambiguous_escape";
      exactOccurrences: number;
    };

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
  // Detect unified diff by the presence of hunk headers (@@ -N,N +N,N @@).
  // File headers (--- / +++) are optional — many tools emit abbreviated diffs
  // with only hunk headers, so we don't require them.
  return /^@@\s+[+-]/m.test(diff);
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
  const useNewDelimiter = lines.some((l) => l.trim() === DIVIDER_MARKER);

  while (i < lines.length) {
    // Look for <<<<<<< SEARCH — compare without leading/trailing whitespace.
    // Also accept trailing characters (e.g. "<<<<<<< SEARCH>" with a stray ">").
    if (lines[i].trim().startsWith(SEARCH_MARKER)) {
      i++;
      const searchLines: string[] = [];
      const replaceLines: string[] = [];
      let inReplace = false;
      let foundReplace = false;

      while (i < lines.length) {
        const trimmed = lines[i].trim();

        const isDivider = useNewDelimiter
          ? trimmed === DIVIDER_MARKER
          : trimmed === LEGACY_DIVIDER || trimmed === DIVIDER_MARKER;

        if (isDivider && !inReplace) {
          inReplace = true;
          i++;
          continue;
        }

        // A second divider inside the replace section means the block is
        // malformed — the LLM likely included marker syntax as content.
        // Reject the block rather than silently writing markers to the file.
        if (isDivider && inReplace) {
          inReplace = false;
          break;
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
 * Returns the new content, failed block indices, and per-block outcomes.
 */
export function applyBlocks(
  content: string,
  blocks: SearchReplaceBlock[],
): {
  result: string;
  failedBlocks: number[];
  blockResults: BlockApplyResult[];
} {
  let result = content;
  const failedBlocks: number[] = [];
  const blockResults: BlockApplyResult[] = [];

  for (const block of blocks) {
    if (block.search.length === 0) {
      failedBlocks.push(block.index);
      blockResults.push({
        index: block.index,
        status: "failed",
        reason: "empty_search",
        exactOccurrences: 0,
      });
      continue;
    }

    const occurrences = countOccurrences(result, block.search);

    if (occurrences === 0) {
      const flexAnalysis = analyzeFlexibleMatch(result, block.search);
      if (flexAnalysis.match) {
        result =
          result.slice(0, flexAnalysis.match.start) +
          block.replace +
          result.slice(flexAnalysis.match.end);
        blockResults.push({
          index: block.index,
          status: "applied",
          matchType: "flexible",
        });
        continue;
      }

      const escAnalysis = analyzeEscapeNormalizedMatch(result, block.search);
      if (escAnalysis.match) {
        const transformedReplace = escAnalysis.match.transformReplace(
          block.replace,
        );
        result =
          result.slice(0, escAnalysis.match.start) +
          transformedReplace +
          result.slice(escAnalysis.match.end);
        blockResults.push({
          index: block.index,
          status: "applied",
          matchType: "escape_normalized",
        });
        continue;
      }

      failedBlocks.push(block.index);
      blockResults.push({
        index: block.index,
        status: "failed",
        reason:
          flexAnalysis.matchCount > 1
            ? "ambiguous_flexible"
            : escAnalysis.ambiguousVariantCount > 0
              ? "ambiguous_escape"
              : "not_found",
        exactOccurrences: 0,
      });
      continue;
    }

    if (occurrences > 1) {
      failedBlocks.push(block.index);
      blockResults.push({
        index: block.index,
        status: "failed",
        reason: "ambiguous_exact",
        exactOccurrences: occurrences,
      });
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
    blockResults.push({
      index: block.index,
      status: "applied",
      matchType: "exact",
    });
  }

  return { result, failedBlocks, blockResults };
}

/**
 * Normalize a line for whitespace-agnostic comparison:
 * - Trim leading and trailing whitespace
 * - Collapse all internal whitespace runs to a single space
 *
 * This handles ALL whitespace mismatches between agent-provided SEARCH
 * blocks and actual file content: tabs vs spaces, mid-line tabs (Go
 * struct alignment), any tab width, mixed indentation, and trailing
 * whitespace — in one simple expression.
 *
 * Safe because the normalized form is only used for *finding* the match
 * location, not for the replacement content. The ambiguity check (reject
 * if 2+ locations match) prevents false positives.
 */
export function normalizeForComparison(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/**
 * Try to find a unique match for `search` within `content` using
 * whitespace-flexible line-by-line comparison (tabs ≈ spaces in leading
 * indentation, trailing whitespace ignored).
 *
 * Returns the character offset range { start, end } in the original content,
 * or null if no unique match (0 or 2+) is found.
 */
function analyzeFlexibleMatch(
  content: string,
  search: string,
): { match: { start: number; end: number } | null; matchCount: number } {
  const contentLines = content.split("\n");
  const searchLines = search.split("\n");

  if (searchLines.length === 0) return { match: null, matchCount: 0 };

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
      if (matchCount > 1) return { match: null, matchCount };
    }
  }

  if (matchCount !== 1) return { match: null, matchCount };

  let start = 0;
  for (let i = 0; i < matchLineStart; i++) {
    start += contentLines[i].length + 1;
  }

  let end = start;
  for (let i = 0; i < searchLines.length; i++) {
    end += contentLines[matchLineStart + i].length;
    if (i < searchLines.length - 1) end += 1;
  }

  return { match: { start, end }, matchCount };
}

export function tryFlexibleMatch(
  content: string,
  search: string,
): { start: number; end: number } | null {
  return analyzeFlexibleMatch(content, search).match;
}

// ── Escape-normalized matching ─────────────────────────────────────────────

/**
 * All JSON escape sequences that JSON.parse interprets, mapped to the literal
 * text that might appear in the file.
 *
 * When an LLM generates JSON for a tool call, it may under-escape backslash
 * sequences. For example, a file containing literal \n (2 chars: \ + n)
 * should be represented in JSON as \\n, but the LLM may write \n which
 * JSON.parse turns into a real newline character (0x0A).
 *
 * Each entry maps the interpreted character to one or more literal sequences
 * that might appear in the file (ordered from most to least common).
 */
const ESCAPE_PAIRS: Array<{ interpreted: string; literal: string[] }> = [
  { interpreted: "\n", literal: ["\\n", "\\\\n"] }, // newline -> \n or \\n
  { interpreted: "\t", literal: ["\\t"] }, // tab -> \t
  { interpreted: "\r", literal: ["\\r"] }, // CR -> \r
];

/**
 * Try to match search content against file content when escape sequences
 * have been corrupted during JSON serialization/deserialization.
 *
 * JSON.parse turns \\n -> \n (newline), \\t -> \t (tab), etc. When the file
 * has literal escape sequences (e.g., \n as 2 chars), the search content
 * will have the interpreted character instead.
 *
 * Strategy: For each escape pair, try replacing the interpreted character
 * in the search with the literal text, then check for a unique match.
 * Tries each escape individually first, then all relevant escapes combined.
 *
 * Returns the match range and a transform function that converts the
 * replacement content to use the same escape style as the file.
 */
type EscapeMatch = {
  start: number;
  end: number;
  transformReplace: (replace: string) => string;
};

function analyzeEscapeNormalizedMatch(
  content: string,
  search: string,
): { match: EscapeMatch | null; ambiguousVariantCount: number } {
  const relevantPairs = ESCAPE_PAIRS.filter((p) =>
    search.includes(p.interpreted),
  );
  if (relevantPairs.length === 0) {
    return { match: null, ambiguousVariantCount: 0 };
  }

  const seenVariants = new Set<string>();
  let ambiguousVariantCount = 0;

  const tryVariant = (
    variant: string,
    transformReplace: (replace: string) => string,
  ): EscapeMatch | null => {
    if (variant === search || seenVariants.has(variant)) return null;
    seenVariants.add(variant);

    const count = countOccurrences(content, variant);
    if (count === 1) {
      const start = content.indexOf(variant);
      return {
        start,
        end: start + variant.length,
        transformReplace,
      };
    }
    if (count > 1) {
      ambiguousVariantCount++;
    }
    return null;
  };

  for (const pair of relevantPairs) {
    for (const lit of pair.literal) {
      const interpreted = pair.interpreted;
      const variant = search.replaceAll(interpreted, lit);
      const match = tryVariant(variant, (replace: string) =>
        replace.replaceAll(interpreted, lit),
      );
      if (match) {
        return { match, ambiguousVariantCount };
      }
    }
  }

  if (relevantPairs.length > 1) {
    let variant = search;
    const transforms: Array<{ interpreted: string; literal: string }> = [];
    for (const pair of relevantPairs) {
      const lit = pair.literal[0];
      variant = variant.replaceAll(pair.interpreted, lit);
      transforms.push({ interpreted: pair.interpreted, literal: lit });
    }
    const match = tryVariant(variant, (replace: string) => {
      let transformed = replace;
      for (const t of transforms) {
        transformed = transformed.replaceAll(t.interpreted, t.literal);
      }
      return transformed;
    });
    if (match) {
      return { match, ambiguousVariantCount };
    }
  }

  return { match: null, ambiguousVariantCount };
}

export function tryEscapeNormalizedMatch(
  content: string,
  search: string,
): {
  start: number;
  end: number;
  transformReplace: (replace: string) => string;
} | null {
  return analyzeEscapeNormalizedMatch(content, search).match;
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

function previewSearch(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 80) return compact;
  return `${compact.slice(0, 77)}...`;
}

function describeBlockResult(
  result: BlockApplyResult,
): Record<string, unknown> {
  if (result.status === "applied") {
    return {
      index: result.index,
      status: result.status,
      match_type: result.matchType,
    };
  }
  return {
    index: result.index,
    status: result.status,
    reason: result.reason,
    exact_occurrences: result.exactOccurrences,
  };
}

function formatFailedBlockMessage(
  result: BlockApplyResult,
  blocks: SearchReplaceBlock[],
): string {
  const block = blocks[result.index];
  const preview = block ? previewSearch(block.search) : "";
  if (result.status !== "failed") {
    return `Block ${result.index}: applied`;
  }

  const reason =
    result.reason === "empty_search"
      ? "Search content was empty"
      : result.reason === "ambiguous_exact"
        ? `Ambiguous exact match (${result.exactOccurrences} occurrences found)`
        : result.reason === "ambiguous_flexible"
          ? "No exact match, and whitespace-normalized search matched multiple locations"
          : result.reason === "ambiguous_escape"
            ? "No exact match, and escape-normalized search matched multiple locations"
            : "Search content not found (including whitespace/escape-normalized matching)";

  return preview
    ? `Block ${result.index}: ${reason} — search preview: ${preview}`
    : `Block ${result.index}: ${reason}`;
}

export async function handleApplyDiff(
  params: { path: string; diff: string },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  onApprovalRequest?: OnApprovalRequest,
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
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const errorMsg =
        code === "ENOENT"
          ? "File not found"
          : code === "EACCES"
            ? "Permission denied"
            : code === "EISDIR"
              ? "Path is a directory"
              : `Failed to read file: ${err instanceof Error ? err.message : err}`;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: errorMsg,
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
              hint:
                malformedBlocks > 0
                  ? "Some blocks were missing a >>>>>>> REPLACE marker"
                  : "Ensure marker lines are on their own lines: <<<<<<< SEARCH / ======= DIVIDER ======= / >>>>>>> REPLACE",
              ...(malformedBlocks > 0 && {
                malformed_blocks: malformedBlocks,
              }),
            }),
          },
        ],
      };
    }

    // Apply blocks
    const {
      result: newContent,
      failedBlocks,
      blockResults,
    } = applyBlocks(originalContent, blocks);

    // Safety check: reject if the diff would introduce marker syntax into
    // the file. This prevents cascading corruption where a misparsed block
    // writes "======= DIVIDER =======" or other markers as literal content.
    const markers = [SEARCH_MARKER, DIVIDER_MARKER, REPLACE_MARKER];
    for (const marker of markers) {
      if (newContent.includes(marker) && !originalContent.includes(marker)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "Diff would introduce search/replace marker syntax into the file — aborting to prevent corruption",
                hint: "The replacement content contains SEARCH/REPLACE markers that would corrupt the file. Use write_file instead.",
                path: params.path,
              }),
            },
          ],
        };
      }
    }

    // If all blocks failed, return error without opening diff
    if (failedBlocks.length === blocks.length) {
      const failedDetails = blockResults.map((result) =>
        describeBlockResult(result),
      );
      const failedSearches = blockResults.map((result) =>
        formatFailedBlockMessage(result, blocks),
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "All search/replace blocks failed",
              failed_blocks: failedSearches,
              failed_block_details: failedDetails,
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
    const canAutoApprove =
      masterBypass ||
      (inWorkspace
        ? approvalManager.isAgentWriteApproved(sessionId, filePath)
        : approvalManager.isFileWriteApproved(sessionId, filePath));

    if (canAutoApprove) {
      // Use file lock to prevent concurrent auto-approved writes from
      // interleaving WorkspaceEdit + format-on-save sequences,
      // which can corrupt file content.
      const autoResult = await withFileLock(filePath, async () => {
        // Snapshot diagnostics before the write (registers listener eagerly)
        const snap = snapshotDiagnostics(filePath);

        // Update content through the document model, then save — this avoids
        // a race where fs.writeFile changes disk, the file watcher fires
        // after applyEdit makes the doc dirty, and VS Code shows the
        // "overwrite or revert" dialog.
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc, {
          preview: false,
          preserveFocus: true,
        });

        if (doc.getText() !== newContent) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            doc.uri,
            new vscode.Range(
              doc.positionAt(0),
              doc.positionAt(doc.getText().length),
            ),
            newContent,
          );
          await vscode.workspace.applyEdit(edit);
        }
        if (doc.isDirty) {
          await doc.save();
        }

        // Collect new diagnostics
        const newDiagnostics = await snap.collectNewErrors(diagnosticDelay);

        const response: Record<string, unknown> = {
          status: "accepted",
          path: relPath,
          operation: "modified",
        };
        if (failedBlocks.length > 0 || malformedBlocks > 0) {
          response.partial = true;
          if (failedBlocks.length > 0) {
            response.failed_blocks = failedBlocks;
            response.failed_block_details = blockResults
              .filter((result) => result.status === "failed")
              .map((result) => describeBlockResult(result));
          }
          if (malformedBlocks > 0) response.malformed_blocks = malformedBlocks;
        }
        if (
          blocks.length > 1 ||
          blockResults.some(
            (result) =>
              result.status === "failed" ||
              (result.status === "applied" && result.matchType !== "exact"),
          )
        ) {
          response.block_results = blockResults.map((result) =>
            describeBlockResult(result),
          );
        }
        if (newDiagnostics) {
          response.new_diagnostics = newDiagnostics;
        }
        return response;
      });

      return {
        content: [{ type: "text", text: JSON.stringify(autoResult, null, 2) }],
      };
    }

    // Use diff view with file lock
    const result = await withFileLock(filePath, async () => {
      const diffView = new DiffViewProvider(diagnosticDelay);
      await diffView.open(filePath, relPath, newContent, {
        outsideWorkspace: !inWorkspace,
      });
      const decision = await diffView.waitForUserDecision(
        approvalPanel,
        onApprovalRequest,
      );

      if (decision === "reject") {
        return await diffView.revertChanges(
          diffView.writeApprovalResponse?.rejectionReason,
        );
      }

      // Handle session/always acceptance — save rules.
      const scope = decisionToScope(decision);
      if (scope) {
        saveWriteTrustRules({
          panelResponse: diffView.writeApprovalResponse,
          approvalManager,
          sessionId,
          scope,
          relPath,
          inWorkspace,
        });
      }

      return await diffView.saveChanges();
    });

    const { finalContent: _finalContent, ...response } = result;
    const responseObj = response as Record<string, unknown>;

    // Add partial failure info if applicable
    if (
      (failedBlocks.length > 0 || malformedBlocks > 0) &&
      result.status === "accepted"
    ) {
      responseObj.partial = true;
      if (failedBlocks.length > 0) {
        responseObj.failed_blocks = failedBlocks;
        responseObj.failed_block_details = blockResults
          .filter((blockResult) => blockResult.status === "failed")
          .map((blockResult) => describeBlockResult(blockResult));
      }
      if (malformedBlocks > 0) responseObj.malformed_blocks = malformedBlocks;
    }

    if (
      blocks.length > 1 ||
      blockResults.some(
        (blockResult) =>
          blockResult.status === "failed" ||
          (blockResult.status === "applied" &&
            blockResult.matchType !== "exact"),
      )
    ) {
      responseObj.block_results = blockResults.map((blockResult) =>
        describeBlockResult(blockResult),
      );
    }

    return {
      content: [{ type: "text", text: JSON.stringify(responseObj, null, 2) }],
    };
  } catch (err) {
    return (
      handlePendingEditLockError(err, params.path) ??
      errorResult(err instanceof Error ? err.message : String(err), {
        path: params.path,
      })
    );
  }
}
