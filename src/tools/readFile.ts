import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as syncFs from "fs";

import {
  resolveAndValidatePath,
  isBinaryFile,
  tryGetFirstWorkspaceRoot,
} from "../util/paths.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { approveOutsideWorkspaceAccess } from "./pathAccessUI.js";
import { SYMBOL_KIND_NAMES } from "./languageFeatures.js";
import { Semaphore } from "../util/Semaphore.js";

import { type ToolResult } from "../shared/types.js";
import { semanticFileQuery } from "../services/semanticSearch.js";

// --- Image support ---

/** Only types accepted by the Anthropic Messages API (image content blocks). */
const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

// --- Concurrency control ---
// Concurrent read_file calls can overwhelm VS Code's language server
// (symbol outline requests are single-threaded). Limit concurrency to
// prevent hangs when Claude reads many large files in parallel.
const READ_CONCURRENCY = 5;
const SYMBOL_TIMEOUT_MS = 5_000; // 5 seconds

const readSemaphore = new Semaphore(READ_CONCURRENCY);

// --- Language detection ---

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".jsonc": "jsonc",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".r": "r",
  ".R": "r",
  ".lua": "lua",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".fish": "shellscript",
  ".ps1": "powershell",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".vue": "vue",
  ".svelte": "svelte",
  ".md": "markdown",
  ".mdx": "mdx",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".dockerfile": "dockerfile",
  ".docker": "dockerfile",
  ".tf": "terraform",
  ".hcl": "terraform",
  ".proto": "proto3",
  ".zig": "zig",
  ".dart": "dart",
  ".elm": "elm",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".scala": "scala",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".nim": "nim",
  ".v": "v",
  ".sol": "solidity",
  ".mod": "go.mod",
  ".sum": "go.sum",
  ".work": "go.work",
  ".lock": "plaintext",
  ".env": "dotenv",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "properties",
  ".properties": "properties",
  ".makefile": "makefile",
  ".cmake": "cmake",
  ".bat": "bat",
  ".cmd": "bat",
};

function detectLanguage(filePath: string): string | undefined {
  // Check already-open documents first (zero cost, exact language ID)
  const openDoc = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.scheme === "file" && doc.uri.fsPath === filePath,
  );
  if (openDoc) {
    return openDoc.languageId;
  }

  // Fall back to extension map
  const ext = path.extname(filePath).toLowerCase();
  // Handle Dockerfile (no extension)
  if (path.basename(filePath).toLowerCase() === "dockerfile") {
    return "dockerfile";
  }
  return EXTENSION_LANGUAGE_MAP[ext];
}

// --- Git status ---

// Minimal inline types for VS Code's built-in git extension API
interface GitChange {
  uri: vscode.Uri;
  status: number;
}
interface GitRepository {
  state: {
    indexChanges: GitChange[];
    workingTreeChanges: GitChange[];
    untrackedChanges?: GitChange[];
  };
  rootUri: vscode.Uri;
}
interface GitAPI {
  repositories: GitRepository[];
}
interface GitExtension {
  getAPI(version: 1): GitAPI;
}

function getGitStatus(filePath: string): string | undefined {
  try {
    const gitExtension =
      vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!gitExtension?.isActive) return undefined;

    const api = gitExtension.exports.getAPI(1);

    // Find the repo that contains this file
    for (const repo of api.repositories) {
      const repoRoot = repo.rootUri.fsPath;
      if (!filePath.startsWith(repoRoot)) continue;

      // Check staged (index) changes
      if (repo.state.indexChanges.some((c) => c.uri.fsPath === filePath)) {
        return "staged";
      }

      // Check working tree changes (modified)
      if (
        repo.state.workingTreeChanges.some((c) => c.uri.fsPath === filePath)
      ) {
        return "modified";
      }

      // Check untracked
      if (repo.state.untrackedChanges?.some((c) => c.uri.fsPath === filePath)) {
        return "untracked";
      }

      // File is in a repo but not changed
      return "clean";
    }

    return undefined; // Not in any git repo
  } catch {
    return undefined;
  }
}

// --- Diagnostics summary ---

function getDiagnosticsSummary(
  filePath: string,
): { errors: number; warnings: number } | undefined {
  try {
    const uri = vscode.Uri.file(filePath);
    const diags = vscode.languages.getDiagnostics(uri);
    if (diags.length === 0) return undefined;

    let errors = 0;
    let warnings = 0;
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
    }
    return { errors, warnings };
  } catch {
    return undefined;
  }
}

// --- Symbol outline ---

// Symbol kinds that are containers — recurse one level to show their children
const CONTAINER_KINDS = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Module,
]);

type SymbolOutlineResult =
  | { symbols: Record<string, string[]> }
  | { timedOut: true }
  | undefined;

async function getSymbolOutline(
  filePath: string,
): Promise<SymbolOutlineResult> {
  try {
    const uri = vscode.Uri.file(filePath);
    const TIMED_OUT = Symbol("timeout");
    const symbols = await Promise.race([
      vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      ),
      new Promise<typeof TIMED_OUT>((resolve) =>
        setTimeout(() => resolve(TIMED_OUT), SYMBOL_TIMEOUT_MS),
      ),
    ]);

    if (symbols === TIMED_OUT) return { timedOut: true };
    if (!symbols || symbols.length === 0) return undefined;

    // Group by kind for token efficiency — avoids repeating "method" 100+ times
    const grouped: Record<string, string[]> = {};
    for (const s of symbols) {
      const kind = SYMBOL_KIND_NAMES[s.kind] ?? "symbol";
      const line = s.range.start.line + 1;
      if (!grouped[kind]) grouped[kind] = [];
      grouped[kind].push(`${s.name} (line ${line})`);

      // Recurse one level into container symbols (class → methods, etc.)
      if (CONTAINER_KINDS.has(s.kind) && s.children?.length) {
        for (const child of s.children) {
          const childKind = SYMBOL_KIND_NAMES[child.kind] ?? "symbol";
          const childLine = child.range.start.line + 1;
          if (!grouped[childKind]) grouped[childKind] = [];
          grouped[childKind].push(
            `${s.name}.${child.name} (line ${childLine})`,
          );
        }
      }
    }
    return { symbols: grouped };
  } catch {
    return undefined;
  }
}

// --- Friendly errors ---

export function findLikelyPathSuggestions(
  inputPath: string,
  limit = 5,
): string[] {
  const workspaceRoot = tryGetFirstWorkspaceRoot();
  if (!workspaceRoot) return [];

  const normalizedInput = inputPath.replace(/\\/g, "/");
  const basename = path.posix.basename(normalizedInput);
  const suffix = normalizedInput.startsWith("./")
    ? normalizedInput.slice(2)
    : normalizedInput;
  const suggestions = new Set<string>();
  const stack = [workspaceRoot];

  while (stack.length > 0 && suggestions.size < limit) {
    const current = stack.pop()!;
    let entries: syncFs.Dirent[];
    try {
      entries = syncFs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (suggestions.size >= limit) break;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const relPath = path
        .relative(workspaceRoot, fullPath)
        .replace(/\\/g, "/");
      if (
        relPath === suffix ||
        relPath.endsWith(`/${suffix}`) ||
        entry.name === basename
      ) {
        suggestions.add(relPath);
      }
    }
  }

  return [...suggestions];
}

export function buildReadFileError(
  err: unknown,
  inputPath: string,
): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { error: String(err), path: inputPath };
  }

  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case "ENOENT": {
      const workspaceRoot = tryGetFirstWorkspaceRoot();
      const suggestions = findLikelyPathSuggestions(inputPath);
      return {
        error: `File not found: ${inputPath}. Working directory: ${workspaceRoot ?? "(no workspace)"}`,
        path: inputPath,
        ...(suggestions.length > 0 && { suggestions }),
      };
    }
    case "EACCES":
      return { error: `Permission denied: ${inputPath}`, path: inputPath };
    case "EISDIR":
      return {
        error: `${inputPath} is a directory. Use list_files instead.`,
        path: inputPath,
      };
    default:
      return { error: err.message, path: inputPath };
  }
}

// --- Main handler ---

export function isEnoentWithSingleSuggestion(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & {
  suggestions: [string];
  path: string;
  error: string;
} {
  if (!payload || typeof payload !== "object") return false;
  const suggestions = payload.suggestions;
  return (
    Array.isArray(suggestions) &&
    suggestions.length === 1 &&
    typeof suggestions[0] === "string" &&
    typeof payload.path === "string" &&
    typeof payload.error === "string"
  );
}

export async function handleReadFile(
  params: {
    path: string;
    offset?: number;
    limit?: number;
    include_symbols?: boolean;
    query?: string;
    anchor?: string;
    anchor_regex?: string;
    anchor_offset?: number;
    auto_follow_suggestion?: boolean;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
): Promise<ToolResult> {
  const release = await readSemaphore.acquire();
  let released = false;
  try {
    const { absolutePath: filePath, inWorkspace } = resolveAndValidatePath(
      params.path,
    );

    // Outside-workspace gate — agentlink tmp artifacts (truncated tool results)
    // are always readable without approval since we wrote them ourselves.
    const isTmpArtifact = filePath.startsWith("/tmp/agentlink-results/");
    if (
      !inWorkspace &&
      !isTmpArtifact &&
      !approvalManager.isPathTrusted(sessionId, filePath)
    ) {
      const { approved, reason } = await approveOutsideWorkspaceAccess(
        filePath,
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

    if (isBinaryFile(filePath)) {
      // Check if it's an image we can return as image content
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = IMAGE_EXTENSIONS[ext];

      if (mimeType) {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_IMAGE_SIZE) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Image too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Max: ${MAX_IMAGE_SIZE / 1024 / 1024} MB`,
                  path: params.path,
                }),
              },
            ],
          };
        }
        const data = await fs.readFile(filePath);
        return {
          content: [
            {
              type: "image",
              data: data.toString("base64"),
              mimeType,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Binary file detected",
              path: params.path,
            }),
          },
        ],
      };
    }

    // Read file and stat in parallel
    const [raw, stat] = await Promise.all([
      fs.readFile(filePath, "utf-8"),
      fs.stat(filePath),
    ]);

    const allLines = raw.split("\n");
    const totalLines = allLines.length;

    let anchorHit:
      | {
          mode: "literal" | "regex";
          pattern: string;
          line: number;
        }
      | undefined;

    if (params.anchor && params.anchor_regex) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error:
                "Specify only one of 'anchor' or 'anchor_regex' (not both).",
              path: params.path,
            }),
          },
        ],
      };
    }

    if (params.anchor_regex && params.offset == null) {
      let anchorRegex: RegExp;
      try {
        anchorRegex = new RegExp(params.anchor_regex, "m");
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Invalid anchor_regex: ${err instanceof Error ? err.message : String(err)}`,
                path: params.path,
              }),
            },
          ],
        };
      }

      const match = raw.match(anchorRegex);
      if (match && match.index != null) {
        const prefix = raw.slice(0, match.index);
        const line = prefix.split("\n").length;
        anchorHit = {
          mode: "regex",
          pattern: params.anchor_regex,
          line,
        };
      }
    } else if (params.anchor && params.offset == null) {
      const idx = raw.indexOf(params.anchor);
      if (idx >= 0) {
        const prefix = raw.slice(0, idx);
        const line = prefix.split("\n").length;
        anchorHit = {
          mode: "literal",
          pattern: params.anchor,
          line,
        };
      }
    }

    // Semantic offset: when query is provided and no explicit/manual anchor,
    // use the index to jump to the most relevant section of the file.
    let semanticHit: { startLine: number; endLine: number } | null = null;
    if (params.query && params.offset == null && !anchorHit) {
      const wsRoot = tryGetFirstWorkspaceRoot();
      if (wsRoot) {
        const relPath = path.relative(wsRoot, filePath);
        semanticHit = await semanticFileQuery(relPath, params.query);
      }
    }

    const baseOffset = anchorHit
      ? anchorHit.line
      : semanticHit
        ? Math.max(1, semanticHit.startLine - 5) // 5 lines of context before the semantic match
        : Math.max(1, params.offset ?? 1);
    const shouldApplyAnchorOffset =
      params.offset == null && !!(anchorHit || semanticHit);
    const anchorOffset =
      shouldApplyAnchorOffset && Number.isFinite(params.anchor_offset)
        ? Math.trunc(params.anchor_offset as number)
        : 0;
    const offset = Math.max(1, baseOffset + anchorOffset);

    if (offset > totalLines) {
      const emptyResult: Record<string, unknown> = {
        total_lines: totalLines,
        showing: "0-0",
        content: "",
        path: params.path,
      };
      emptyResult.size = stat.size;
      emptyResult.modified = stat.mtime.toISOString();
      const gitStatus = getGitStatus(filePath);
      if (gitStatus) emptyResult.git_status = gitStatus;
      emptyResult.language = detectLanguage(filePath);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(emptyResult) }],
      };
    }

    const defaultLimit = 2000;
    const rawLimit = params.limit ?? defaultLimit;
    if (rawLimit <= 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Invalid limit: ${rawLimit}. Must be a positive number.`,
              path: params.path,
            }),
          },
        ],
      };
    }
    const limit = Math.min(rawLimit, totalLines - offset + 1);

    const lines = allLines.slice(offset - 1, offset - 1 + limit);

    const numbered = lines
      .map((line, i) => {
        const lineNum = offset + i;
        return `${lineNum} | ${line}`;
      })
      .join("\n");

    // Build response with metadata first, content last
    const result: Record<string, unknown> = {
      total_lines: totalLines,
      showing: `${offset}-${offset + lines.length - 1}`,
    };

    // Truncation info — always set when not all lines are shown
    const showingAll = offset === 1 && lines.length === totalLines;
    if (!showingAll) {
      result.truncated = true;
    }

    if (anchorHit) {
      result.anchor_match = {
        mode: anchorHit.mode,
        pattern: anchorHit.pattern,
        line: anchorHit.line,
        anchor_offset: Number.isFinite(params.anchor_offset)
          ? Math.trunc(params.anchor_offset as number)
          : 0,
      };
    } else if (
      (params.anchor || params.anchor_regex) &&
      params.offset == null
    ) {
      result.anchor_match = {
        status: "not_found",
        ...(params.anchor && { mode: "literal", pattern: params.anchor }),
        ...(params.anchor_regex && {
          mode: "regex",
          pattern: params.anchor_regex,
        }),
      };
    }

    // Semantic match info
    if (semanticHit) {
      result.semantic_match = {
        query: params.query,
        startLine: semanticHit.startLine,
        endLine: semanticHit.endLine,
      };
    }

    // File metadata
    result.size = stat.size;
    result.modified = stat.mtime.toISOString();

    // Git status
    const gitStatus = getGitStatus(filePath);
    if (gitStatus) result.git_status = gitStatus;

    // Detect language early so we can use it for symbol filtering
    const language = detectLanguage(filePath);

    // Symbol outline runs first — it opens the document, which triggers the
    // language server. This makes accurate language detection and diagnostics
    // available as a side effect.
    // Skip symbols for JSON/JSONC — every key becomes a "symbol" which is noisy
    const isDataFile = language === "json" || language === "jsonc";
    if (params.include_symbols !== false && !isDataFile) {
      const symbolResult = await getSymbolOutline(filePath);
      if (symbolResult && "symbols" in symbolResult) {
        result.symbols = symbolResult.symbols;
      } else if (symbolResult && "timedOut" in symbolResult) {
        result.symbols_note =
          "Symbol outline timed out — language server may be busy";
      }
    }

    if (language) result.language = language;

    // Diagnostics — check after symbols so the language server has analyzed the file
    const diagSummary = getDiagnosticsSummary(filePath);
    if (diagSummary) result.diagnostics = diagSummary;

    // Content last so metadata is visible at the top
    result.content = numbered;

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const errorPayload = buildReadFileError(err, params.path);

    if (
      params.auto_follow_suggestion &&
      isEnoentWithSingleSuggestion(errorPayload)
    ) {
      const [suggestedPath] = errorPayload.suggestions;
      // Release this call's permit before recursively following the suggestion;
      // otherwise concurrent follow-ups can deadlock by double-acquiring.
      release();
      released = true;
      return handleReadFile(
        {
          ...params,
          path: suggestedPath,
          auto_follow_suggestion: false,
        },
        approvalManager,
        approvalPanel,
        sessionId,
      ).then((followed) => {
        const item = followed.content[0];
        if (item?.type !== "text") {
          return followed;
        }
        try {
          const parsed = JSON.parse(item.text) as Record<string, unknown>;
          parsed.resolution = "auto_followed_suggestion";
          parsed.auto_followed_from = errorPayload.path;
          parsed.resolved_path = suggestedPath;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(parsed, null, 2),
              },
            ],
          };
        } catch {
          return followed;
        }
      });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(errorPayload),
        },
      ],
    };
  } finally {
    if (!released) {
      release();
    }
  }
}
