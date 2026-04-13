import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export function getWorkspaceRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }
  return folders.map((f) => f.uri.fsPath);
}

/** Case-insensitive path equality on Windows, case-sensitive elsewhere. */
function pathsEqual(a: string, b: string): boolean {
  if (process.platform === "win32") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/** Check if `child` is inside `parent` directory (case-insensitive on Windows). */
function pathStartsWith(child: string, parent: string): boolean {
  if (process.platform === "win32") {
    return child.toLowerCase().startsWith((parent + path.sep).toLowerCase());
  }
  return child.startsWith(parent + path.sep);
}

export function getFirstWorkspaceRoot(): string {
  const roots = getWorkspaceRoots();
  if (roots.length === 0) {
    throw new Error("No workspace folder open");
  }
  return roots[0];
}

/** Returns the first workspace root, or `undefined` if no workspace is open. */
export function tryGetFirstWorkspaceRoot(): string | undefined {
  const roots = getWorkspaceRoots();
  return roots.length > 0 ? roots[0] : undefined;
}

export interface ResolvedPath {
  absolutePath: string;
  inWorkspace: boolean;
}

/**
 * Resolve a path and check whether it falls within workspace boundaries.
 * For existing files, resolves symlinks via realpath.
 * For new files, validates the parent directory.
 *
 * Returns `{ absolutePath, inWorkspace }` — never throws for outside-workspace paths.
 * Relative paths are resolved against the best-matching workspace root.
 * Throws only if no workspace folder is open and the path is relative.
 */
export function resolveAndValidatePath(inputPath: string): ResolvedPath {
  const roots = getWorkspaceRoots();

  // Resolve relative to workspace root (or treat as absolute)
  let resolved: string;
  if (path.isAbsolute(inputPath)) {
    resolved = path.resolve(inputPath);
  } else if (roots.length > 0) {
    resolved = resolveRelativeToWorkspace(inputPath, roots);
  } else {
    throw new Error("No workspace folder open and path is relative");
  }

  // Try realpath for existing files (resolves symlinks)
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // File doesn't exist — validate parent directory instead
    const parentDir = path.dirname(resolved);
    try {
      real = fs.realpathSync(parentDir);
      real = path.join(real, path.basename(resolved));
    } catch {
      // Parent doesn't exist either — just use resolved path
      real = resolved;
    }
  }

  // Check workspace boundary
  const inWorkspace = roots.some(
    (root) => pathsEqual(real, root) || pathStartsWith(real, root),
  );

  return { absolutePath: real, inWorkspace };
}

/**
 * Get relative path from workspace root.
 */
export function getRelativePath(absolutePath: string): string {
  const roots = getWorkspaceRoots();
  for (const root of roots) {
    if (pathStartsWith(absolutePath, root) || pathsEqual(absolutePath, root)) {
      return path.relative(root, absolutePath).replace(/\\/g, "/");
    }
  }
  return absolutePath;
}

/**
 * Resolve a relative path against the correct workspace root in multi-root workspaces.
 *
 * Strategy:
 * 1. If the path starts with a workspace folder name, resolve against that folder
 * 2. If the file already exists under a specific root, use that root
 * 3. If the parent directory exists under a specific root (new file), use that root
 * 4. Fall back to the first root
 */
function resolveRelativeToWorkspace(
  inputPath: string,
  roots: string[],
): string {
  if (roots.length > 1) {
    const folders = vscode.workspace.workspaceFolders!;

    // Check if path starts with a workspace folder name
    for (const folder of folders) {
      const normalizedInput = inputPath.replace(/\\/g, "/");
      const prefix = folder.name + "/";
      if (normalizedInput.startsWith(prefix)) {
        const subPath = normalizedInput.slice(prefix.length);
        return path.resolve(folder.uri.fsPath, subPath);
      }
      if (inputPath === folder.name) {
        return folder.uri.fsPath;
      }
    }

    // Check if file exists under any root
    for (const root of roots) {
      const candidate = path.resolve(root, inputPath);
      try {
        fs.accessSync(candidate);
        return candidate;
      } catch {
        // doesn't exist here, try next
      }
    }

    // Check if parent directory exists under any root (for new files)
    const parentDir = path.dirname(inputPath);
    if (parentDir !== ".") {
      for (const root of roots) {
        const candidateParent = path.resolve(root, parentDir);
        try {
          fs.accessSync(candidateParent);
          return path.resolve(root, inputPath);
        } catch {
          // doesn't exist here, try next
        }
      }
    }
  }

  // Single root or no match — use first root
  return path.resolve(roots[0], inputPath);
}

/**
 * Check if a file is likely binary by looking for null bytes in the first 8KB.
 */
export function isBinaryFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    fs.closeSync(fd);

    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
