import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as diffLib from "diff";

import { DIFF_VIEW_URI_SCHEME } from "../extension.js";
import { showApprovalAlert } from "../util/approvalAlert.js";
import { enqueueApproval } from "../util/quickPickQueue.js";
import type {
  ApprovalPanelProvider,
  WriteApprovalResponse,
} from "../approvals/ApprovalPanelProvider.js";

export type DiffDecision =
  | "accept"
  | "accept-session"
  | "accept-project"
  | "accept-always"
  | "reject";

// Module-level pending decision resolver — allows editor title bar commands to resolve the diff
let pendingDecisionResolve: ((decision: DiffDecision) => void) | null = null;

export function resolveCurrentDiff(decision: DiffDecision): boolean {
  if (pendingDecisionResolve) {
    pendingDecisionResolve(decision);
    pendingDecisionResolve = null;
    return true;
  }
  return false;
}

/**
 * Show a QuickPick with session/always accept options.
 * Called from the "more options" toolbar button command.
 */
export async function showDiffMoreOptions(): Promise<void> {
  if (!pendingDecisionResolve) return;

  await enqueueApproval("Write scope options", async () => {
    // Re-check after waiting in queue — decision may have been resolved
    if (!pendingDecisionResolve) return;

    const items: Array<vscode.QuickPickItem & { decision: DiffDecision }> = [
      {
        label: "$(bookmark) Accept for Session",
        description:
          "Accept this change and auto-accept future writes in this session",
        decision: "accept-session",
      },
      {
        label: "$(folder) Accept for Project",
        description:
          "Accept this change and auto-accept future writes for this project",
        decision: "accept-project",
      },
      {
        label: "$(globe) Always Accept",
        description: "Accept this change and auto-accept all future writes",
        decision: "accept-always",
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: "Accept with options",
      placeHolder: "Choose scope for auto-acceptance",
      ignoreFocusOut: true,
    });

    if (picked) {
      resolveCurrentDiff(picked.decision);
    }
  });
}

// Per-path mutex to prevent concurrent edits to the same file
const pathLocks = new Map<string, Promise<void>>();
const LOCK_TIMEOUT = 60_000; // 60 seconds

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = pathLocks.get(filePath);

  // Create a deferred to control the lock
  let releaseLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  pathLocks.set(filePath, lockPromise);

  // Wait for existing lock with timeout
  if (existing) {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`Lock timeout: another edit to ${filePath} is pending`),
          ),
        LOCK_TIMEOUT,
      ),
    );
    try {
      await Promise.race([existing, timeout]);
    } catch (err) {
      pathLocks.delete(filePath);
      throw err;
    }
  }

  try {
    return await fn();
  } finally {
    releaseLock!();
    if (pathLocks.get(filePath) === lockPromise) {
      pathLocks.delete(filePath);
    }
  }
}

export interface DiffResult {
  status: "accepted" | "rejected";
  path: string;
  operation?: "created" | "modified";
  user_edits?: string;
  format_on_save?: boolean;
  new_diagnostics?: string;
  finalContent?: string;
  reason?: string;
  follow_up?: string;
}

export class DiffViewProvider {
  private originalContent: string | undefined;
  private newContent: string | undefined;
  private relPath: string | undefined;
  private absolutePath: string | undefined;
  private activeDiffEditor: vscode.TextEditor | undefined;
  private preDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [];
  private editType: "create" | "modify" | undefined;
  private createdDirs: string[] = [];
  private documentWasOpen = false;
  private diagnosticDelay: number;
  private outsideWorkspace = false;

  /** Populated when the approval panel is used for write decisions */
  writeApprovalResponse?: WriteApprovalResponse;

  constructor(diagnosticDelay?: number) {
    this.diagnosticDelay = diagnosticDelay ?? 1500;
  }

  async open(
    absolutePath: string,
    relPath: string,
    newContent: string,
    options?: { outsideWorkspace?: boolean },
  ): Promise<void> {
    this.outsideWorkspace = options?.outsideWorkspace ?? false;
    this.relPath = relPath;
    this.newContent = newContent;
    this.absolutePath = absolutePath;

    // Determine create vs modify
    let fileExists = false;
    try {
      await fs.access(this.absolutePath);
      fileExists = true;
    } catch {
      fileExists = false;
    }
    this.editType = fileExists ? "modify" : "create";

    // Save dirty document if file exists
    if (fileExists) {
      const existingDoc = vscode.workspace.textDocuments.find(
        (doc) =>
          doc.uri.scheme === "file" && doc.uri.fsPath === this.absolutePath,
      );
      if (existingDoc?.isDirty) {
        await existingDoc.save();
      }
    }

    // Capture pre-edit diagnostics
    this.preDiagnostics = vscode.languages.getDiagnostics();

    // Read original content
    if (fileExists) {
      this.originalContent = await fs.readFile(this.absolutePath, "utf-8");
    } else {
      this.originalContent = "";
    }

    // Create directories for new files
    if (!fileExists) {
      this.createdDirs = await createDirectoriesForFile(this.absolutePath);
      await fs.writeFile(this.absolutePath, "");
    }

    // Close existing tabs showing this file
    this.documentWasOpen = false;
    const tabs = vscode.window.tabGroups.all
      .flatMap((tg) => tg.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.scheme === "file" &&
          tab.input.uri.fsPath === this.absolutePath,
      );

    for (const tab of tabs) {
      this.documentWasOpen = true;
      if (!tab.isDirty) {
        await vscode.window.tabGroups.close(tab);
      }
    }

    // Open diff view
    const fileName = path.basename(this.absolutePath);
    const leftUri = vscode.Uri.parse(
      `${DIFF_VIEW_URI_SCHEME}:${fileName}`,
    ).with({
      query: Buffer.from(this.originalContent).toString("base64"),
    });
    const rightUri = vscode.Uri.file(this.absolutePath);

    const outsidePrefix = this.outsideWorkspace
      ? "\u26a0 OUTSIDE WORKSPACE: "
      : "";
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${outsidePrefix}${this.relPath}: ${fileExists ? "Proposed Changes" : "New File"} (Editable)`,
      { preview: true, preserveFocus: true },
    );

    // Wait for the diff editor to open
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // Find the diff editor
    this.activeDiffEditor = vscode.window.visibleTextEditors.find(
      (editor) =>
        editor.document.uri.scheme === "file" &&
        editor.document.uri.fsPath === this.absolutePath,
    );

    if (!this.activeDiffEditor) {
      // Fallback: open the file and try again
      const doc = await vscode.workspace.openTextDocument(this.absolutePath);
      this.activeDiffEditor = await vscode.window.showTextDocument(doc, {
        preserveFocus: true,
      });
    }

    // Apply new content to the right side
    const document = this.activeDiffEditor.document;
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
    edit.replace(document.uri, fullRange, newContent);
    await vscode.workspace.applyEdit(edit);

    // Scroll to the first change
    const firstChangeLine = findFirstChangeLine(
      this.originalContent,
      newContent,
    );
    if (firstChangeLine >= 0) {
      const range = new vscode.Range(firstChangeLine, 0, firstChangeLine, 0);
      this.activeDiffEditor.revealRange(
        range,
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
    }
  }

  async waitForUserDecision(
    approvalPanel?: ApprovalPanelProvider,
  ): Promise<DiffDecision> {
    // Show toolbar buttons via context key
    await vscode.commands.executeCommand(
      "setContext",
      "agentLink.diffPending",
      true,
    );

    // Track UI elements for cleanup — when the decision comes from outside
    // the panel/QuickPick (title bar buttons, editor close), the UI
    // must still be disposed to avoid orphaned state.
    let disposeUI: (() => void) | undefined;

    try {
      return await new Promise<DiffDecision>((resolve) => {
        let resolved = false;

        const finish = (decision: DiffDecision) => {
          if (resolved) return;
          resolved = true;
          pendingDecisionResolve = null;
          editorCloseDisposable.dispose();
          try {
            disposeUI?.();
          } catch {
            // Ensure resolve() always runs even if UI cleanup throws
          }
          resolve(decision);
        };

        // Allow editor title bar commands to resolve this decision
        pendingDecisionResolve = finish;

        // Listen for diff tab being closed (treat as rejection).
        const editorCloseDisposable = vscode.window.tabGroups.onDidChangeTabs(
          (e) => {
            if (resolved) return;
            if (e.closed.length === 0) return;
            const diffStillOpen = vscode.window.tabGroups.all
              .flatMap((tg) => tg.tabs)
              .some((tab) => {
                if (tab.input instanceof vscode.TabInputTextDiff) {
                  return tab.input.modified.fsPath === this.absolutePath;
                }
                return false;
              });
            if (!diffStillOpen) {
              finish("reject");
            }
          },
        );

        if (approvalPanel) {
          // ── Approval panel mode ────────────────────────────────────────
          const { promise: panelPromise, id: approvalId } =
            approvalPanel.enqueueWriteApproval(this.relPath!, {
              operation: this.editType!,
              outsideWorkspace: this.outsideWorkspace,
            });

          // If title bar or editor close resolves first, cancel the panel entry
          disposeUI = () => {
            approvalPanel.cancelApproval(approvalId);
          };

          // When panel resolves, store the rich response and map to DiffDecision
          panelPromise.then((response) => {
            if (resolved) return; // title bar or editor close already resolved
            this.writeApprovalResponse = response;
            const decisionMap: Record<string, DiffDecision> = {
              accept: "accept",
              reject: "reject",
              "accept-session": "accept-session",
              "accept-project": "accept-project",
              "accept-always": "accept-always",
            };
            finish(decisionMap[response.decision] ?? "reject");
          });
        } else {
          // ── QuickPick fallback ─────────────────────────────────────────
          const action = this.editType === "create" ? "create" : "modify";
          const outsideWarning = this.outsideWorkspace
            ? " [OUTSIDE WORKSPACE]"
            : "";
          type WriteItem = vscode.QuickPickItem & {
            decision: DiffDecision | "review";
          };
          const writeItems: WriteItem[] = [
            {
              label: "$(eye) Review",
              description: "Dismiss this and review the diff in the editor",
              decision: "review",
              alwaysShow: true,
            },
            {
              label: "$(check) Accept",
              description: "Save this file change",
              decision: "accept",
              alwaysShow: true,
            },
            {
              label: "$(check) For Session",
              description: "Auto-accept writes this session",
              decision: "accept-session",
              alwaysShow: true,
            },
            {
              label: "$(folder) For Project",
              description: "Auto-accept writes for this project",
              decision: "accept-project",
              alwaysShow: true,
            },
            {
              label: "$(globe) Always",
              description: "Auto-accept writes globally",
              decision: "accept-always",
              alwaysShow: true,
            },
            {
              label: "$(close) Reject",
              description: "Discard this change",
              decision: "reject",
              alwaysShow: true,
            },
          ];
          const showApproval = () => {
            enqueueApproval(
              "Write approval",
              () =>
                new Promise<void>((releaseQueue) => {
                  if (resolved) {
                    releaseQueue();
                    return;
                  }

                  let queueReleased = false;
                  const releaseOnce = () => {
                    if (queueReleased) return;
                    queueReleased = true;
                    releaseQueue();
                  };

                  const alert = showApprovalAlert(
                    `Write approval: ${this.relPath}`,
                  );
                  const qp = vscode.window.createQuickPick<WriteItem>();
                  qp.title = `${action}: ${this.relPath}${outsideWarning}`;
                  qp.placeholder =
                    "Review the diff in the editor. You can edit the right side before accepting.";
                  qp.items = writeItems;
                  qp.activeItems = [];
                  qp.ignoreFocusOut = true;

                  disposeUI = () => {
                    alert.dispose();
                    qp.dispose();
                    releaseOnce();
                  };

                  qp.onDidAccept(() => {
                    const selected = qp.selectedItems[0];
                    if (!selected) return;
                    disposeUI?.();
                    disposeUI = undefined;
                    if (resolved) return;
                    if (selected.decision === "review") return;
                    finish(selected.decision);
                  });
                  qp.onDidHide(() => {
                    disposeUI?.();
                    disposeUI = undefined;
                  });
                  qp.show();
                  qp.activeItems = [];
                }),
            );
          };
          showApproval();
        }
      });
    } finally {
      disposeUI?.();
      await vscode.commands.executeCommand(
        "setContext",
        "agentLink.diffPending",
        false,
      );
    }
  }

  async saveChanges(): Promise<DiffResult> {
    if (!this.relPath || !this.newContent || !this.activeDiffEditor) {
      return { status: "accepted", path: this.relPath ?? "" };
    }

    const document = this.activeDiffEditor.document;
    const editedContent = document.getText();

    // Save document (triggers format-on-save, etc.)
    if (document.isDirty) {
      await document.save();
    }

    // Show file in normal editor (not diff)
    await vscode.window.showTextDocument(vscode.Uri.file(this.absolutePath!), {
      preview: false,
      preserveFocus: true,
    });

    // Close diff views
    await this.closeAllDiffViews();

    // Wait for diagnostics (event-driven with timeout fallback)
    const newProblems = await this.waitForDiagnostics();

    // Re-read the saved file to get the final content after format-on-save
    const finalContent = await fs.readFile(this.absolutePath!, "utf-8");

    // Separate user edits from format-on-save changes:
    // - editedContent = what was in the editor when user accepted (proposed + user edits)
    // - finalContent  = what ended up on disk after save (+ format-on-save)
    const eol = this.newContent.includes("\r\n") ? "\r\n" : "\n";
    const normalizedEdited = editedContent.replace(/\r\n|\n/g, eol);
    const normalizedFinal = finalContent.replace(/\r\n|\n/g, eol);
    const normalizedNew = this.newContent.replace(/\r\n|\n/g, eol);

    // user_edits = only intentional changes the user made in the diff editor
    let userEdits: string | undefined;
    if (normalizedEdited !== normalizedNew) {
      userEdits = diffLib.createPatch(
        this.relPath,
        normalizedNew,
        normalizedEdited,
        "proposed",
        "user-edited",
        { context: 1 },
      );
    }

    // Detect if format-on-save changed the file beyond user edits
    const formatOnSave = normalizedFinal !== normalizedEdited;

    const result: DiffResult = {
      status: "accepted",
      path: this.relPath,
      operation: this.editType === "create" ? "created" : "modified",
      finalContent,
    };

    if (userEdits) {
      result.user_edits = userEdits;
    }
    if (formatOnSave) {
      result.format_on_save = true;
    }
    if (newProblems) {
      result.new_diagnostics = newProblems;
    }
    if (this.writeApprovalResponse?.followUp) {
      result.follow_up = this.writeApprovalResponse.followUp;
    }

    return result;
  }

  async revertChanges(reason?: string): Promise<DiffResult> {
    if (!this.absolutePath || !this.relPath) {
      return {
        status: "rejected",
        path: this.relPath ?? "",
        ...(reason && { reason }),
      };
    }

    // Revert the in-memory document to match disk state before closing,
    // so VS Code doesn't prompt "Do you want to save?"
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === "file" && d.uri.fsPath === this.absolutePath,
    );
    if (doc?.isDirty) {
      const diskContent =
        this.editType === "modify" ? (this.originalContent ?? "") : "";
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
      edit.replace(doc.uri, fullRange, diskContent);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    }

    // Close diff views — document is clean now, no save prompt
    await this.closeAllDiffViews();

    if (this.editType === "modify") {
      // File on disk already has original content (saved back above)
      if (this.documentWasOpen) {
        const openDoc = await vscode.workspace.openTextDocument(
          this.absolutePath,
        );
        await vscode.window.showTextDocument(openDoc, { preserveFocus: true });
      }
    } else if (this.editType === "create") {
      // Delete the file we created
      try {
        await fs.unlink(this.absolutePath);
      } catch {
        // ignore
      }
      // Remove created directories in reverse order
      for (const dir of this.createdDirs.reverse()) {
        try {
          await fs.rmdir(dir);
        } catch {
          break; // Directory not empty or doesn't exist
        }
      }
    }

    return {
      status: "rejected",
      path: this.relPath,
      ...(reason && { reason }),
    };
  }

  private async waitForDiagnostics(): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      let debounce: ReturnType<typeof setTimeout> | undefined;

      const settle = () => {
        if (settled) return;
        settled = true;
        if (debounce) clearTimeout(debounce);
        disposable.dispose();
        clearTimeout(timer);

        const postDiagnostics = vscode.languages.getDiagnostics();
        const newProblems = getNewDiagnostics(
          this.preDiagnostics,
          postDiagnostics,
        );

        const errorDiags = newProblems.filter(([, diags]) =>
          diags.some((d) => d.severity === vscode.DiagnosticSeverity.Error),
        );

        if (errorDiags.length === 0) {
          resolve(undefined);
          return;
        }

        const lines: string[] = [];
        for (const [, diags] of errorDiags) {
          for (const diag of diags) {
            if (diag.severity !== vscode.DiagnosticSeverity.Error) continue;
            const line = diag.range.start.line + 1;
            lines.push(`Line ${line}: ${diag.message}`);
          }
        }
        resolve(lines.join("\n"));
      };

      // Listen for diagnostic changes on our file.
      // Debounce: the first event is often the language server clearing stale
      // diagnostics before reanalyzing. Wait for events to stabilize before
      // collecting, so we don't miss errors that arrive in a subsequent event.
      const DEBOUNCE_MS = 300;
      const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
        if (e.uris.some((u) => u.fsPath === this.absolutePath)) {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(settle, DEBOUNCE_MS);
        }
      });

      // Hard timeout fallback
      const timer = setTimeout(settle, this.diagnosticDelay);
    });
  }

  private async closeAllDiffViews(): Promise<void> {
    const tabs = vscode.window.tabGroups.all
      .flatMap((tg) => tg.tabs)
      .filter((tab) => {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          const diffInput = tab.input;
          return (
            diffInput.original.scheme === DIFF_VIEW_URI_SCHEME ||
            diffInput.modified.fsPath === this.absolutePath
          );
        }
        return false;
      });

    for (const tab of tabs) {
      await vscode.window.tabGroups.close(tab);
    }
  }
}

/**
 * Find the first line that differs between original and modified content.
 * Returns -1 if the contents are identical.
 */
function findFirstChangeLine(original: string, modified: string): number {
  const origLines = original.split("\n");
  const modLines = modified.split("\n");
  const maxLines = Math.max(origLines.length, modLines.length);
  for (let i = 0; i < maxLines; i++) {
    if (origLines[i] !== modLines[i]) {
      return i;
    }
  }
  return -1;
}

/**
 * Create directories for a file path and return list of created dirs.
 */
async function createDirectoriesForFile(filePath: string): Promise<string[]> {
  const dir = path.dirname(filePath);
  const created: string[] = [];

  // Walk up to find first existing directory
  const parts: string[] = [];
  let current = dir;
  while (current !== path.dirname(current)) {
    try {
      await fs.access(current);
      break;
    } catch {
      parts.unshift(current);
      current = path.dirname(current);
    }
  }

  // Create directories
  for (const dirPath of parts) {
    try {
      await fs.mkdir(dirPath);
      created.push(dirPath);
    } catch {
      // Already exists (race condition)
    }
  }

  return created;
}

/**
 * Compare two sets of diagnostics and return only new ones.
 * Adapted from Roo Code's diagnostics integration.
 */
function getNewDiagnostics(
  oldDiags: [vscode.Uri, vscode.Diagnostic[]][],
  newDiags: [vscode.Uri, vscode.Diagnostic[]][],
): [vscode.Uri, vscode.Diagnostic[]][] {
  const oldMap = new Map<string, vscode.Diagnostic[]>();
  for (const [uri, diags] of oldDiags) {
    oldMap.set(uri.toString(), diags);
  }

  const result: [vscode.Uri, vscode.Diagnostic[]][] = [];

  for (const [uri, diags] of newDiags) {
    const oldFileDiags = oldMap.get(uri.toString()) ?? [];
    const newFileDiags = diags.filter(
      (newDiag) =>
        !oldFileDiags.some(
          (oldDiag) =>
            oldDiag.message === newDiag.message &&
            oldDiag.range.start.line === newDiag.range.start.line &&
            oldDiag.severity === newDiag.severity,
        ),
    );
    if (newFileDiags.length > 0) {
      result.push([uri, newFileDiags]);
    }
  }

  return result;
}

/**
 * Standalone diagnostic collection for auto-approved writes.
 * Snapshots diagnostics before a write and eagerly registers the
 * onDidChangeDiagnostics listener so no events are missed during
 * the write/open/sync sequence. Call collectNewErrors() after the
 * write to wait for results.
 *
 * Usage:
 *   const snap = snapshotDiagnostics(filePath);
 *   // ... perform the write, open document, etc. ...
 *   const diagnostics = await snap.collectNewErrors(delay);
 */
export function snapshotDiagnostics(filePath: string): {
  collectNewErrors: (delayMs: number) => Promise<string | undefined>;
} {
  const preDiagnostics = vscode.languages.getDiagnostics();

  // Track diagnostic events eagerly — before the write happens —
  // so we never miss events that fire during write/open/sync.
  let gotEvent = false;
  const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
    if (e.uris.some((u) => u.fsPath === filePath)) {
      gotEvent = true;
    }
  });

  return {
    collectNewErrors(delayMs: number): Promise<string | undefined> {
      return new Promise<string | undefined>((resolve) => {
        let settled = false;
        let debounce: ReturnType<typeof setTimeout> | undefined;

        const settle = () => {
          if (settled) return;
          settled = true;
          if (debounce) clearTimeout(debounce);
          lateDisposable.dispose();
          disposable.dispose();
          clearTimeout(timer);

          const postDiagnostics = vscode.languages.getDiagnostics();
          const newProblems = getNewDiagnostics(
            preDiagnostics,
            postDiagnostics,
          );

          const errorDiags = newProblems.filter(([, diags]) =>
            diags.some((d) => d.severity === vscode.DiagnosticSeverity.Error),
          );

          if (errorDiags.length === 0) {
            resolve(undefined);
            return;
          }

          const lines: string[] = [];
          for (const [, diags] of errorDiags) {
            for (const diag of diags) {
              if (diag.severity !== vscode.DiagnosticSeverity.Error) continue;
              const line = diag.range.start.line + 1;
              lines.push(`Line ${line}: ${diag.message}`);
            }
          }
          resolve(lines.join("\n"));
        };

        // If we already received events before collectNewErrors was called,
        // start the debounce immediately so we settle soon.
        const DEBOUNCE_MS = 300;
        if (gotEvent) {
          debounce = setTimeout(settle, DEBOUNCE_MS);
        }

        // Continue listening for new events with debounce
        const lateDisposable = vscode.languages.onDidChangeDiagnostics((e) => {
          if (e.uris.some((u) => u.fsPath === filePath)) {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(settle, DEBOUNCE_MS);
          }
        });

        // Hard timeout fallback
        const timer = setTimeout(settle, delayMs);
      });
    },
  };
}
