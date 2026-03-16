/**
 * Indexer worker — runs as a child process via child_process.fork().
 *
 * Handles file reading, hashing, chunking, embedding (OpenAI), and
 * Qdrant upsert/delete. Communicates with the extension host via IPC.
 *
 * Memory-efficient: processes files in batches of FILE_BATCH_SIZE through
 * the full pipeline (read → chunk → embed → upsert → release), bounding
 * peak memory to O(batch_size) instead of O(total_files).
 *
 * IMPORTANT: This file MUST NOT import "vscode".
 */

import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

// Lower worker process priority so indexing doesn't starve the UI / other processes.
// 19 = lowest priority on Linux/macOS (POSIX nice), 19 = IDLE on Windows.
try {
  os.setPriority(19);
} catch {
  // Non-fatal — some environments don't allow priority changes
}
import {
  initTreeSitter,
  treeSitterChunkFile,
  isTreeSitterSupported,
  setChunkGranularity as setTreeSitterGranularity,
} from "./treeSitterChunker.js";
import {
  chunkFile,
  setChunkGranularity as setChunkerGranularity,
} from "./chunker.js";
import {
  isMarkdownFile,
  markdownChunkFile,
  setChunkGranularity as setMarkdownGranularity,
} from "./markdownChunker.js";
import {
  buildPathSegments,
  loadCache,
  writeCache,
  diffFiles,
  scanFiles,
  readFilesBatch,
  type FileWithContent,
} from "./workerLib.js";
import type {
  ExtensionToWorkerMessage,
  StartIndexMessage,
  IncrementalUpdateMessage,
  IndexStats,
  IndexCache,
  Chunk,
  ChunkGranularity,
} from "./types.js";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "./types.js";

// --- Constants ---

const EMBEDDING_BATCH_SIZE = 100;
const EMBEDDING_CONCURRENCY = 3;
const QDRANT_UPSERT_BATCH = 100;
const MAX_RETRIES = 3;
/**
 * Token limit per embedding batch. Estimated via chars/4.
 * text-embedding-3-small supports up to 8191 tokens per input, and the API
 * accepts large batches. Roo-Code uses 100K; we use 50K as a safe middle ground
 * that drastically reduces the number of API calls vs our old 7.5K limit.
 */
const MAX_BATCH_TOKENS = 50_000;
/**
 * Max characters per individual embedding text.
 * text-embedding-3-small has an 8192 token limit. Code averages ~2.5-3
 * chars/token, so 20k chars ≈ 6700-8000 tokens — safe with margin.
 */
const MAX_EMBEDDING_CHARS = 20_000;
/**
 * Number of files to process through the full pipeline (chunk → embed → upsert)
 * per batch. Bounds peak memory to ~7.5MB per batch instead of O(total_files).
 */
const FILE_BATCH_SIZE = 50;

// --- State ---

let aborted = false;
const pendingEmbeddingAuthRefreshRequests = new Map<
  string,
  {
    resolve: (token: string) => void;
    reject: (error: Error) => void;
  }
>();

// --- IPC helpers ---

function send(msg: unknown): void {
  if (process.send) process.send(msg);
}

function sendProgress(
  phase: string,
  current: number,
  total: number,
  detail?: string,
): void {
  send({ type: "progress", phase, current, total, detail });
}

function sendComplete(stats: IndexStats): void {
  send({ type: "complete", stats });
}

function sendError(message: string, fatal: boolean): void {
  send({ type: "error", message, fatal });
}

async function requestEmbeddingAuthRefresh(): Promise<string> {
  const requestId = randomUUID();
  return new Promise<string>((resolve, reject) => {
    pendingEmbeddingAuthRefreshRequests.set(requestId, { resolve, reject });
    send({ type: "embeddingAuthRefreshRequest", requestId });
    const timeout = setTimeout(() => {
      pendingEmbeddingAuthRefreshRequests.delete(requestId);
      reject(new Error("Timed out waiting for refreshed embedding auth token"));
    }, 30_000);
    const originalResolve = resolve;
    const originalReject = reject;
    pendingEmbeddingAuthRefreshRequests.set(requestId, {
      resolve: (token: string) => {
        clearTimeout(timeout);
        originalResolve(token);
      },
      reject: (error: Error) => {
        clearTimeout(timeout);
        originalReject(error);
      },
    });
  });
}

/** Count total chunks (points) across all cached files */
function countCachedChunks(cache: IndexCache): number {
  let total = 0;
  for (const entry of Object.values(cache.files)) {
    total += entry.pointIds.length;
  }
  return total;
}

// --- Entry point ---

process.on("message", (msg: ExtensionToWorkerMessage) => {
  switch (msg.type) {
    case "start":
      aborted = false;
      handleStart(msg).catch((err) => {
        sendError(String(err), false);
      });
      break;
    case "cancel":
      aborted = true;
      break;
    case "embeddingAuthRefreshResponse": {
      const pending = pendingEmbeddingAuthRefreshRequests.get(msg.requestId);
      if (!pending) break;
      pendingEmbeddingAuthRefreshRequests.delete(msg.requestId);
      if (msg.bearerToken) {
        pending.resolve(msg.bearerToken);
      } else {
        pending.reject(
          new Error("Extension returned no refreshed embedding auth token"),
        );
      }
      break;
    }
    case "incrementalUpdate":
      aborted = false;
      handleIncrementalUpdate(msg).catch((err) => {
        sendError(String(err), false);
      });
      break;
  }
});

send({ type: "ready" });

// Initialize tree-sitter WASM (one-time, before any indexing)
const wasmDir = path.join(__dirname, "wasm");
const treeSitterReady = initTreeSitter(wasmDir).catch((err) => {
  sendError(`Tree-sitter init failed: ${err}`, true);
});

// --- File batch pipeline ---

interface BatchConfig {
  qdrantUrl: string;
  collectionName: string;
  embeddingBearerToken: string;
  cachePath: string;
  granularity: ChunkGranularity;
}

interface BatchResult {
  filesIndexed: number;
  chunksCreated: number;
  pointsUpserted: number;
  errors: string[];
}

/**
 * Process a batch of files through the full pipeline: chunk → embed → upsert.
 * All intermediate data (chunks, embeddings, points) is scoped to this function
 * and released when it returns, bounding peak memory to O(batch_size).
 */
async function processFileBatch(
  files: FileWithContent[],
  config: BatchConfig,
  cache: IndexCache,
): Promise<BatchResult> {
  const errors: string[] = [];
  let filesIndexed = 0;
  let chunksCreated = 0;
  let pointsUpserted = 0;

  // 1. Chunk all files in this batch (yield every ~15ms to avoid CPU saturation)
  const allChunks: Array<{ chunk: Chunk; fileIdx: number }> = [];
  let lastYield = Date.now();
  for (let i = 0; i < files.length; i++) {
    if (aborted) break;
    const now = Date.now();
    if (now - lastYield >= 15) {
      await sleep(1);
      lastYield = Date.now();
    }
    const file = files[i];

    let chunks: Chunk[];
    if (isMarkdownFile(file.absPath)) {
      chunks = markdownChunkFile(file.content, file.absPath, file.relPath);
    } else if (isTreeSitterSupported(file.absPath)) {
      chunks = await treeSitterChunkFile(
        file.content,
        file.absPath,
        file.relPath,
      );
      if (chunks.length === 0) {
        chunks = chunkFile(file.content, file.absPath, file.relPath);
      }
    } else {
      chunks = chunkFile(file.content, file.absPath, file.relPath);
    }

    for (const chunk of chunks) {
      if (!chunk.embeddingContent) {
        chunk.embeddingContent = chunk.content;
      }
    }
    for (const chunk of chunks) {
      allChunks.push({ chunk, fileIdx: i });
    }
  }
  chunksCreated = allChunks.length;

  if (aborted || allChunks.length === 0) {
    return { filesIndexed, chunksCreated: 0, pointsUpserted, errors };
  }

  // 2. Embed all chunks from this batch
  const embeddings = await batchEmbed(
    allChunks.map((c) => c.chunk.embeddingContent ?? c.chunk.content),
    config.embeddingBearerToken,
    errors,
  );

  if (aborted) {
    return { filesIndexed, chunksCreated, pointsUpserted, errors };
  }

  // 3. Build points (filter out failed embeddings)
  const filePointIds = new Map<number, string[]>();
  const points: QdrantPoint[] = [];

  for (let i = 0; i < allChunks.length; i++) {
    const embedding = embeddings[i];
    if (!embedding) continue;

    const { chunk, fileIdx } = allChunks[i];
    const pointId = randomUUID();

    if (!filePointIds.has(fileIdx)) filePointIds.set(fileIdx, []);
    filePointIds.get(fileIdx)!.push(pointId);

    points.push({
      id: pointId,
      vector: embedding,
      payload: {
        filePath: chunk.relPath,
        codeChunk: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        pathSegments: buildPathSegments(chunk.relPath),
      },
    });
  }

  // 4. Upsert to Qdrant in sub-batches
  for (let i = 0; i < points.length; i += QDRANT_UPSERT_BATCH) {
    if (aborted) break;
    const batch = points.slice(i, i + QDRANT_UPSERT_BATCH);
    try {
      await upsertPoints(config.qdrantUrl, config.collectionName, batch);
      pointsUpserted += batch.length;
    } catch (err) {
      errors.push(`Qdrant upsert failed: ${err}`);
    }
  }

  // 5. Update cache for completed files
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ids = filePointIds.get(i) ?? [];
    if (ids.length > 0) {
      cache.files[file.relPath] = {
        hash: file.hash,
        pointIds: ids,
        indexedAt: new Date().toISOString(),
        mtimeMs: file.mtimeMs,
        size: file.size,
      };
      filesIndexed++;
    }
  }
  cache.granularity = config.granularity;
  writeCache(config.cachePath, cache);

  return { filesIndexed, chunksCreated, pointsUpserted, errors };
}

// --- Main indexing pipeline ---

async function handleStart(msg: StartIndexMessage): Promise<void> {
  await treeSitterReady;
  const startTime = Date.now();
  const errors: string[] = [];
  let filesIndexed = 0;
  let chunksCreated = 0;
  let pointsUpserted = 0;
  let pointsDeleted = 0;

  // Distribute granularity to all chunkers
  setTreeSitterGranularity(msg.granularity);
  setChunkerGranularity(msg.granularity);
  setMarkdownGranularity(msg.granularity);

  try {
    // Force re-index: delete collection and clear cache
    if (msg.force) {
      await deleteCollection(msg.qdrantUrl, msg.collectionName);
      writeCache(msg.cachePath, { version: 1, files: {} });
    }

    // Ensure Qdrant collection exists
    await ensureCollection(msg.qdrantUrl, msg.collectionName);

    // Load cache
    const cache = loadCache(msg.cachePath);

    // Granularity change → force full re-index
    // Treat undefined (old cache) as "standard" to avoid unnecessary re-index
    if ((cache.granularity ?? "standard") !== msg.granularity) {
      await deleteCollection(msg.qdrantUrl, msg.collectionName);
      await ensureCollection(msg.qdrantUrl, msg.collectionName);
      cache.files = {};
      cache.granularity = msg.granularity;
    }

    // Phase 1: Scan files to determine what changed (paths only, no content held)
    sendProgress("reading", 0, msg.files.length);
    const {
      toIndexPaths,
      staleRelPaths,
      errors: scanErrors,
    } = await scanFiles(msg.files, msg.workspaceRoot, cache, (scanned, total) =>
      sendProgress("reading", scanned, total),
    );
    errors.push(...scanErrors);
    sendProgress("reading", msg.files.length, msg.files.length);

    if (aborted) {
      sendComplete({
        filesIndexed,
        totalFilesInIndex: Object.keys(cache.files).length,
        chunksCreated,
        totalChunksInIndex: countCachedChunks(cache),
        pointsUpserted,
        pointsDeleted,
        durationMs: Date.now() - startTime,
        errors,
        cancelled: true,
      });
      return;
    }

    // Phase 1b: Delete stale points
    if (staleRelPaths.length > 0) {
      sendProgress("cleanup", 0, staleRelPaths.length);
      for (let i = 0; i < staleRelPaths.length; i++) {
        if (aborted) break;
        const relPath = staleRelPaths[i];
        const cached = cache.files[relPath];
        if (cached && cached.pointIds.length > 0) {
          try {
            await deletePoints(
              msg.qdrantUrl,
              msg.collectionName,
              cached.pointIds,
            );
            pointsDeleted += cached.pointIds.length;
          } catch (err) {
            errors.push(`Failed to delete points for ${relPath}: ${err}`);
          }
        }
        delete cache.files[relPath];
      }
      sendProgress("cleanup", staleRelPaths.length, staleRelPaths.length);
      writeCache(msg.cachePath, cache);
    }

    if (aborted || toIndexPaths.length === 0) {
      writeCache(msg.cachePath, cache);
      sendComplete({
        filesIndexed: 0,
        totalFilesInIndex: Object.keys(cache.files).length,
        chunksCreated: 0,
        totalChunksInIndex: countCachedChunks(cache),
        pointsUpserted,
        pointsDeleted,
        durationMs: Date.now() - startTime,
        errors,
        cancelled: aborted || undefined,
      });
      return;
    }

    // Phase 2: Process files in batches through the full pipeline
    const totalFiles = toIndexPaths.length;
    const totalBatches = Math.ceil(totalFiles / FILE_BATCH_SIZE);
    const batchConfig: BatchConfig = {
      qdrantUrl: msg.qdrantUrl,
      collectionName: msg.collectionName,
      embeddingBearerToken: msg.embeddingBearerToken,
      cachePath: msg.cachePath,
      granularity: msg.granularity,
    };

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      if (aborted) break;

      const batchStart = batchNum * FILE_BATCH_SIZE;
      const batchPaths = toIndexPaths.slice(
        batchStart,
        batchStart + FILE_BATCH_SIZE,
      );

      // Read content for this batch only
      const batchErrors: string[] = [];
      const batchFiles = await readFilesBatch(batchPaths, batchErrors);
      errors.push(...batchErrors);

      if (batchFiles.length === 0) continue;

      // Delete old points for files being re-indexed in this batch
      for (const file of batchFiles) {
        const cached = cache.files[file.relPath];
        if (cached && cached.pointIds.length > 0) {
          try {
            await deletePoints(
              msg.qdrantUrl,
              msg.collectionName,
              cached.pointIds,
            );
            pointsDeleted += cached.pointIds.length;
          } catch (err) {
            errors.push(`Failed to delete points for ${file.relPath}: ${err}`);
          }
          delete cache.files[file.relPath];
        }
      }

      // Process batch through chunk → embed → upsert pipeline
      sendProgress(
        "indexing",
        batchStart,
        totalFiles,
        `batch ${batchNum + 1}/${totalBatches}`,
      );

      const result = await processFileBatch(batchFiles, batchConfig, cache);
      filesIndexed += result.filesIndexed;
      chunksCreated += result.chunksCreated;
      pointsUpserted += result.pointsUpserted;
      errors.push(...result.errors);

      // batchFiles, result, and all intermediate arrays are now out of scope
    }

    // Final cache save
    cache.granularity = msg.granularity;
    writeCache(msg.cachePath, cache);

    sendComplete({
      filesIndexed,
      totalFilesInIndex: Object.keys(cache.files).length,
      chunksCreated,
      totalChunksInIndex: countCachedChunks(cache),
      pointsUpserted,
      pointsDeleted,
      durationMs: Date.now() - startTime,
      errors,
      cancelled: aborted || undefined,
    });
  } catch (err) {
    sendError(`Indexing failed: ${err}`, true);
  }
}

// --- Incremental update ---

async function handleIncrementalUpdate(
  msg: IncrementalUpdateMessage,
): Promise<void> {
  await treeSitterReady;
  const startTime = Date.now();
  const errors: string[] = [];
  let filesIndexed = 0;
  let chunksCreated = 0;
  let pointsUpserted = 0;
  let pointsDeleted = 0;

  // Distribute granularity to all chunkers
  setTreeSitterGranularity(msg.granularity);
  setChunkerGranularity(msg.granularity);
  setMarkdownGranularity(msg.granularity);

  try {
    const cache = loadCache(msg.cachePath);

    // Handle removed files
    for (const absPath of msg.removed) {
      const relPath = path.relative(msg.workspaceRoot, absPath);
      const cached = cache.files[relPath];
      if (cached && cached.pointIds.length > 0) {
        try {
          await deletePoints(
            msg.qdrantUrl,
            msg.collectionName,
            cached.pointIds,
          );
          pointsDeleted += cached.pointIds.length;
        } catch (err) {
          errors.push(`Failed to delete points for ${relPath}: ${err}`);
        }
      }
      delete cache.files[relPath];
    }

    // Handle added/changed files — diff against cache
    const { toIndex, errors: readErrors } = diffFiles(
      msg.added,
      msg.workspaceRoot,
      cache,
    );
    errors.push(...readErrors);

    // Delete old points for files that will be re-indexed
    for (const file of toIndex) {
      const cached = cache.files[file.relPath];
      if (cached && cached.pointIds.length > 0) {
        try {
          await deletePoints(
            msg.qdrantUrl,
            msg.collectionName,
            cached.pointIds,
          );
          pointsDeleted += cached.pointIds.length;
        } catch (err) {
          errors.push(`Failed to delete points for ${file.relPath}: ${err}`);
        }
      }
    }

    // Process in batches using processFileBatch
    if (toIndex.length > 0 && !aborted) {
      const batchConfig: BatchConfig = {
        qdrantUrl: msg.qdrantUrl,
        collectionName: msg.collectionName,
        embeddingBearerToken: msg.embeddingBearerToken,
        cachePath: msg.cachePath,
        granularity: msg.granularity,
      };

      for (let i = 0; i < toIndex.length; i += FILE_BATCH_SIZE) {
        if (aborted) break;
        const batch = toIndex.slice(i, i + FILE_BATCH_SIZE);
        const result = await processFileBatch(batch, batchConfig, cache);
        filesIndexed += result.filesIndexed;
        chunksCreated += result.chunksCreated;
        pointsUpserted += result.pointsUpserted;
        errors.push(...result.errors);
      }
    }

    cache.granularity = msg.granularity;
    writeCache(msg.cachePath, cache);

    sendComplete({
      filesIndexed,
      totalFilesInIndex: Object.keys(cache.files).length,
      chunksCreated,
      totalChunksInIndex: countCachedChunks(cache),
      pointsUpserted,
      pointsDeleted,
      durationMs: Date.now() - startTime,
      errors,
    });
  } catch (err) {
    sendError(`Incremental update failed: ${err}`, true);
  }
}

// ============================================================
// OpenAI Embedding API
// ============================================================

/** Estimate token count for a text (rough: 1 token ≈ 4 chars for code). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split texts into token-aware batches that respect both the count limit
 * (EMBEDDING_BATCH_SIZE) and the token limit (MAX_BATCH_TOKENS).
 */
function buildTokenAwareBatches(
  texts: string[],
  startIdx: number,
): Array<{ startIdx: number; batch: string[] }> {
  const batches: Array<{ startIdx: number; batch: string[] }> = [];
  let i = startIdx;
  while (i < texts.length && batches.length < EMBEDDING_CONCURRENCY) {
    const batch: string[] = [];
    let batchTokens = 0;
    const batchStart = i;
    while (i < texts.length && batch.length < EMBEDDING_BATCH_SIZE) {
      const tokens = estimateTokens(texts[i]);
      if (batch.length > 0 && batchTokens + tokens > MAX_BATCH_TOKENS) break;
      batch.push(texts[i]);
      batchTokens += tokens;
      i++;
    }
    if (batch.length > 0) {
      batches.push({ startIdx: batchStart, batch });
    }
  }
  return batches;
}

async function batchEmbed(
  texts: string[],
  bearerToken: string,
  errors: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<(number[] | null)[]> {
  // Truncate oversized texts to fit within the embedding model's context window
  const safeTexts = texts.map((t) =>
    t.length > MAX_EMBEDDING_CHARS ? t.slice(0, MAX_EMBEDDING_CHARS) : t,
  );
  const results: (number[] | null)[] = Array.from<number[] | null>({
    length: safeTexts.length,
  }).fill(null);
  let done = 0;
  let cursor = 0;

  while (cursor < safeTexts.length) {
    if (aborted) break;

    const concurrentBatches = buildTokenAwareBatches(safeTexts, cursor);
    if (concurrentBatches.length === 0) break;

    // Advance cursor past all batches we're about to process
    const lastBatch = concurrentBatches[concurrentBatches.length - 1];
    cursor = lastBatch.startIdx + lastBatch.batch.length;

    const promises = concurrentBatches.map(({ startIdx, batch }) =>
      embedBatchWithRetry(batch, bearerToken)
        .then((vectors) => {
          for (let k = 0; k < vectors.length; k++) {
            results[startIdx + k] = vectors[k];
          }
          done += batch.length;
          onProgress?.(done, safeTexts.length);
        })
        .catch((err) => {
          errors.push(
            `Embedding batch failed (${batch.length} chunks at offset ${startIdx}): ${err}`,
          );
          done += batch.length;
          onProgress?.(done, safeTexts.length);
        }),
    );

    await Promise.all(promises);
  }

  return results;
}

async function embedBatchWithRetry(
  texts: string[],
  bearerToken: string,
  retries = MAX_RETRIES,
): Promise<number[][]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        data: Array<{ index: number; embedding: number[] }>;
      };
      // Sort by index to preserve order
      data.data.sort((a, b) => a.index - b.index);
      return data.data.map((d) => d.embedding);
    }

    if (response.status === 429 && attempt < retries) {
      // Rate limited — exponential backoff with jitter
      const delay = Math.min(1000 * 2 ** attempt + Math.random() * 500, 30000);
      await sleep(delay);
      continue;
    }

    if (response.status === 401 && attempt < retries) {
      bearerToken = await requestEmbeddingAuthRefresh();
      continue;
    }

    // Token limit / bad request — bisect and retry each half
    if (response.status === 400 && texts.length > 1) {
      const mid = Math.ceil(texts.length / 2);
      const [left, right] = await Promise.all([
        embedBatchWithRetry(texts.slice(0, mid), bearerToken, retries),
        embedBatchWithRetry(texts.slice(mid), bearerToken, retries),
      ]);
      return [...left, ...right];
    }

    const error = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${error}`);
  }

  throw new Error("Unreachable");
}

// ============================================================
// Qdrant REST API
// ============================================================

async function ensureCollection(
  qdrantUrl: string,
  collectionName: string,
): Promise<void> {
  const baseUrl = qdrantUrl.replace(/\/+$/, "");

  // Check if collection exists
  const checkResp = await fetch(`${baseUrl}/collections/${collectionName}`);
  if (checkResp.ok) return;

  // Create collection with tuned HNSW for better recall
  const createResp = await fetch(`${baseUrl}/collections/${collectionName}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vectors: {
        size: EMBEDDING_DIM,
        distance: "Cosine",
        on_disk: true,
      },
      hnsw_config: {
        m: 64,
        ef_construct: 512,
        on_disk: true,
      },
    }),
  });

  if (!createResp.ok) {
    const err = await createResp.text();
    throw new Error(
      `Failed to create Qdrant collection ${collectionName}: ${err}`,
    );
  }

  // Create payload indexes for efficient filtering
  const indexes: Array<{
    field_name: string;
    field_schema: string | Record<string, unknown>;
  }> = [
    { field_name: "filePath", field_schema: "keyword" },
    { field_name: "type", field_schema: "keyword" },
    // pathSegments indexes for directory-scoped search (5 levels)
    { field_name: "pathSegments.0", field_schema: "keyword" },
    { field_name: "pathSegments.1", field_schema: "keyword" },
    { field_name: "pathSegments.2", field_schema: "keyword" },
    { field_name: "pathSegments.3", field_schema: "keyword" },
    { field_name: "pathSegments.4", field_schema: "keyword" },
    // Full-text index on codeChunk for hybrid keyword search
    {
      field_name: "codeChunk",
      field_schema: {
        type: "text",
        tokenizer: "word",
        min_token_len: 2,
        max_token_len: 40,
      },
    },
  ];

  for (const idx of indexes) {
    await fetch(`${baseUrl}/collections/${collectionName}/index`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(idx),
    });
  }
}

async function deleteCollection(
  qdrantUrl: string,
  collectionName: string,
): Promise<void> {
  const baseUrl = qdrantUrl.replace(/\/+$/, "");
  await fetch(`${baseUrl}/collections/${collectionName}`, {
    method: "DELETE",
  });
}

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

async function upsertPoints(
  qdrantUrl: string,
  collectionName: string,
  points: QdrantPoint[],
): Promise<void> {
  const baseUrl = qdrantUrl.replace(/\/+$/, "");
  const response = await fetch(
    `${baseUrl}/collections/${collectionName}/points`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points }),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Qdrant upsert failed: ${err}`);
  }
}

async function deletePoints(
  qdrantUrl: string,
  collectionName: string,
  pointIds: string[],
): Promise<void> {
  const baseUrl = qdrantUrl.replace(/\/+$/, "");
  const response = await fetch(
    `${baseUrl}/collections/${collectionName}/points/delete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: pointIds }),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Qdrant delete failed: ${err}`);
  }
}

// ============================================================
// Utilities
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
