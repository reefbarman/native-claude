/**
 * Pure/testable utility functions used by the indexer worker.
 * Extracted here so they can be unit-tested without triggering
 * the worker's IPC side effects.
 *
 * IMPORTANT: No `vscode` imports — must work in the child process.
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { IndexCache, CachedFileEntry } from "./types.js";

// --- Constants ---

export const MAX_FILE_SIZE = 1_000_000; // 1MB

/**
 * File extensions worth indexing. Files not matching these are skipped
 * to avoid noise from lock files, binaries-without-nulls, CSVs, etc.
 */
export const INDEXABLE_EXTENSIONS = new Set([
  // Tree-sitter supported
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cxx",
  ".cs",
  ".rb",
  ".php",
  ".css",
  ".scss",
  ".sh",
  ".bash",
  ".ps1",
  // Markdown
  ".md",
  ".mdx",
  ".markdown",
  // Config/data
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".htm",
  // Other common code
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
  ".tf",
  ".hcl",
  ".svelte",
  ".vue",
  ".astro",
  ".lua",
  ".kt",
  ".kts",
  ".ex",
  ".exs",
  ".elm",
  ".zig",
  ".scala",
  ".swift",
  ".vb",
]);

// --- Binary detection ---

/**
 * Returns true if the content appears to be binary (contains null bytes
 * in the first 512 characters).
 */
export function isBinaryContent(content: string): boolean {
  return content.slice(0, 512).includes("\0");
}

// --- Path segments ---

/**
 * Build a Qdrant-compatible pathSegments map from a relative file path.
 * e.g. "src/services/Foo.ts" → { "0": "src", "1": "services", "2": "Foo.ts" }
 */
export function buildPathSegments(relPath: string): Record<string, string> {
  const segments = relPath.split("/").filter(Boolean);
  const result: Record<string, string> = {};
  segments.forEach((seg, idx) => {
    result[String(idx)] = seg;
  });
  return result;
}

// --- Cache I/O ---

export function loadCache(cachePath: string): IndexCache {
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as IndexCache;
    if (parsed.version === 1 && parsed.files) return parsed;
  } catch {
    // Missing or corrupt — start fresh
  }
  return { version: 1, files: {} };
}

export function writeCache(cachePath: string, cache: IndexCache): void {
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache), "utf-8");
}

// --- File hashing ---

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// --- Incremental diff ---

export interface DiffResult {
  /** Files that are new or changed (need re-indexing) */
  toIndex: Array<{
    absPath: string;
    relPath: string;
    content: string;
    hash: string;
  }>;
  /** Relative paths of files whose old points should be deleted */
  staleRelPaths: string[];
  /** Non-fatal errors encountered during file reading */
  errors: string[];
}

/** Yield the event loop to avoid CPU saturation */
function yieldEvent(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Given a list of file paths and the current cache, determine which files
 * need indexing, which are stale, and which can be skipped.
 */
export function diffFiles(
  files: string[],
  workspaceRoot: string,
  cache: IndexCache,
): DiffResult {
  const toIndex: DiffResult["toIndex"] = [];
  const errors: string[] = [];
  const currentFiles = new Set<string>();

  for (let fi = 0; fi < files.length; fi++) {
    const absPath = files[fi];
    // Skip paths outside the workspace (e.g. Windows paths on WSL)
    if (!absPath.startsWith(workspaceRoot)) continue;

    const relPath = path.relative(workspaceRoot, absPath);

    // Safety: skip if relative path escapes the workspace
    if (relPath.startsWith("..")) continue;

    currentFiles.add(relPath);

    // Skip files with non-indexable extensions
    const ext = path.extname(absPath).toLowerCase();
    if (ext && !INDEXABLE_EXTENSIONS.has(ext)) continue;

    try {
      const stat = fs.statSync(absPath);
      if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;

      const content = fs.readFileSync(absPath, "utf-8");
      if (isBinaryContent(content)) continue;

      const hash = hashContent(content);

      // Skip if cached and unchanged
      const cached = cache.files[relPath];
      if (cached && cached.hash === hash) continue;

      toIndex.push({ absPath, relPath, content, hash });
    } catch (err) {
      errors.push(`Failed to read ${relPath}: ${err}`);
    }
  }

  // Stale = in cache but either deleted or changed
  const staleRelPaths: string[] = [];
  for (const relPath of Object.keys(cache.files)) {
    if (
      !currentFiles.has(relPath) ||
      toIndex.some((f) => f.relPath === relPath)
    ) {
      staleRelPaths.push(relPath);
    }
  }

  return { toIndex, staleRelPaths, errors };
}

// --- Memory-efficient scan (for large codebases) ---

export interface ScanResult {
  /** Files that need re-indexing (paths only — no content held) */
  toIndexPaths: Array<{ absPath: string; relPath: string }>;
  /** Relative paths of stale files to delete from index */
  staleRelPaths: string[];
  /** Non-fatal errors */
  errors: string[];
}

/**
 * Scan all files to determine which need indexing, without retaining content.
 * Each file is read, hashed, and the content is discarded immediately.
 * This bounds memory to O(1) per file instead of O(total_changed_files).
 */
export async function scanFiles(
  files: string[],
  workspaceRoot: string,
  cache: IndexCache,
  onProgress?: (scanned: number, total: number) => void,
): Promise<ScanResult> {
  const toIndexPaths: ScanResult["toIndexPaths"] = [];
  const errors: string[] = [];
  const currentFiles = new Set<string>();

  for (let fi = 0; fi < files.length; fi++) {
    if (fi > 0 && fi % 50 === 0) {
      await yieldEvent();
      onProgress?.(fi, files.length);
    }
    const absPath = files[fi];
    if (!absPath.startsWith(workspaceRoot)) continue;

    const relPath = path.relative(workspaceRoot, absPath);
    if (relPath.startsWith("..")) continue;

    currentFiles.add(relPath);

    const ext = path.extname(absPath).toLowerCase();
    if (ext && !INDEXABLE_EXTENSIONS.has(ext)) continue;

    try {
      const stat = fs.statSync(absPath);
      if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;

      const content = fs.readFileSync(absPath, "utf-8");
      if (isBinaryContent(content)) continue;

      const hash = hashContent(content);
      // content is not stored — goes out of scope and can be GC'd

      const cached = cache.files[relPath];
      if (cached && cached.hash === hash) continue;

      toIndexPaths.push({ absPath, relPath });
    } catch (err) {
      errors.push(`Failed to scan ${relPath}: ${err}`);
    }
  }

  const staleRelPaths: string[] = [];
  const toIndexRelPaths = new Set(toIndexPaths.map((f) => f.relPath));
  for (const relPath of Object.keys(cache.files)) {
    if (!currentFiles.has(relPath) || toIndexRelPaths.has(relPath)) {
      staleRelPaths.push(relPath);
    }
  }

  return { toIndexPaths, staleRelPaths, errors };
}

export interface FileWithContent {
  absPath: string;
  relPath: string;
  content: string;
  hash: string;
}

/**
 * Read content for a batch of file paths. Used after scanFiles() to
 * load only the files needed for the current processing batch.
 */
export function readFilesBatch(
  paths: Array<{ absPath: string; relPath: string }>,
  errors: string[],
): FileWithContent[] {
  const result: FileWithContent[] = [];
  for (const { absPath, relPath } of paths) {
    try {
      const content = fs.readFileSync(absPath, "utf-8");
      const hash = hashContent(content);
      result.push({ absPath, relPath, content, hash });
    } catch (err) {
      errors.push(`Failed to read ${relPath}: ${err}`);
    }
  }
  return result;
}
