import * as vscode from "vscode";
import * as path from "path";
import { createHash } from "crypto";
import picomatch from "picomatch";

import {
  openAiCodexAuthManager,
  type OpenAiCodexResolvedAuth,
} from "../agent/providers/index.js";
import { tryGetFirstWorkspaceRoot } from "../util/paths.js";
import {
  execRipgrepSearch,
  getRipgrepBinPath,
  parseRipgrepOutput,
} from "../util/ripgrep.js";

import { type ToolResult } from "../shared/types.js";
import { getSemanticReadinessMessage } from "../shared/semanticReadiness.js";

// --- Configuration helpers (exported for IndexerManager) ---

export function getQdrantUrl(): string {
  return vscode.workspace
    .getConfiguration("agentlink")
    .get<string>("qdrantUrl", "http://localhost:6333");
}

const EMBEDDING_MAX_RETRIES = 3;

export async function getEmbeddingAuth(): Promise<OpenAiCodexResolvedAuth | null> {
  return openAiCodexAuthManager.resolveEmbeddingAuth();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableEmbeddingStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function isSemanticSearchEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("agentlink")
    .get<boolean>("semanticSearchEnabled", false);
}

function semanticErrorPayload(
  reason:
    | "disabled"
    | "missing_embeddings_auth"
    | "no_workspace"
    | "missing_index"
    | "qdrant_unavailable"
    | "generic_error",
  options?: { detail?: string },
): Record<string, unknown> {
  const message = getSemanticReadinessMessage(reason);
  return {
    error: options?.detail ?? message,
    reason,
    readiness_message: message,
    next_steps:
      reason === "disabled"
        ? [
            "Set agentlink.semanticSearchEnabled to true in settings.",
            "Run 'AgentLink: Set Up Semantic Search' for guided setup.",
          ]
        : reason === "missing_embeddings_auth"
          ? [
              "Run 'AgentLink: Set OpenAI API Key for Embeddings'.",
              "Or run 'AgentLink: Set Up Semantic Search' and choose API-key setup.",
            ]
          : reason === "no_workspace"
            ? ["Open a workspace folder and retry semantic search."]
            : reason === "missing_index"
              ? [
                  "Run 'AgentLink: Rebuild Codebase Index'.",
                  "Or click 'Index Codebase' in the AgentLink sidebar.",
                ]
              : reason === "qdrant_unavailable"
                ? [
                    "Ensure Qdrant is running at the configured agentlink.qdrantUrl.",
                    "Check AgentLink output logs and retry semantic search.",
                  ]
                : [
                    "Retry semantic search after resolving the underlying error.",
                  ],
  };
}

function classifySemanticReasonFromError(
  message: string,
): "missing_index" | "qdrant_unavailable" | undefined {
  if (/No codebase index found/i.test(message)) return "missing_index";
  if (/Qdrant is not reachable/i.test(message)) return "qdrant_unavailable";
  return undefined;
}

// --- Collection name derivation ---

/** AgentLink collection name (al- prefix) */
export function getAlCollectionName(workspacePath: string): string {
  const hash = createHash("sha256").update(workspacePath).digest("hex");
  return `al-${hash.substring(0, 16)}`;
}

// --- OpenAI Embeddings via fetch ---

async function generateEmbedding(
  text: string,
  auth: OpenAiCodexResolvedAuth,
): Promise<number[]> {
  for (let attempt = 0; attempt <= EMBEDDING_MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.bearerToken}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text,
        }),
      });
    } catch (error) {
      if (attempt < EMBEDDING_MAX_RETRIES) {
        const delay = Math.min(500 * 2 ** attempt + Math.random() * 250, 5000);
        await sleep(delay);
        continue;
      }
      throw error;
    }

    if (response.ok) {
      const data = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      const embedding = data.data?.[0]?.embedding;
      if (!embedding) {
        throw new Error("OpenAI API returned no embedding data");
      }
      return embedding;
    }

    if (
      attempt < EMBEDDING_MAX_RETRIES &&
      isRetryableEmbeddingStatus(response.status)
    ) {
      const delay = Math.min(500 * 2 ** attempt + Math.random() * 250, 5000);
      await sleep(delay);
      continue;
    }

    const error = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${error}`);
  }

  throw new Error("Unreachable");
}

// --- Qdrant REST API ---

interface QdrantPayload {
  filePath: string;
  codeChunk: string;
  startLine: number;
  endLine: number;
  type?: string;
}

interface QdrantSearchResult {
  id: string | number;
  score: number;
  payload?: QdrantPayload;
}

// --- Query enhancement (Phase 3) ---

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "both",
  "either",
  "neither",
  "each",
  "every",
  "all",
  "any",
  "few",
  "more",
  "most",
  "some",
  "such",
  "no",
  "only",
  "own",
  "same",
  "than",
  "too",
  "very",
  "just",
  "because",
  "as",
  "until",
  "while",
  "of",
  "at",
  "by",
  "for",
  "with",
  "about",
  "against",
  "between",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "to",
  "from",
  "up",
  "down",
  "in",
  "out",
  "on",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
]);

/** Code-specific words that are too generic for keyword matching */
const CODE_NOISE_WORDS = new Set([
  "function",
  "class",
  "const",
  "let",
  "var",
  "import",
  "export",
  "return",
  "new",
  "type",
  "interface",
  "enum",
  "struct",
  "impl",
  "def",
  "self",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "string",
  "number",
  "boolean",
  "int",
  "public",
  "private",
  "static",
  "async",
  "await",
  "try",
  "catch",
  "throw",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "use",
  "using",
  "get",
  "set",
]);

/**
 * Extract meaningful keywords from a search query.
 * Splits CamelCase and snake_case, removes stop words and code noise.
 */
export function extractKeywords(query: string): string[] {
  const tokens: string[] = [];

  // Split the query into raw words
  const rawWords = query.split(/[\s,;:.()[\]{}<>'"]+/).filter(Boolean);

  for (const word of rawWords) {
    // Split CamelCase: "TerminalManager" → ["Terminal", "Manager"]
    const camelParts = word
      .split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
      .filter(Boolean);
    if (camelParts.length > 1) {
      tokens.push(word); // keep original CamelCase term
      tokens.push(...camelParts);
    }

    // Split snake_case / kebab-case
    const snakeParts = word.split(/[_-]/).filter(Boolean);
    if (snakeParts.length > 1) {
      tokens.push(word); // keep original
      tokens.push(...snakeParts);
    }

    // Always add the original word
    if (camelParts.length <= 1 && snakeParts.length <= 1) {
      tokens.push(word);
    }
  }

  // Deduplicate, filter short words, stop words, and code noise
  const seen = new Set<string>();
  return tokens.filter((t) => {
    const lower = t.toLowerCase();
    if (lower.length < 3) return false;
    if (STOP_WORDS.has(lower)) return false;
    if (CODE_NOISE_WORDS.has(lower)) return false;
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

/**
 * Expand query text for better embedding recall.
 * Adds split forms of CamelCase and snake_case terms.
 */
export function expandQuery(query: string): string {
  let expanded = query;

  // CamelCase splitting: "DiffViewProvider" → append "Diff View Provider"
  const camelMatches = query.match(/[A-Z][a-z]+(?=[A-Z])|[A-Z][a-z]+/g);
  if (camelMatches && camelMatches.length > 1) {
    expanded += " " + camelMatches.join(" ");
  }

  // snake_case splitting: "shell_integration" → append "shell integration"
  const words = query.split(/\s+/);
  for (const word of words) {
    if (word.includes("_")) {
      expanded += " " + word.replace(/_/g, " ");
    }
  }

  return expanded;
}

// --- Hybrid search helpers ---

/**
 * Reciprocal Rank Fusion: merge results from multiple retrieval strategies.
 * Items appearing in multiple lists get boosted scores.
 */
export function rrfMerge(
  vectorResults: QdrantSearchResult[],
  keywordResults: QdrantSearchResult[],
  limit: number,
  k: number = 60,
): QdrantSearchResult[] {
  const scores = new Map<
    string,
    { score: number; result: QdrantSearchResult }
  >();

  vectorResults.forEach((r, rank) => {
    const id = String(r.id);
    const rrfScore = 1 / (k + rank + 1);
    scores.set(id, { score: rrfScore, result: r });
  });

  keywordResults.forEach((r, rank) => {
    const id = String(r.id);
    const rrfScore = 1 / (k + rank + 1);
    const existing = scores.get(id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(id, { score: rrfScore, result: r });
    }
  });

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ result }) => result);
}

/**
 * Rescore results using multiple signals: vector similarity, keyword overlap, path relevance.
 */
function normalizeSemanticResultPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function isExcludedSemanticResultPath(filePath: string): boolean {
  const normalized = normalizeSemanticResultPath(filePath).toLowerCase();
  const withLeadingSlash = normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;
  return (
    withLeadingSlash.includes("/.agentlink/history/") ||
    withLeadingSlash.includes("/.agentlink/debug/") ||
    withLeadingSlash.includes("/.agentlink/transcripts/") ||
    withLeadingSlash.includes("/.agentlink/checkpoints/")
  );
}

function applySemanticResultExcludes(
  results: QdrantSearchResult[],
  excludeGlobs?: string[],
): QdrantSearchResult[] {
  if (!excludeGlobs || excludeGlobs.length === 0) {
    return results;
  }

  const matchers = excludeGlobs.map((pattern) =>
    picomatch(pattern, { dot: true }),
  );
  return results.filter((result) => {
    const filePath = result.payload?.filePath;
    if (!filePath) return true;
    const normalized = normalizeSemanticResultPath(filePath);
    return !matchers.some((matcher) => matcher(normalized));
  });
}

export function rerankResults(
  results: QdrantSearchResult[],
  queryKeywords: string[],
  excludeGlobs?: string[],
): QdrantSearchResult[] {
  const filtered = applySemanticResultExcludes(
    results.filter(
      (r) => !isExcludedSemanticResultPath(r.payload?.filePath ?? ""),
    ),
    excludeGlobs,
  );

  if (queryKeywords.length === 0) return filtered;

  return filtered
    .map((r) => {
      const chunk = (r.payload?.codeChunk ?? "").toLowerCase();
      const filePath = (r.payload?.filePath ?? "").toLowerCase();

      // Signal 1: Vector similarity (already in r.score)
      const vectorScore = r.score;

      // Signal 2: Keyword overlap — fraction of query keywords appearing in chunk
      const keywordHits = queryKeywords.filter((kw) =>
        chunk.includes(kw.toLowerCase()),
      ).length;
      const keywordScore = keywordHits / queryKeywords.length;

      // Signal 3: File path relevance — do query terms appear in file path
      const pathHits = queryKeywords.filter((kw) =>
        filePath.includes(kw.toLowerCase()),
      ).length;
      const pathScore = pathHits / queryKeywords.length;

      // Weighted combination
      const finalScore =
        vectorScore * 0.6 + keywordScore * 0.25 + pathScore * 0.15;

      return { ...r, score: finalScore };
    })
    .sort((a, b) => b.score - a.score);
}

// --- Qdrant query functions ---

/** Build the base filter object for Qdrant queries */
function buildQdrantFilter(directoryPrefix?: string): Record<string, unknown> {
  const mustNot = [{ key: "type", match: { value: "metadata" } }];
  const must: Array<{ key: string; match: { value: string } }> = [];

  if (directoryPrefix) {
    const normalized = path.posix.normalize(
      directoryPrefix.replace(/\\/g, "/"),
    );
    if (normalized !== "." && normalized !== "./") {
      const cleaned = normalized.startsWith("./")
        ? normalized.slice(2)
        : normalized;
      const segments = cleaned.split("/").filter(Boolean);
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        // Skip segments with special characters that could cause Qdrant filter issues
        if (/^[a-zA-Z0-9._\-@]+$/.test(segment)) {
          must.push({
            key: `pathSegments.${index}`,
            match: { value: segment },
          });
        }
      }
    }
  }

  const filter: Record<string, unknown> = { must_not: mustNot };
  if (must.length > 0) {
    filter.must = must;
  }
  return filter;
}

/** Execute a vector-only search against Qdrant */
async function queryQdrantVector(
  qdrantUrl: string,
  collectionName: string,
  queryVector: number[],
  directoryPrefix?: string,
  limit: number = 10,
  scoreThreshold: number = 0.35,
): Promise<QdrantSearchResult[]> {
  const filter = buildQdrantFilter(directoryPrefix);

  const body = {
    query: queryVector,
    filter,
    score_threshold: scoreThreshold,
    limit,
    params: { hnsw_ef: 256, exact: false },
    with_payload: {
      include: ["filePath", "codeChunk", "startLine", "endLine"],
    },
  };

  const url = `${qdrantUrl.replace(/\/+$/, "")}/collections/${collectionName}/points/query`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Qdrant is not reachable at ${qdrantUrl}. Ensure Qdrant is running. (${message})`,
    );
  }

  if (!response.ok) {
    const error = await response.text();
    if (response.status === 404) {
      throw new Error(
        `No codebase index found (collection: ${collectionName}).`,
      );
    }
    throw new Error(`Qdrant API error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as {
    result?: { points?: QdrantSearchResult[] };
  };
  return data.result?.points ?? [];
}

/** Execute a vector search filtered by keyword text match */
async function queryQdrantWithTextFilter(
  qdrantUrl: string,
  collectionName: string,
  queryVector: number[],
  keywords: string[],
  directoryPrefix?: string,
  limit: number = 20,
): Promise<QdrantSearchResult[]> {
  const baseFilter = buildQdrantFilter(directoryPrefix);

  // Add text match filter — at least one keyword must appear (should = OR)
  const textConditions = keywords.map((kw) => ({
    key: "codeChunk",
    match: { text: kw },
  }));

  // Wrap the base filter's must conditions + text filter together
  const filter = {
    ...baseFilter,
    must: [
      ...(Array.isArray(baseFilter.must) ? baseFilter.must : []),
      { should: textConditions },
    ],
  };

  const body = {
    query: queryVector,
    filter,
    score_threshold: 0.2, // lower threshold since we have keyword signal
    limit,
    params: { hnsw_ef: 256, exact: false },
    with_payload: {
      include: ["filePath", "codeChunk", "startLine", "endLine"],
    },
  };

  const url = `${qdrantUrl.replace(/\/+$/, "")}/collections/${collectionName}/points/query`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) return []; // silently fall back to vector-only
    const data = (await response.json()) as {
      result?: { points?: QdrantSearchResult[] };
    };
    return data.result?.points ?? [];
  } catch {
    return []; // silently fall back to vector-only
  }
}

/**
 * Hybrid search: combines vector similarity with keyword matching via RRF,
 * then reranks with multi-signal scoring.
 */
async function queryQdrant(
  qdrantUrl: string,
  collectionName: string,
  queryVector: number[],
  queryText: string,
  directoryPrefix?: string,
  limit: number = 10,
  excludeGlobs?: string[],
): Promise<QdrantSearchResult[]> {
  const keywords = extractKeywords(queryText);
  const fetchLimit = Math.max(limit * 3, 20);

  // Run vector and keyword-filtered searches in parallel
  const [vectorResults, keywordResults] = await Promise.all([
    queryQdrantVector(
      qdrantUrl,
      collectionName,
      queryVector,
      directoryPrefix,
      fetchLimit,
    ),
    keywords.length > 0
      ? queryQdrantWithTextFilter(
          qdrantUrl,
          collectionName,
          queryVector,
          keywords,
          directoryPrefix,
          fetchLimit,
        )
      : Promise.resolve([]),
  ]);

  // Merge with RRF
  const merged =
    keywordResults.length > 0
      ? rrfMerge(vectorResults, keywordResults, fetchLimit)
      : vectorResults;

  // Rerank with multi-signal scoring
  const reranked = rerankResults(merged, keywords, excludeGlobs);

  return reranked.slice(0, limit);
}

// --- Result formatting ---

interface FormattedResult {
  file: string;
  score: number;
  startLine: number;
  endLine: number;
  codeChunk: string;
}

interface BuildOutputOptions {
  semantic?: boolean;
  warning?: string;
}

function formatResults(results: QdrantSearchResult[]): FormattedResult[] {
  return results
    .filter(
      (r) =>
        r.payload?.filePath &&
        !isExcludedSemanticResultPath(r.payload.filePath ?? ""),
    )
    .map((r) => ({
      file: r.payload!.filePath,
      score: r.score,
      startLine: r.payload!.startLine,
      endLine: r.payload!.endLine,
      codeChunk: r.payload!.codeChunk?.trim() ?? "",
    }));
}

function buildOutput(
  query: string,
  results: FormattedResult[],
  options: BuildOutputOptions = {},
): ToolResult {
  const sections = results.map((r) => {
    return `## ${r.file} (score: ${r.score.toFixed(4)}, lines ${r.startLine}-${r.endLine})\n${r.codeChunk}`;
  });

  const output: Record<string, unknown> = {
    query,
    semantic: options.semantic ?? true,
    total_results: results.length,
    results: sections.join("\n\n"),
  };

  if (options.warning) {
    output.warning = options.warning;
  }

  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}

function escapeRegexLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldFallbackToKeywordSearch(message: string): boolean {
  return (
    /OpenAI API error \((408|429|5\d\d)\):/i.test(message) ||
    /\b(fetch failed|network|ECONN|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timeout)\b/i.test(
      message,
    ) ||
    /Qdrant is not reachable/i.test(message) ||
    /Qdrant API error \((408|429|5\d\d)\):/i.test(message)
  );
}

function summarizeSemanticFailure(message: string): string {
  const openAiStatus = message.match(/OpenAI API error \((\d+)\):/i)?.[1];
  if (openAiStatus) {
    return `OpenAI embeddings failed with HTTP ${openAiStatus}`;
  }
  if (/Qdrant/i.test(message)) {
    return "the Qdrant search backend failed";
  }
  if (
    /\b(fetch failed|network|ECONN|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timeout)\b/i.test(
      message,
    )
  ) {
    return "a network error interrupted semantic search";
  }
  return "semantic search failed";
}

function normalizeFallbackResultPath(
  filePath: string,
  workspacePath: string,
  dirPath: string,
): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (!path.isAbsolute(filePath)) {
    return normalized.startsWith("./") ? normalized.slice(2) : normalized;
  }

  const workspaceRelative = path.relative(workspacePath, filePath);
  if (
    !workspaceRelative.startsWith("..") &&
    !path.isAbsolute(workspaceRelative)
  ) {
    return workspaceRelative.replace(/\\/g, "/");
  }

  const dirRelative = path.relative(dirPath, filePath);
  if (!dirRelative.startsWith("..") && !path.isAbsolute(dirRelative)) {
    return dirRelative.replace(/\\/g, "/");
  }

  return normalized;
}

async function keywordFallbackSearch(
  dirPath: string,
  query: string,
  limit: number,
  excludeGlobs?: string[],
): Promise<FormattedResult[]> {
  const rawTerms = extractKeywords(query);
  const searchTerms = (rawTerms.length > 0 ? rawTerms : query.split(/\s+/))
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 8);

  if (searchTerms.length === 0) {
    return [];
  }

  const rgPath = await getRipgrepBinPath();
  const regex = searchTerms.map(escapeRegexLiteral).join("|");
  const args = ["--json", "-n", "-i", "-C", "1", "-m", "3"];

  for (const glob of excludeGlobs ?? []) {
    args.push("--glob", `!${glob}`);
  }

  args.push(regex, dirPath);

  const output = await execRipgrepSearch(rgPath, args);
  const workspacePath = tryGetFirstWorkspaceRoot() ?? dirPath;
  const parsed = parseRipgrepOutput(output, dirPath);

  return parsed.results
    .map((fileResult) => {
      const lines = fileResult.searchResults.flatMap((result) => result.lines);
      const matchLines = lines.filter((line) => line.isMatch);
      if (matchLines.length === 0) {
        return null;
      }

      const normalizedFile = normalizeFallbackResultPath(
        fileResult.file,
        workspacePath,
        dirPath,
      );
      if (isExcludedSemanticResultPath(normalizedFile)) {
        return null;
      }

      const pathLower = normalizedFile.toLowerCase();
      const contentLower = lines
        .map((line) => line.text)
        .join("\n")
        .toLowerCase();
      const distinctPathTerms = searchTerms.filter((term) =>
        pathLower.includes(term.toLowerCase()),
      ).length;
      const distinctContentTerms = searchTerms.filter((term) =>
        contentLower.includes(term.toLowerCase()),
      ).length;
      const score =
        distinctPathTerms * 100 + distinctContentTerms * 25 + matchLines.length;
      const snippetLines = lines.slice(0, 8);
      const startLine = Math.min(...snippetLines.map((line) => line.line));
      const endLine = Math.max(...snippetLines.map((line) => line.line));
      const codeChunk = snippetLines
        .map((line) => `${line.line} | ${line.text.trimEnd()}`)
        .join("\n");

      return {
        file: normalizedFile,
        score,
        startLine,
        endLine,
        codeChunk,
      } satisfies FormattedResult;
    })
    .filter((result): result is FormattedResult => result != null)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit);
}

// --- Semantic helpers for other tools ---

/**
 * Query the index for chunks in a specific file matching a query.
 * Returns the best matching line range, or null if unavailable/no results.
 * Used by read_file to jump to the most relevant section.
 */
export async function semanticFileQuery(
  relFilePath: string,
  query: string,
): Promise<{ startLine: number; endLine: number } | null> {
  if (!isSemanticSearchEnabled()) return null;

  const auth = await getEmbeddingAuth();
  if (!auth) return null;

  const qdrantUrl = getQdrantUrl();
  const workspacePath = tryGetFirstWorkspaceRoot();
  if (!workspacePath) return null;

  const collectionName = getAlCollectionName(workspacePath);

  // Normalize to forward slashes for Qdrant filePath matching
  const normalizedPath = relFilePath.replace(/\\/g, "/");

  try {
    const expandedQuery = expandQuery(query);
    const queryVector = await generateEmbedding(expandedQuery, auth);

    // Build filter: must match this exact file
    const filter: Record<string, unknown> = {
      must_not: [{ key: "type", match: { value: "metadata" } }],
      must: [{ key: "filePath", match: { value: normalizedPath } }],
    };

    const body = {
      query: queryVector,
      filter,
      score_threshold: 0.25,
      limit: 3,
      params: { hnsw_ef: 256, exact: false },
      with_payload: { include: ["startLine", "endLine"] },
    };

    const url = `${qdrantUrl.replace(/\/+$/, "")}/collections/${collectionName}/points/query`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      result?: {
        points?: Array<{ payload?: { startLine?: number; endLine?: number } }>;
      };
    };
    const points = data.result?.points;
    if (!points || points.length === 0) return null;

    // Return the best match's line range
    const best = points[0].payload;
    if (best?.startLine == null || best?.endLine == null) return null;
    return { startLine: best.startLine, endLine: best.endLine };
  } catch {
    return null;
  }
}

/**
 * Query the index and return files ranked by semantic relevance.
 * Deduplicates by filePath, using the best score per file.
 * Used by list_files to find relevant files without knowing exact names.
 */
export async function semanticFileList(
  dirPath: string,
  query: string,
  limit: number = 20,
): Promise<{
  files: Array<{ path: string; score: number }>;
  error?: string;
} | null> {
  if (!isSemanticSearchEnabled()) {
    return {
      files: [],
      ...semanticErrorPayload("disabled"),
    };
  }

  const auth = await getEmbeddingAuth();
  if (!auth) {
    return {
      files: [],
      ...semanticErrorPayload("missing_embeddings_auth"),
    };
  }

  const qdrantUrl = getQdrantUrl();
  const workspacePath = tryGetFirstWorkspaceRoot();
  if (!workspacePath) {
    return { files: [], ...semanticErrorPayload("no_workspace") };
  }

  const collectionName = getAlCollectionName(workspacePath);
  const relativeDir = path.relative(workspacePath, dirPath);
  const directoryPrefix = relativeDir === "" ? undefined : relativeDir;

  try {
    const expandedQuery = expandQuery(query);
    const queryVector = await generateEmbedding(expandedQuery, auth);

    // Fetch more chunks than limit since multiple chunks map to the same file
    const fetchLimit = limit * 5;

    const results = await queryQdrant(
      qdrantUrl,
      collectionName,
      queryVector,
      query,
      directoryPrefix,
      fetchLimit,
    );

    // Deduplicate by filePath, keeping the best score per file
    const fileScores = new Map<string, number>();
    for (const r of results) {
      const fp = r.payload?.filePath;
      if (!fp) continue;
      const existing = fileScores.get(fp);
      if (existing == null || r.score > existing) {
        fileScores.set(fp, r.score);
      }
    }

    // Sort by score descending, take top `limit`
    const ranked = [...fileScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([fp, score]) => ({ path: fp, score }));

    return { files: ranked };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = classifySemanticReasonFromError(msg);
    if (reason) {
      return { files: [], ...semanticErrorPayload(reason, { detail: msg }) };
    }
    return { files: [], error: msg };
  }
}

// --- Main entry point ---

export async function semanticSearch(
  dirPath: string,
  query: string,
  limit?: number,
  excludeGlobs?: string[],
): Promise<ToolResult> {
  if (!isSemanticSearchEnabled()) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(semanticErrorPayload("disabled")),
        },
      ],
    };
  }

  const auth = await getEmbeddingAuth();
  if (!auth) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(semanticErrorPayload("missing_embeddings_auth")),
        },
      ],
    };
  }

  const qdrantUrl = getQdrantUrl();
  const workspacePath = tryGetFirstWorkspaceRoot();
  if (!workspacePath) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(semanticErrorPayload("no_workspace")),
        },
      ],
    };
  }
  const collectionName = getAlCollectionName(workspacePath);

  // Compute directory prefix relative to workspace
  const relativeDir = path.relative(workspacePath, dirPath);
  const directoryPrefix = relativeDir === "" ? undefined : relativeDir;

  try {
    // Expand query for better embedding recall, then embed
    const expandedQuery = expandQuery(query);
    const queryVector = await generateEmbedding(expandedQuery, auth);
    const effectiveLimit = limit ?? 10;

    const results = await queryQdrant(
      qdrantUrl,
      collectionName,
      queryVector,
      query,
      directoryPrefix,
      effectiveLimit,
      excludeGlobs,
    );
    return buildOutput(query, formatResults(results));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const effectiveLimit = limit ?? 10;

    if (shouldFallbackToKeywordSearch(msg)) {
      try {
        const fallbackResults = await keywordFallbackSearch(
          dirPath,
          query,
          effectiveLimit,
          excludeGlobs,
        );
        return buildOutput(query, fallbackResults, {
          semantic: false,
          warning: `Semantic search is temporarily unavailable (${summarizeSemanticFailure(msg)}); showing keyword-based fallback results instead.`,
        });
      } catch (fallbackError) {
        const fallbackMessage =
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: msg,
                fallback_error: fallbackMessage,
              }),
            },
          ],
        };
      }
    }

    const reason = classifySemanticReasonFromError(msg);
    if (reason) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(semanticErrorPayload(reason, { detail: msg })),
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
    };
  }
}
