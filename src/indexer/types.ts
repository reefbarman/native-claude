// Shared IPC protocol types between extension host and child process.
// IMPORTANT: No `vscode` imports — this must be usable from both sides.

export type ChunkGranularity = "standard" | "fine";

// ============================================================
// Extension → Child messages
// ============================================================

export interface StartIndexMessage {
  type: "start";
  /** Absolute file paths to index */
  files: string[];
  workspaceRoot: string;
  /** Qdrant collection name, e.g. "al-{hash16}" */
  collectionName: string;
  qdrantUrl: string;
  embeddingBearerToken: string;
  /** Filesystem path for the hash cache JSON file */
  cachePath: string;
  /** If true, delete collection and re-index from scratch */
  force: boolean;
  /** Chunk granularity level */
  granularity: ChunkGranularity;
}

export interface CancelMessage {
  type: "cancel";
}

export interface EmbeddingAuthRefreshResponseMessage {
  type: "embeddingAuthRefreshResponse";
  requestId: string;
  bearerToken: string;
}

export interface IncrementalUpdateMessage {
  type: "incrementalUpdate";
  /** New or changed file paths (absolute) */
  added: string[];
  /** Deleted file paths (absolute) */
  removed: string[];
  workspaceRoot: string;
  collectionName: string;
  qdrantUrl: string;
  embeddingBearerToken: string;
  cachePath: string;
  /** Chunk granularity level */
  granularity: ChunkGranularity;
}

export type ExtensionToWorkerMessage =
  | StartIndexMessage
  | CancelMessage
  | EmbeddingAuthRefreshResponseMessage
  | IncrementalUpdateMessage;

// ============================================================
// Child → Extension messages
// ============================================================

export type IndexPhase =
  | "reading"
  | "chunking"
  | "embedding"
  | "upserting"
  | "cleanup";

export interface ProgressMessage {
  type: "progress";
  phase: IndexPhase;
  current: number;
  total: number;
  detail?: string;
}

export interface IndexStats {
  filesIndexed: number;
  /** Total files in the index (cache) after this run */
  totalFilesInIndex: number;
  chunksCreated: number;
  /** Total chunks (points) across all cached files */
  totalChunksInIndex: number;
  pointsUpserted: number;
  pointsDeleted: number;
  durationMs: number;
  errors: string[];
  /** True if this run was cancelled before completing */
  cancelled?: boolean;
}

export interface CompleteMessage {
  type: "complete";
  stats: IndexStats;
}

export interface ErrorMessage {
  type: "error";
  message: string;
  /** If true, the child process will exit */
  fatal: boolean;
}

export interface ReadyMessage {
  type: "ready";
}

export interface EmbeddingAuthRefreshRequestMessage {
  type: "embeddingAuthRefreshRequest";
  requestId: string;
}

export type WorkerToExtensionMessage =
  | ProgressMessage
  | CompleteMessage
  | ErrorMessage
  | ReadyMessage
  | EmbeddingAuthRefreshRequestMessage;

// ============================================================
// Cache schema (stored as JSON on disk)
// ============================================================

export interface CachedFileEntry {
  /** SHA-256 hex digest of file content */
  hash: string;
  /** Qdrant point IDs for this file's chunks */
  pointIds: string[];
  /** ISO timestamp of when this file was last indexed */
  indexedAt: string;
  /** File modification time (ms) — used for fast stat-based skip */
  mtimeMs?: number;
  /** File size in bytes — used for fast stat-based skip */
  size?: number;
}

export interface IndexCache {
  version: number;
  /** Relative path → cached entry */
  files: Record<string, CachedFileEntry>;
  /** Granularity used when this cache was built */
  granularity?: ChunkGranularity;
}

// ============================================================
// Chunk types (output of the chunker)
// ============================================================

export interface Chunk {
  content: string;
  /** Absolute file path */
  filePath: string;
  /** Path relative to workspace root */
  relPath: string;
  /** 1-based start line */
  startLine: number;
  /** 1-based end line */
  endLine: number;
  /**
   * Context-enriched text sent to the embedding model.
   * Includes file path header and optional parent scope.
   * Falls back to `content` when not set.
   */
  embeddingContent?: string;
}

// ============================================================
// Embedding dimension constant
// ============================================================

export const EMBEDDING_DIM = 1536;
export const EMBEDDING_MODEL = "text-embedding-3-small";
