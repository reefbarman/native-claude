import * as vscode from "vscode";

import { getRelativePath } from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { resolveAndOpenDocument, toPosition } from "./languageFeatures.js";
import { decisionToScope, applyInlineTrustScope } from "./writeApprovalUI.js";

import { type ToolResult, type OnApprovalRequest } from "../shared/types.js";

export async function handleRenameSymbol(
  params: { path: string; line: number; column: number; new_name: string },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  onApprovalRequest?: OnApprovalRequest,
): Promise<ToolResult> {
  try {
    const { uri, document, relPath } = await resolveAndOpenDocument(
      params.path,
      approvalManager,
      approvalPanel,
      sessionId,
    );
    const position = toPosition(params.line, params.column);

    // Get the old name for display
    const wordRange = document.getWordRangeAtPosition(position);
    let oldName: string;
    if (wordRange) {
      oldName = document.getText(wordRange);
    } else {
      // Manual fallback: extract word at position from line text
      const lineText = document.lineAt(position.line).text;
      const before =
        lineText.slice(0, position.character).match(/\w+$/)?.[0] ?? "";
      const after = lineText.slice(position.character).match(/^\w+/)?.[0] ?? "";
      oldName = before + after || `symbol at ${params.line}:${params.column}`;
    }

    // Compute the rename edit
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      "vscode.executeDocumentRenameProvider",
      uri,
      position,
      params.new_name,
    );

    if (!edit) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Symbol at this position cannot be renamed",
              path: relPath,
              line: params.line,
              column: params.column,
            }),
          },
        ],
      };
    }

    // Build preview of affected files
    const entries = edit.entries();
    if (entries.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Rename produced no changes",
              path: relPath,
            }),
          },
        ],
      };
    }

    const filesPreview: Array<{ path: string; changes: number }> = [];
    let totalChanges = 0;
    for (const [entryUri, edits] of entries) {
      const count = edits.length;
      totalChanges += count;
      filesPreview.push({
        path: getRelativePath(entryUri.fsPath),
        changes: count,
      });
    }

    // Check write approval
    const masterBypass = vscode.workspace
      .getConfiguration("agentlink")
      .get<boolean>("masterBypass", false);

    const canAutoApprove =
      masterBypass || approvalManager.isAgentWriteApproved(sessionId);
    let renameFollowUp: string | undefined;

    if (!canAutoApprove) {
      let decision: string;

      if (onApprovalRequest) {
        const filesDetail = filesPreview
          .map(
            (f) =>
              `${f.path} (${f.changes} change${f.changes !== 1 ? "s" : ""})`,
          )
          .join("\n");
        const result = await onApprovalRequest(
          {
            kind: "rename",
            title: `Rename \`${oldName}\` → \`${params.new_name}\`?`,
            detail: `${totalChanges} change${totalChanges !== 1 ? "s" : ""} across ${filesPreview.length} file${filesPreview.length !== 1 ? "s" : ""}:\n${filesDetail}`,
            choices: [
              { label: "Accept", value: "accept", isPrimary: true },
              { label: "Reject", value: "reject", isDanger: true },
            ],
          },
          sessionId,
        );
        decision = typeof result === "string" ? result : result.decision;
        if (decision === "reject") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "rejected_by_user",
                  old_name: oldName,
                  new_name: params.new_name,
                }),
              },
            ],
          };
        }
      } else {
        const { promise } = approvalPanel.enqueueRenameApproval(
          oldName,
          params.new_name,
          filesPreview,
          totalChanges,
        );

        const response = await promise;
        renameFollowUp = response.followUp;

        if (response.decision === "reject") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "rejected_by_user",
                  old_name: oldName,
                  new_name: params.new_name,
                  reason: response.rejectionReason,
                }),
              },
            ],
          };
        }

        // Save trust rules for session/project/always decisions
        const scope = decisionToScope(response.decision);
        if (scope && response.trustScope) {
          applyInlineTrustScope(
            response,
            approvalManager,
            sessionId,
            scope,
            relPath,
          );
        }
      }
    }

    // Apply the rename
    const applied = await vscode.workspace.applyEdit(edit);

    if (!applied) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Failed to apply rename edit",
              path: relPath,
            }),
          },
        ],
      };
    }

    // Save all affected documents
    for (const [entryUri] of entries) {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === entryUri.fsPath,
      );
      if (doc?.isDirty) {
        await doc.save();
      }
    }

    const result: Record<string, unknown> = {
      status: "accepted",
      old_name: oldName,
      new_name: params.new_name,
      files_modified: filesPreview,
      total_changes: totalChanges,
    };
    if (renameFollowUp) {
      result.follow_up = renameFollowUp;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
    };
  } catch (err) {
    if (typeof err === "object" && err !== null && "content" in err) {
      return err as ToolResult;
    }
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
