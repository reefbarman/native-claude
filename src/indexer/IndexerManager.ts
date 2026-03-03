/**
 * Extension-side manager for the indexer child process.
 *
 * Handles: file discovery (vscode.workspace.findFiles), forking the worker,
 * IPC message routing, progress reporting, file watching, and lifecycle.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { fork, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import type {
  WorkerToExtensionMessage,
  IndexStats,
  IndexPhase,
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

export class IndexerManager implements vscode.Disposable {
  private worker: ChildProcess | null = null;
  private status: IndexStatus = { state: "idle" };
  private disposables: vscode.Disposable[] = [];

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

    this.updateStatus({ state: "discovering" });

    try {
      const config = vscode.workspace.getConfiguration("agentlink");
      const qdrantUrl = config.get<string>(
        "qdrantUrl",
        "http://localhost:6333",
      );
      const openAiApiKey = await this.getOpenAiApiKey();

      if (!openAiApiKey) {
        this.updateStatus({
          state: "error",
          error:
            "OpenAI API key not configured. Run 'AgentLink: Set OpenAI API Key' or set OPENAI_API_KEY env var.",
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

      // File discovery via VS Code API (respects .gitignore)
      const exclusions = config.get<string[]>("indexExclusions", [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/*.min.js",
        "**/*.map",
      ]);
      const excludePattern = `{${exclusions.join(",")}}`;

      const uris = await vscode.workspace.findFiles("**/*", excludePattern);

      // Filter: skip oversized, binary detection happens in the worker
      const files = uris
        .map((u) => u.fsPath)
        .filter((f) => {
          try {
            const stat = fs.statSync(f);
            return stat.size > 0 && stat.size <= MAX_FILE_SIZE;
          } catch {
            return false;
          }
        });

      this.log(`Discovered ${files.length} files for indexing`);
      this.updateStatus({ state: "indexing", current: 0, total: files.length });

      // Ensure worker is running
      this.ensureWorker();

      const granularity = config.get<"standard" | "fine">(
        "chunkGranularity",
        "fine",
      );

      // Send start message
      this.worker!.send({
        type: "start",
        files,
        workspaceRoot,
        collectionName,
        qdrantUrl,
        openAiApiKey,
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
    if (this.worker && this.status.state === "indexing") {
      this.worker.send({ type: "cancel" });
      this.log("Sent cancel to indexer worker");
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
        }
        break;
    }
  }

  private scheduleIncrementalUpdate(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.flushIncrementalUpdate();
    }, WATCHER_DEBOUNCE_MS);
  }

  private async flushIncrementalUpdate(): Promise<void> {
    const added = [...this.pendingAdded];
    const removed = [...this.pendingRemoved];
    this.pendingAdded.clear();
    this.pendingRemoved.clear();

    if (added.length === 0 && removed.length === 0) return;
    if (
      this.status.state === "indexing" ||
      this.status.state === "discovering"
    ) {
      // Queue for after current index completes — re-add to pending
      for (const f of added) this.pendingAdded.add(f);
      for (const f of removed) this.pendingRemoved.add(f);
      return;
    }

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = vscode.workspace.getConfiguration("agentlink");
    const qdrantUrl = config.get<string>("qdrantUrl", "http://localhost:6333");
    const openAiApiKey = await this.getOpenAiApiKey();
    if (!openAiApiKey) return;

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
    this.worker!.send({
      type: "incrementalUpdate",
      added,
      removed,
      workspaceRoot,
      collectionName,
      qdrantUrl,
      openAiApiKey,
      cachePath,
      granularity,
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

  private async getOpenAiApiKey(): Promise<string> {
    // Try secret storage first (set via command palette)
    const fromSecrets = await vscode.commands.executeCommand<string>(
      "agentlink.getOpenAiApiKeyInternal",
    );
    if (fromSecrets) return fromSecrets;
    return process.env.OPENAI_API_KEY || "";
  }
}
