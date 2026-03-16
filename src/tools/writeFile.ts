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

import {
  type ToolResult,
  type OnApprovalRequest,
  errorResult,
} from "../shared/types.js";
import { handlePendingEditLockError } from "./pendingEditLock.js";

export async function handleWriteFile(
  params: { path: string; content: string },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  onApprovalRequest?: OnApprovalRequest,
  mode?: string,
): Promise<ToolResult> {
  try {
    const { absolutePath: filePath, inWorkspace } = resolveAndValidatePath(
      params.path,
    );
    const relPath = getRelativePath(filePath);

    // Note: for writes, the diff view acts as the approval gate for outside-workspace paths.
    // No separate path access prompt — that would be double-prompting. The PathRule is stored
    // as a side effect when the user clicks "For Session"/"Always" on the diff view.

    const diagnosticDelay = vscode.workspace
      .getConfiguration("agentlink")
      .get<number>("diagnosticDelay", 1500);

    const masterBypass = vscode.workspace
      .getConfiguration("agentlink")
      .get<boolean>("masterBypass", false);

    // In architect mode, auto-approve the first write to a plans/ file (new file only).
    const isNewPlanFile =
      mode === "architect" &&
      inWorkspace &&
      relPath.startsWith("plans/") &&
      !(await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false));

    // Auto-approve check (includes recent single-use approvals within TTL)
    const canAutoApprove =
      masterBypass ||
      isNewPlanFile ||
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

        // Ensure parent directories exist (for new files)
        await fs.mkdir(path.dirname(filePath), { recursive: true });

        // Create file on disk if it doesn't exist (openTextDocument needs it)
        try {
          await fs.access(filePath);
        } catch {
          await fs.writeFile(filePath, "", "utf-8");
        }

        // Update content through the document model, then save — this avoids
        // a race where fs.writeFile changes disk, the file watcher fires
        // after applyEdit makes the doc dirty, and VS Code shows the
        // "overwrite or revert" dialog.
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc, {
          preview: false,
          preserveFocus: true,
        });

        if (doc.getText() !== params.content) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            doc.uri,
            new vscode.Range(
              doc.positionAt(0),
              doc.positionAt(doc.getText().length),
            ),
            params.content,
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
          operation: "auto-approved",
        };
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

      await diffView.open(filePath, relPath, params.content, {
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
    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
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
