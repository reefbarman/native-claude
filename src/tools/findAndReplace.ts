import * as vscode from "vscode";

import {
  resolveAndValidatePath,
  tryGetFirstWorkspaceRoot,
  getRelativePath,
} from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { decisionToScope, applyInlineTrustScope } from "./writeApprovalUI.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";
import { FindReplacePreviewPanel } from "../findReplace/FindReplacePreviewPanel.js";
import type {
  FindReplaceMatch,
  FindReplaceFileGroup,
  FindReplacePreviewData,
} from "../findReplace/webview/types.js";

import { type ToolResult, type OnApprovalRequest } from "../shared/types.js";

const CONTEXT_LINES = 5;

interface FileReplacement {
  uri: vscode.Uri;
  relPath: string;
  replacements: Array<{
    range: vscode.Range;
    newText: string;
    matchId: string;
  }>;
  matches: FindReplaceMatch[];
}

export async function handleFindAndReplace(
  params: {
    find: string;
    replace: string;
    path?: string;
    glob?: string;
    regex?: boolean;
    max_replacements?: number;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  extensionUri: vscode.Uri,
  onApprovalRequest?: OnApprovalRequest,
): Promise<ToolResult> {
  let previewPanel: FindReplacePreviewPanel | undefined;

  try {
    const workspaceRoot = tryGetFirstWorkspaceRoot();
    if (!workspaceRoot) {
      return error(
        "No workspace folder open. find_and_replace with glob requires a workspace.",
      );
    }
    const findStr = params.find;
    const replaceStr = params.replace;

    if (!findStr) {
      return error("'find' parameter is required");
    }

    // Build the search pattern
    let pattern: RegExp;
    if (params.regex) {
      try {
        pattern = new RegExp(findStr, "g");
      } catch (e) {
        return error(`Invalid regex: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      // Escape special regex characters for literal search
      const escaped = findStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pattern = new RegExp(escaped, "g");
    }

    // Resolve target files
    let fileUris: vscode.Uri[];

    if (params.path) {
      const { absolutePath, inWorkspace } = resolveAndValidatePath(params.path);

      // Outside-workspace gate — consistent with read/write tools
      if (
        !inWorkspace &&
        !approvalManager.isPathTrusted(sessionId, absolutePath)
      ) {
        const { approved, reason } = await approveOutsideWorkspaceAccess(
          absolutePath,
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

      fileUris = [vscode.Uri.file(absolutePath)];
    } else if (params.glob) {
      // Use VS Code's file finder with the glob pattern
      const relGlob = new vscode.RelativePattern(workspaceRoot, params.glob);
      fileUris = await vscode.workspace.findFiles(
        relGlob,
        "**/node_modules/**",
        500,
      );
      if (fileUris.length === 0) {
        return error(`No files matched glob pattern: ${params.glob}`);
      }
    } else {
      return error("Either 'path' or 'glob' must be specified");
    }

    // Find all occurrences with context
    const fileReplacements: FileReplacement[] = [];
    let totalChanges = 0;

    for (let fileIdx = 0; fileIdx < fileUris.length; fileIdx++) {
      const uri = fileUris[fileIdx];
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        continue; // Skip files that can't be opened (binary, etc.)
      }

      const text = doc.getText();
      const replacements: FileReplacement["replacements"] = [];
      const matches: FindReplaceMatch[] = [];

      // Reset regex lastIndex for each file
      pattern.lastIndex = 0;
      let regexMatch: RegExpExecArray | null;
      let matchIdx = 0;

      while ((regexMatch = pattern.exec(text)) !== null) {
        const startPos = doc.positionAt(regexMatch.index);
        const endPos = doc.positionAt(regexMatch.index + regexMatch[0].length);
        const range = new vscode.Range(startPos, endPos);

        // For regex, support capture group references ($1, $2, etc.)
        // Use the match array directly to avoid re-executing the pattern
        // (which fails for anchored patterns like ^, $, lookahead).
        const m = regexMatch;
        let newText = replaceStr;
        if (params.regex) {
          newText = replaceStr.replace(
            /\$(\d+)/g,
            (_, n) => m[parseInt(n, 10)] ?? "",
          );
        }

        const matchId = `${fileIdx}:${matchIdx}`;

        // Compute context lines
        const matchLine = startPos.line;
        const startCtx = Math.max(0, matchLine - CONTEXT_LINES);
        const endCtx = Math.min(doc.lineCount - 1, matchLine + CONTEXT_LINES);

        const contextBefore: FindReplaceMatch["contextBefore"] = [];
        for (let ln = startCtx; ln < matchLine; ln++) {
          contextBefore.push({ lineNumber: ln + 1, text: doc.lineAt(ln).text });
        }

        const contextAfter: FindReplaceMatch["contextAfter"] = [];
        for (let ln = matchLine + 1; ln <= endCtx; ln++) {
          contextAfter.push({ lineNumber: ln + 1, text: doc.lineAt(ln).text });
        }

        replacements.push({ range, newText, matchId });
        matches.push({
          id: matchId,
          line: matchLine + 1,
          columnStart: startPos.character,
          columnEnd: endPos.character,
          matchText: regexMatch[0],
          replaceText: newText,
          contextBefore,
          matchLine: {
            lineNumber: matchLine + 1,
            text: doc.lineAt(matchLine).text,
          },
          contextAfter,
        });

        matchIdx++;
      }

      if (replacements.length > 0) {
        totalChanges += replacements.length;
        fileReplacements.push({
          uri,
          relPath: getRelativePath(uri.fsPath),
          replacements,
          matches,
        });
      }
    }

    if (totalChanges === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "no_matches",
              find: findStr,
              files_searched: fileUris.length,
            }),
          },
        ],
      };
    }

    if (params.max_replacements != null) {
      const maxReplacements = Number(params.max_replacements);
      if (
        !Number.isFinite(maxReplacements) ||
        !Number.isInteger(maxReplacements) ||
        maxReplacements <= 0
      ) {
        return error(
          `'max_replacements' must be a positive integer. Received: ${params.max_replacements}`,
        );
      }
      if (totalChanges > maxReplacements) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "too_many_matches",
                find: findStr,
                max_replacements: maxReplacements,
                total_matches: totalChanges,
                files_matched: fileReplacements.length,
                message:
                  "Match count exceeds max_replacements guardrail; no edits were applied.",
              }),
            },
          ],
        };
      }
    }

    // Build preview and approval data
    const fileGroups: FindReplaceFileGroup[] = fileReplacements.map((fr) => ({
      path: fr.relPath,
      matches: fr.matches,
    }));

    const filesPreview = fileReplacements.map((fr) => ({
      path: fr.relPath,
      changes: fr.replacements.length,
    }));

    // Check write approval
    const masterBypass = vscode.workspace
      .getConfiguration("agentlink")
      .get<boolean>("masterBypass", false);

    const canAutoApprove =
      masterBypass ||
      fileReplacements.every((fr) =>
        approvalManager.isAgentWriteApproved(sessionId, fr.uri.fsPath),
      );
    let followUp: string | undefined;
    let acceptedIds: Set<string> | undefined;

    if (!canAutoApprove) {
      // Open preview panel with diff blocks
      previewPanel = new FindReplacePreviewPanel(extensionUri);
      const previewData: FindReplacePreviewData = {
        findText: findStr,
        replaceText: replaceStr,
        isRegex: !!params.regex,
        fileGroups,
        totalMatches: totalChanges,
      };
      previewPanel.show(previewData);

      if (onApprovalRequest) {
        const filesDetail = filesPreview
          .map(
            (f) =>
              `${f.path} (${f.changes} change${f.changes !== 1 ? "s" : ""})`,
          )
          .join("\n");
        const decision = await onApprovalRequest(
          {
            kind: "rename",
            title: `Replace \`${findStr}\` → \`${replaceStr}\`?`,
            detail: `${totalChanges} match${totalChanges !== 1 ? "es" : ""} across ${filesPreview.length} file${filesPreview.length !== 1 ? "s" : ""}:\n${filesDetail}`,
            choices: [
              { label: "Accept all", value: "accept", isPrimary: true },
              { label: "Reject", value: "reject", isDanger: true },
            ],
          },
          sessionId,
        );
        if (decision === "reject") {
          previewPanel.close();
          previewPanel = undefined;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "rejected_by_user",
                  find: findStr,
                  replace: replaceStr,
                }),
              },
            ],
          };
        }
        acceptedIds = previewPanel.getAcceptedMatchIds();
        previewPanel.close();
        previewPanel = undefined;
      } else {
        // Enqueue approval (shows summary in approval panel)
        const { promise } = approvalPanel.enqueueRenameApproval(
          findStr,
          replaceStr,
          filesPreview,
          totalChanges,
        );

        const response = await promise;
        followUp = response.followUp;

        if (response.decision === "reject") {
          previewPanel.close();
          previewPanel = undefined;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "rejected_by_user",
                  find: findStr,
                  replace: replaceStr,
                  reason: response.rejectionReason,
                }),
              },
            ],
          };
        }

        // Read accepted matches from preview panel
        acceptedIds = previewPanel.getAcceptedMatchIds();
        previewPanel.close();
        previewPanel = undefined;

        // Save trust rules
        const scope = decisionToScope(response.decision);
        if (scope && response.trustScope) {
          const repPath =
            filesPreview.length > 0 ? filesPreview[0].path : "find-and-replace";
          applyInlineTrustScope(
            response,
            approvalManager,
            sessionId,
            scope,
            repPath,
          );
        }
      }
    }

    // Build WorkspaceEdit — filtered by accepted matches if preview was shown
    const edit = new vscode.WorkspaceEdit();
    let appliedCount = 0;
    const appliedFiles: Array<{ path: string; changes: number }> = [];

    for (const fr of fileReplacements) {
      let fileChanges = 0;
      for (const r of fr.replacements) {
        if (!acceptedIds || acceptedIds.has(r.matchId)) {
          edit.replace(fr.uri, r.range, r.newText);
          fileChanges++;
        }
      }
      if (fileChanges > 0) {
        appliedCount += fileChanges;
        appliedFiles.push({ path: fr.relPath, changes: fileChanges });
      }
    }

    if (appliedCount === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "no_changes",
              find: findStr,
              replace: replaceStr,
              message: "All matches were excluded by user",
            }),
          },
        ],
      };
    }

    // Apply the edit
    const applied = await vscode.workspace.applyEdit(edit);

    if (!applied) {
      return error("Failed to apply replacements");
    }

    // Save all affected documents
    for (const fr of fileReplacements) {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === fr.uri.fsPath,
      );
      if (doc?.isDirty) {
        await doc.save();
      }
    }

    const result: Record<string, unknown> = {
      status: "applied",
      find: findStr,
      replace: replaceStr,
      files_changed: appliedFiles.length,
      total_replacements: appliedCount,
      files: appliedFiles,
    };
    if (acceptedIds && appliedCount < totalChanges) {
      result.excluded = totalChanges - appliedCount;
    }
    if (followUp) {
      result.follow_up = followUp;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
    const message = err instanceof Error ? err.message : String(err);
    return error(message);
  } finally {
    // Ensure preview panel is always cleaned up
    previewPanel?.close();
  }
}

function error(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  };
}
