import * as vscode from "vscode";
import * as path from "path";

import { resolveAndValidatePath, getWorkspaceRoots } from "../util/paths.js";

export async function handleGetDiagnostics(params: {
  path?: string;
  severity?: string;
  source?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    let diagnostics: [vscode.Uri, vscode.Diagnostic[]][];

    if (params.path) {
      const { absolutePath: filePath } = resolveAndValidatePath(params.path);
      const uri = vscode.Uri.file(filePath);
      const fileDiags = vscode.languages.getDiagnostics(uri);
      diagnostics = [[uri, fileDiags]];
    } else {
      diagnostics = vscode.languages.getDiagnostics();
    }

    // Apply severity filter
    const severityFilter = params.severity
      ? parseSeverityFilter(params.severity)
      : undefined;

    // Apply source filter
    const sourceFilter = params.source
      ? params.source
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : undefined;

    const results: Array<{
      file: string;
      diagnostics: Array<{
        line: number;
        column: number;
        severity: string;
        message: string;
        source?: string;
        code?: string | number;
      }>;
    }> = [];

    for (const [uri, diags] of diagnostics) {
      const filteredDiags = diags.filter((d) => {
        if (severityFilter && !severityFilter.has(d.severity)) return false;
        if (
          sourceFilter &&
          !sourceFilter.some((s) => d.source?.toLowerCase().includes(s))
        )
          return false;
        return true;
      });

      if (filteredDiags.length === 0) continue;

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const filePath = workspaceRoot
        ? path.relative(workspaceRoot, uri.fsPath)
        : uri.fsPath;

      results.push({
        file: filePath,
        diagnostics: filteredDiags.map((d) => ({
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: severityToString(d.severity),
          message: d.message,
          ...(d.source && { source: d.source }),
          ...(d.code !== undefined && {
            code:
              typeof d.code === "object" && d.code !== null
                ? (d.code as { value: string | number }).value
                : d.code,
          }),
        })),
      });
    }

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: params.path
              ? `No diagnostics found for ${params.path}`
              : "No diagnostics found in workspace",
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
    };
  }
}

const VALID_SEVERITIES = new Set([
  "error",
  "warning",
  "info",
  "information",
  "hint",
]);

function parseSeverityFilter(input: string): Set<vscode.DiagnosticSeverity> {
  const parts = input
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const result = new Set<vscode.DiagnosticSeverity>();
  for (const part of parts) {
    if (!VALID_SEVERITIES.has(part)) continue;
    switch (part) {
      case "error":
        result.add(vscode.DiagnosticSeverity.Error);
        break;
      case "warning":
        result.add(vscode.DiagnosticSeverity.Warning);
        break;
      case "info":
      case "information":
        result.add(vscode.DiagnosticSeverity.Information);
        break;
      case "hint":
        result.add(vscode.DiagnosticSeverity.Hint);
        break;
    }
  }
  return result;
}

function severityToString(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "unknown";
  }
}
