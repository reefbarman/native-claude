/**
 * Extension-side manager for the indexer child process.
 *
 * Handles: file discovery (vscode.workspace.findFiles), forking the worker,
 * IPC message routing, progress reporting, file watching, and lifecycle.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { fork, spawn, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import picomatch from "picomatch";
import { openAiCodexAuthManager } from "../agent/providers/index.js";
import type {
  WorkerToExtensionMessage,
  IndexPhase,
  EmbeddingAuthRefreshRequestMessage,
} from "./types.js";

// --- Public types ---

export type IndexerState = "idle" | "discovering" | "indexing" | "error";

export interface IndexStatus {
  state: IndexerState;
  phase?: IndexPhase;
  current?: number;
  total?: number;
  detail?: string;
  lastCompleted?: {
    filesIndexed: number;
    totalFilesInIndex: number;
    chunksCreated: number;
    totalChunksInIndex: number;
    durationMs: number;
    errorCount?: number;
    cancelled?: boolean;
  };
  error?: string;
}

// --- Constants ---

const WATCHER_DEBOUNCE_MS = 2000;
const MAX_FILE_SIZE = 1_000_000; // 1MB
const DEFAULT_INDEX_EXCLUSIONS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/__pycache__/**",
  "**/target/**",
  "**/.venv/**",
  "**/vendor/**",
  "**/.claude/**",
  "**/.codex/**",
  "**/.agentlink/**",
  "**/.agents/**",
  "**/*.min.js",
  "**/*.map",
];

export class IndexerManager implements vscode.Disposable {
  private worker: ChildProcess | null = null;
  private status: IndexStatus = { state: "idle" };
  private disposables: vscode.Disposable[] = [];
  private cancelRequested = false;

  // File watcher debounce state
  private pendingAdded = new Set<string>();
  private pendingRemoved = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Event emitter for status changes
  private readonly _onStatusChanged = new vscode.EventEmitter<IndexStatus>();
  readonly onStatusChanged = this._onStatusChanged.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalStorageUri: vscode.Uri,
    private readonly log: (msg: string) => void,
  ) {}

  // --- Public API ---

  async startIndexing(force = false): Promise<void> {
    if (
      this.status.state === "indexing" ||
      this.status.state === "discovering"
    ) {
      this.log("Indexing already in progress, ignoring start request");
      return;
    }

    this.cancelRequested = false;
    this.updateStatus({ state: "discovering" });

    try {
      const config = vscode.workspace.getConfiguration("agentlink");
      const qdrantUrl = config.get<string>(
        "qdrantUrl",
        "http://localhost:6333",
      );
      // Pre-flight: check Qdrant is reachable with retry + backoff
      const qdrantReachable = await this.waitForQdrant(qdrantUrl);
      if (!qdrantReachable) {
        if (this.cancelRequested) {
          this.updateStatus({ state: "idle" });
        } else {
          this.updateStatus({
            state: "error",
            error: `Qdrant not reachable at ${qdrantUrl}. Make sure Qdrant is running (e.g. docker run -p 6333:6333 qdrant/qdrant).`,
          });
        }
        return;
      }

      const embeddingBearerToken = await this.getEmbeddingBearerToken();

      if (!embeddingBearerToken) {
        this.updateStatus({
          state: "error",
          error:
            "OpenAI authentication not configured. Run 'AgentLink: Sign In to OpenAI/Codex' to choose ChatGPT/Codex OAuth or an OpenAI API key, or set OPENAI_API_KEY in the environment. Either method enables semantic search and indexing.",
        });
        return;
      }

      const workspaceRoot = this.getWorkspaceRoot();
      if (!workspaceRoot) {
        this.updateStatus({
          state: "error",
          error: "No workspace folder open",
        });
        return;
      }

      const collectionName = this.getCollectionName(workspaceRoot);
      const cachePath = this.getCachePath(collectionName);

      const files = await this.discoverIndexableFiles(workspaceRoot, config);

      this.log(`Discovered ${files.length} files for indexing`);
      this.updateStatus({ state: "indexing", current: 0, total: files.length });

      // Ensure worker is running
      this.ensureWorker();
      const worker = this.worker!; // guaranteed non-null after ensureWorker()

      const granularity = config.get<"standard" | "fine">(
        "chunkGranularity",
        "fine",
      );

      // Send start message
      worker.send({
        type: "start",
        files,
        workspaceRoot,
        collectionName,
        qdrantUrl,
        embeddingBearerToken,
        cachePath,
        force,
        granularity,
      });
    } catch (err) {
      this.updateStatus({
        state: "error",
        error: `Failed to start indexing: ${err}`,
      });
    }
  }

  cancelIndexing(): void {
    this.cancelRequested = true;

    if (this.status.state === "discovering") {
      // Cancel during Qdrant check / file discovery — waitForQdrant checks this flag
      this.log("Cancel requested during discovery phase");
      this.updateStatus({ state: "idle" });
      return;
    }

    if (this.worker && this.status.state === "indexing") {
      this.worker.send({ type: "cancel" });
      this.log("Sent cancel to indexer worker");
    } else if (this.status.state === "indexing" && !this.worker) {
      // Worker crashed but state is stuck — just reset
      this.log("Cancel requested but worker is dead, resetting state");
      this.updateStatus({ state: "idle" });
    }
  }

  handleFileChange(uri: vscode.Uri): void {
    this.pendingAdded.add(uri.fsPath);
    this.scheduleIncrementalUpdate();
  }

  handleFileDelete(uri: vscode.Uri): void {
    this.pendingRemoved.add(uri.fsPath);
    this.pendingAdded.delete(uri.fsPath);
    this.scheduleIncrementalUpdate();
  }

  handleFileCreate(uri: vscode.Uri): void {
    this.pendingAdded.add(uri.fsPath);
    this.scheduleIncrementalUpdate();
  }

  getStatus(): IndexStatus {
    return this.status;
  }

  startWatching(): void {
    // Watch for file saves
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.handleFileChange(doc.uri);
      }),
    );

    // Watch for file creates/changes/deletes via FileSystemWatcher
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.disposables.push(
      watcher.onDidCreate((uri) => this.handleFileCreate(uri)),
      watcher.onDidChange((uri) => this.handleFileChange(uri)),
      watcher.onDidDelete((uri) => this.handleFileDelete(uri)),
      watcher,
    );
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.worker) {
      this.worker.kill();
      this.worker = null;
    }
    this._onStatusChanged.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  // --- Internals ---

  private ensureWorker(): void {
    if (this.worker) return;

    const workerPath = path.join(
      this.extensionUri.fsPath,
      "dist",
      "indexer-worker.js",
    );

    this.log(`Forking indexer worker: ${workerPath}`);
    this.worker = fork(workerPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: ["--max-old-space-size=512"],
    });

    // Forward worker stdout/stderr to log
    this.worker.stdout?.on("data", (data: Buffer) => {
      this.log(`[worker stdout] ${data.toString().trim()}`);
    });
    this.worker.stderr?.on("data", (data: Buffer) => {
      this.log(`[worker stderr] ${data.toString().trim()}`);
    });

    this.worker.on("message", (msg: WorkerToExtensionMessage) => {
      this.handleWorkerMessage(msg);
    });

    this.worker.on("exit", (code, signal) => {
      this.log(`Indexer worker exited (code=${code}, signal=${signal})`);
      this.worker = null;
      if (this.status.state === "indexing") {
        this.updateStatus({
          state: "error",
          error: `Worker process exited unexpectedly (code=${code})`,
        });
      }
    });

    this.worker.on("error", (err) => {
      this.log(`Indexer worker error: ${err}`);
      this.worker = null;
      this.updateStatus({
        state: "error",
        error: `Worker process error: ${err.message}`,
      });
    });
  }

  private handleWorkerMessage(msg: WorkerToExtensionMessage): void {
    switch (msg.type) {
      case "ready":
        this.log("Indexer worker ready");
        break;

      case "progress":
        this.updateStatus({
          state: "indexing",
          phase: msg.phase,
          current: msg.current,
          total: msg.total,
          detail: msg.detail,
        });
        break;

      case "complete":
        this.log(
          `Indexing complete: ${msg.stats.filesIndexed} files, ${msg.stats.chunksCreated} chunks, ` +
            `${msg.stats.pointsUpserted} upserted, ${msg.stats.pointsDeleted} deleted ` +
            `(${msg.stats.durationMs}ms)` +
            (msg.stats.errors.length > 0
              ? ` — ${msg.stats.errors.length} error(s)`
              : ""),
        );
        if (msg.stats.errors.length > 0) {
          this.log(`Indexing errors:\n${msg.stats.errors.join("\n")}`);
        }
        this.updateStatus({
          state: "idle",
          lastCompleted: {
            filesIndexed: msg.stats.filesIndexed,
            totalFilesInIndex: msg.stats.totalFilesInIndex,
            chunksCreated: msg.stats.chunksCreated,
            totalChunksInIndex: msg.stats.totalChunksInIndex,
            durationMs: msg.stats.durationMs,
            errorCount: msg.stats.errors.length || undefined,
            cancelled: msg.stats.cancelled || undefined,
          },
        });
        break;

      case "error":
        this.log(`Indexer error: ${msg.message}`);
        if (msg.fatal) {
          this.updateStatus({ state: "error", error: msg.message });
        } else {
          // Surface non-fatal errors as detail so the UI isn't silent
          this.updateStatus({ ...this.status, detail: msg.message });
        }
        break;

      case "embeddingAuthRefreshRequest":
        void this.handleEmbeddingAuthRefreshRequest(msg);
        break;
    }
  }

  private async handleEmbeddingAuthRefreshRequest(
    msg: EmbeddingAuthRefreshRequestMessage,
  ): Promise<void> {
    const worker = this.worker;
    if (!worker) return;

    try {
      const oauthMethod = await openAiCodexAuthManager.getPreferredAuthMethod();
      const auth =
        oauthMethod === "oauth"
          ? await openAiCodexAuthManager.forceRefreshModelAuth("oauth")
          : await openAiCodexAuthManager.resolveEmbeddingAuth();
      worker.send({
        type: "embeddingAuthRefreshResponse",
        requestId: msg.requestId,
        bearerToken: auth?.bearerToken || "",
      });
    } catch (error) {
      this.log(
        `[indexer] Failed to refresh embedding auth: ${error instanceof Error ? error.message : error}`,
      );
      worker.send({
        type: "embeddingAuthRefreshResponse",
        requestId: msg.requestId,
        bearerToken: "",
      });
    }
  }

  private scheduleIncrementalUpdate(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.flushIncrementalUpdate();
    }, WATCHER_DEBOUNCE_MS);
  }

  private async flushIncrementalUpdate(): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return;

    let added = [...this.pendingAdded];
    let removed = [...this.pendingRemoved];

    const config = vscode.workspace.getConfiguration("agentlink");
    const exclusions = this.getIndexExclusions(config);
    added = await this.filterIndexableFiles(added, workspaceRoot, exclusions);
    removed = await this.filterExplicitlyIncludedRemovedPaths(
      removed,
      workspaceRoot,
      exclusions,
    );

    if (added.length === 0 && removed.length === 0) {
      this.pendingAdded.clear();
      this.pendingRemoved.clear();
      return;
    }
    if (
      this.status.state === "indexing" ||
      this.status.state === "discovering"
    ) {
      return;
    }

    this.pendingAdded.clear();
    this.pendingRemoved.clear();

    const qdrantUrl = config.get<string>("qdrantUrl", "http://localhost:6333");
    const embeddingBearerToken = await this.getEmbeddingBearerToken();
    if (!embeddingBearerToken) return;

    const collectionName = this.getCollectionName(workspaceRoot);
    const cachePath = this.getCachePath(collectionName);

    this.log(
      `Incremental update: ${added.length} added/changed, ${removed.length} removed`,
    );
    this.updateStatus({ state: "indexing" });

    const granularity = config.get<"standard" | "fine">(
      "chunkGranularity",
      "fine",
    );

    this.ensureWorker();
    const worker = this.worker!; // guaranteed non-null after ensureWorker()
    worker.send({
      type: "incrementalUpdate",
      added,
      removed,
      workspaceRoot,
      collectionName,
      qdrantUrl,
      embeddingBearerToken,
      cachePath,
      granularity,
    });
  }

  private async discoverIndexableFiles(
    workspaceRoot: string,
    config: vscode.WorkspaceConfiguration,
  ): Promise<string[]> {
    const exclusions = this.getIndexExclusions(config);
    const excludePattern = `{${exclusions.join(",")}}`;

    const uris = await vscode.workspace.findFiles("**/*", excludePattern);
    const discovered = uris.map((u) => u.fsPath);
    return this.filterIndexableFiles(discovered, workspaceRoot, exclusions);
  }

  private getIndexExclusions(config: vscode.WorkspaceConfiguration): string[] {
    return config.get<string[]>("indexExclusions", DEFAULT_INDEX_EXCLUSIONS);
  }

  private async filterIndexableFiles(
    files: string[],
    workspaceRoot: string,
    exclusions: string[] = DEFAULT_INDEX_EXCLUSIONS,
  ): Promise<string[]> {
    const exclusionMatcher = this.buildExclusionMatcher(
      workspaceRoot,
      exclusions,
    );

    const existingFiles = files.filter((filePath) => {
      try {
        if (exclusionMatcher(filePath)) return false;
        const stat = fs.statSync(filePath);
        return stat.isFile() && stat.size > 0 && stat.size <= MAX_FILE_SIZE;
      } catch {
        return false;
      }
    });

    return this.filterGitIgnoredPaths(existingFiles, workspaceRoot, {
      keepIgnored: false,
    });
  }

  private async filterExplicitlyIncludedRemovedPaths(
    files: string[],
    workspaceRoot: string,
    exclusions: string[],
  ): Promise<string[]> {
    if (files.length === 0) return files;
    const exclusionMatcher = this.buildExclusionMatcher(
      workspaceRoot,
      exclusions,
    );
    return files.filter((filePath) => !exclusionMatcher(filePath));
  }

  private buildExclusionMatcher(
    workspaceRoot: string,
    exclusions: string[],
  ): (filePath: string) => boolean {
    const relativeMatchers = exclusions.map((pattern) =>
      picomatch(pattern, { dot: true }),
    );
    const absoluteMatchers = exclusions
      .filter((pattern) => path.isAbsolute(pattern))
      .map((pattern) => picomatch(pattern, { dot: true }));

    return (filePath: string) => {
      const relPath = path
        .relative(workspaceRoot, filePath)
        .split(path.sep)
        .join("/");
      if (!relPath || relPath.startsWith("../") || relPath === "..") {
        return true;
      }

      if (relativeMatchers.some((matcher) => matcher(relPath))) {
        return true;
      }

      const normalizedAbsPath = filePath.split(path.sep).join("/");
      return absoluteMatchers.some((matcher) => matcher(normalizedAbsPath));
    };
  }

  private async filterGitIgnoredPaths(
    files: string[],
    workspaceRoot: string,
    options: { keepIgnored: boolean },
  ): Promise<string[]> {
    if (files.length === 0) return files;

    const relPathEntries = files
      .map((filePath) => {
        const relPath = path.relative(workspaceRoot, filePath);
        if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
          return null;
        }
        return { filePath, relPath: relPath.split(path.sep).join("/") };
      })
      .filter(
        (entry): entry is { filePath: string; relPath: string } =>
          entry !== null,
      );

    if (relPathEntries.length === 0) return [];

    const ignoredRelPaths = await this.getGitIgnoredRelativePaths(
      relPathEntries.map((entry) => entry.relPath),
      workspaceRoot,
    );

    return relPathEntries
      .filter(
        (entry) => ignoredRelPaths.has(entry.relPath) === options.keepIgnored,
      )
      .map((entry) => entry.filePath);
  }

  private async getGitIgnoredRelativePaths(
    relPaths: string[],
    workspaceRoot: string,
  ): Promise<Set<string>> {
    if (relPaths.length === 0) return new Set();

    return new Promise((resolve) => {
      const child = spawn("git", ["check-ignore", "--stdin", "-z"], {
        cwd: workspaceRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        this.log(
          `Git ignore filtering unavailable (${String(code ?? err.message)}); indexing non-excluded files only.`,
        );
        resolve(new Set());
      });
      child.stdin.on("error", () => {
        // git may exit before consuming all stdin; ignore broken-pipe errors.
      });
      child.on("close", (code) => {
        const output = Buffer.concat(stdoutChunks).toString("utf8");
        if (code === 0 || code === 1) {
          resolve(new Set(output.split("\0").filter(Boolean)));
          return;
        }

        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        this.log(
          `Git ignore filtering failed (${code ?? "unknown"})${stderr ? `: ${stderr}` : ""}`,
        );
        resolve(new Set());
      });

      child.stdin.end(Buffer.from(relPaths.join("\0") + "\0"));
    });
  }

  private updateStatus(partial: Partial<IndexStatus>): void {
    // Preserve lastCompleted across status updates unless explicitly set
    const lastCompleted = partial.lastCompleted ?? this.status.lastCompleted;
    this.status = { ...this.status, ...partial, lastCompleted };
    this._onStatusChanged.fire(this.status);
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private getCollectionName(workspacePath: string): string {
    const hash = createHash("sha256").update(workspacePath).digest("hex");
    return `al-${hash.substring(0, 16)}`;
  }

  private getCachePath(collectionName: string): string {
    return path.join(
      this.globalStorageUri.fsPath,
      "index-cache",
      `${collectionName}.json`,
    );
  }

  /**
   * Try to reach Qdrant with exponential backoff (1s, 2s, 4s, 8s).
   * Updates status detail so the user sees retry progress in the sidebar.
   * Returns false if all attempts fail or cancel is requested.
   */
  private async waitForQdrant(qdrantUrl: string): Promise<boolean> {
    const baseUrl = qdrantUrl.replace(/\/+$/, "");
    const delays = [0, 1000, 2000, 4000, 8000]; // initial + 4 retries

    for (let i = 0; i < delays.length; i++) {
      if (this.cancelRequested) return false;

      if (delays[i] > 0) {
        this.updateStatus({
          ...this.status,
          detail: `Qdrant not reachable, retrying (${i}/${delays.length - 1})...`,
        });
        await new Promise((r) => setTimeout(r, delays[i]));
      }

      if (this.cancelRequested) return false;

      try {
        const resp = await fetch(`${baseUrl}/healthz`, {
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) return true;
      } catch {
        this.log(
          `Qdrant health check failed (attempt ${i + 1}/${delays.length})`,
        );
      }
    }

    return false;
  }

  private async getEmbeddingBearerToken(): Promise<string> {
    const auth = await openAiCodexAuthManager.resolveEmbeddingAuth();
    return auth?.bearerToken || "";
  }
}
