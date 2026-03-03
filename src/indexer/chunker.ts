import type { Chunk, ChunkGranularity } from "./types.js";

// --- Constants ---

const TARGET_WINDOW = 20;
const SEARCH_RADIUS = 4;
const OVERLAP_LINES = 2;
const SMALL_FILE_THRESHOLD = 50;
const MIN_CHUNK_CHARS = 50;

// --- Module state ---

let currentGranularity: ChunkGranularity = "standard";

export function setChunkGranularity(g: ChunkGranularity): void {
  currentGranularity = g;
}

/** Tokens that commonly start a new logical block */
const BOUNDARY_TOKENS = /^\s*(function\b|class\b|export\b|import\b|def\b|async\b|const\b|let\b|var\b|interface\b|type\b|enum\b|struct\b|impl\b|pub\b|#|\/\/|\/\*|\})/;

// --- Public API ---

/**
 * Chunk a file's content into ~80-line windows with smart boundary detection.
 * Returns an empty array for empty content.
 */
export function chunkFile(
  content: string,
  filePath: string,
  relPath: string,
): Chunk[] {
  if (!content || content.trim().length === 0) {
    return [];
  }

  const lines = content.split("\n");

  // Small files → single chunk
  if (lines.length <= SMALL_FILE_THRESHOLD) {
    const trimmed = content.trim();
    if (trimmed.length < MIN_CHUNK_CHARS) return [];
    return [
      {
        content: trimmed,
        filePath,
        relPath,
        startLine: 1,
        endLine: lines.length,
      },
    ];
  }

  const chunks: Chunk[] = [];
  let cursor = 0;
  const targetWindow =
    currentGranularity === "fine" ? Math.floor(TARGET_WINDOW / 2) : TARGET_WINDOW;
  const overlapLines = currentGranularity === "fine" ? 0 : OVERLAP_LINES;

  while (cursor < lines.length) {
    const windowEnd = Math.min(cursor + targetWindow, lines.length);

    // If remaining lines fit in one chunk, take them all
    if (windowEnd >= lines.length) {
      const chunkContent = lines.slice(cursor).join("\n").trim();
      if (chunkContent.length >= MIN_CHUNK_CHARS) {
        chunks.push({
          content: chunkContent,
          filePath,
          relPath,
          startLine: cursor + 1,
          endLine: lines.length,
        });
      }
      break;
    }

    // Search for best split point around the window boundary
    const splitLine = findSplitPoint(lines, windowEnd);
    const chunkContent = lines.slice(cursor, splitLine).join("\n").trim();

    if (chunkContent.length >= MIN_CHUNK_CHARS) {
      chunks.push({
        content: chunkContent,
        filePath,
        relPath,
        startLine: cursor + 1,
        endLine: splitLine,
      });
    }

    // Advance cursor with overlap
    cursor = Math.max(splitLine - overlapLines, cursor + 1);
  }

  return chunks;
}

// --- Internals ---

/**
 * Find the best line to split at, searching around `target` within ±SEARCH_RADIUS.
 * Returns the line index (exclusive end) for the chunk.
 */
function findSplitPoint(lines: string[], target: number): number {
  const lo = Math.max(target - SEARCH_RADIUS, 0);
  const hi = Math.min(target + SEARCH_RADIUS, lines.length);

  // Priority 1: blank line closest to target
  let bestBlank = -1;
  let bestBlankDist = Infinity;
  for (let i = lo; i < hi; i++) {
    if (isBlankLine(lines[i])) {
      const dist = Math.abs(i - target);
      if (dist < bestBlankDist) {
        bestBlank = i;
        bestBlankDist = dist;
      }
    }
  }
  if (bestBlank !== -1) return bestBlank + 1;

  // Priority 2: indentation decrease (likely end of a block)
  let bestIndent = -1;
  let bestIndentDist = Infinity;
  for (let i = lo + 1; i < hi; i++) {
    const prevIndent = getIndentLevel(lines[i - 1]);
    const currIndent = getIndentLevel(lines[i]);
    if (currIndent < prevIndent && currIndent >= 0) {
      const dist = Math.abs(i - target);
      if (dist < bestIndentDist) {
        bestIndent = i;
        bestIndentDist = dist;
      }
    }
  }
  if (bestIndent !== -1) return bestIndent;

  // Priority 3: line starting with a boundary token
  let bestBoundary = -1;
  let bestBoundaryDist = Infinity;
  for (let i = lo; i < hi; i++) {
    if (BOUNDARY_TOKENS.test(lines[i])) {
      const dist = Math.abs(i - target);
      if (dist < bestBoundaryDist) {
        bestBoundary = i;
        bestBoundaryDist = dist;
      }
    }
  }
  if (bestBoundary !== -1) return bestBoundary;

  // Fallback: split at target exactly
  return target;
}

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

function getIndentLevel(line: string): number {
  if (line.trim().length === 0) return -1;
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}
