/**
 * Tree-sitter WASM-based chunker for the codebase indexer.
 *
 * Uses web-tree-sitter to parse files into ASTs, then extracts
 * symbol-boundary-aware chunks (functions, classes, interfaces, etc.)
 * that embed more meaningfully than line-based windows.
 *
 * Key features:
 * - Context-enriched embeddings: each chunk gets an `embeddingContent`
 *   field with file path (and optional parent scope) prepended
 * - Char-based sizing: ~500 char target for focused embeddings
 * - Recursive decomposition: container types (classes, interfaces) are ALWAYS
 *   decomposed into individual methods/properties for fine-grained embedding,
 *   regardless of total size
 * - Re-balancing: avoids tiny trailing chunks via MIN_CHUNK_REMAINDER_CHARS
 *
 * IMPORTANT: This file MUST NOT import "vscode".
 */

import * as path from "path";
import * as fs from "fs";
import { Parser, Language, Query } from "web-tree-sitter";
import type { Chunk, ChunkGranularity } from "./types.js";
import { LANGUAGE_QUERIES } from "./queries.js";

// --- Constants ---

const MIN_CHUNK_CHARS = 40;
const MAX_CHUNK_CHARS = 500;
const MAX_CHUNK_TOLERANCE = 1.15;
/** Effective maximum: 575 chars. Nodes under this are kept whole. */
const EFFECTIVE_MAX = Math.floor(MAX_CHUNK_CHARS * MAX_CHUNK_TOLERANCE);
const SMALL_FILE_THRESHOLD = 30;
/** Minimum size for the last chunk — avoids tiny trailing chunks like "}". */
const MIN_CHUNK_REMAINDER_CHARS = 100;

/** Maximum size for multi-scale whole-node emission. Nodes larger than this
 *  are only emitted as sub-chunks (too large for a useful embedding). */
const MULTI_SCALE_MAX = 1500;

// --- Types ---

/** Inferred SyntaxNode type from web-tree-sitter */
type ASTNode = NonNullable<
  ReturnType<InstanceType<typeof Parser>["parse"]>
>["rootNode"];

// --- Language configuration ---

/** Extension → grammar name (must match tree-sitter-{name}.wasm filename, with hyphens) */
const LANG_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "cpp",
  ".h": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".cs": "c_sharp",
  ".rb": "ruby",
  ".php": "php",
  ".css": "css",
  ".scss": "css",
  ".sh": "bash",
  ".bash": "bash",
  ".ps1": "powershell",
};

/** Per-language top-level AST node types worth extracting as individual chunks */
const EXTRACTABLE_TYPES: Record<string, Set<string>> = {
  typescript: new Set([
    "function_declaration",
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "export_statement",
    "lexical_declaration",
  ]),
  tsx: new Set([
    "function_declaration",
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "export_statement",
    "lexical_declaration",
  ]),
  javascript: new Set([
    "function_declaration",
    "class_declaration",
    "export_statement",
    "lexical_declaration",
    "variable_declaration",
  ]),
  python: new Set([
    "function_definition",
    "class_definition",
    "decorated_definition",
  ]),
  rust: new Set([
    "function_item",
    "impl_item",
    "struct_item",
    "enum_item",
    "trait_item",
    "mod_item",
    "const_item",
    "static_item",
    "type_item",
    "macro_definition",
  ]),
  go: new Set([
    "function_declaration",
    "method_declaration",
    "type_declaration",
  ]),
  java: new Set([
    "class_declaration",
    "method_declaration",
    "interface_declaration",
    "enum_declaration",
    "constructor_declaration",
  ]),
  cpp: new Set([
    "function_definition",
    "class_specifier",
    "struct_specifier",
    "enum_specifier",
    "namespace_definition",
    "template_declaration",
  ]),
  c_sharp: new Set([
    "class_declaration",
    "method_declaration",
    "interface_declaration",
    "enum_declaration",
    "struct_declaration",
    "namespace_declaration",
  ]),
  ruby: new Set(["method", "class", "module", "singleton_method"]),
  php: new Set([
    "function_definition",
    "class_declaration",
    "method_declaration",
    "interface_declaration",
    "trait_declaration",
  ]),
  css: new Set([
    "rule_set",
    "media_statement",
    "at_rule",
    "keyframes_statement",
  ]),
  bash: new Set(["function_definition"]),
};

// --- Module state ---

let initialized = false;
let parser: InstanceType<typeof Parser> | null = null;
let wasmDirectory = "";
const languageCache = new Map<string, Language>();
const queryCache = new Map<string, Query | null>();
let currentGranularity: ChunkGranularity = "standard";

export function setChunkGranularity(g: ChunkGranularity): void {
  currentGranularity = g;
}

// --- Context enrichment ---

/**
 * Build a context header for embedding content.
 * e.g. "// class Bar\n" or "" (empty when no parent scope)
 */
function buildContextHeader(parentScope?: string): string {
  if (!parentScope) return "";
  return `// ${parentScope}\n`;
}

/**
 * Extract a human-readable scope name from an AST node.
 * e.g. "class McpServerHost", "function handleRequest"
 */
function getNodeScopeName(node: ASTNode): string | null {
  // Navigate through wrapper types (export_statement, decorated_definition)
  if (
    node.type === "export_statement" ||
    node.type === "decorated_definition"
  ) {
    const inner =
      node.childForFieldName("declaration") ??
      node.childForFieldName("definition");
    if (inner) return getNodeScopeName(inner);
    return null;
  }

  const nameNode = node.childForFieldName("name");
  const name = nameNode?.text;
  if (!name) return null;

  const t = node.type;
  if (t.includes("class")) return `class ${name}`;
  if (t.includes("interface")) return `interface ${name}`;
  if (t.includes("function") || t.includes("method")) return `function ${name}`;
  if (t.includes("enum")) return `enum ${name}`;
  if (t.includes("struct")) return `struct ${name}`;
  if (t.includes("trait")) return `trait ${name}`;
  if (t.includes("impl")) return `impl ${name}`;
  if (t.includes("module") || t.includes("mod_")) return `module ${name}`;
  if (t.includes("namespace")) return `namespace ${name}`;
  return name;
}

/**
 * Unwrap wrapper node types (export_statement, decorated_definition)
 * to get the inner declaration node.
 */
function unwrapNode(node: ASTNode): ASTNode {
  if (
    node.type === "export_statement" ||
    node.type === "decorated_definition"
  ) {
    const inner =
      node.childForFieldName("declaration") ??
      node.childForFieldName("definition");
    if (inner) return inner;
  }
  return node;
}

// --- Query helpers ---

/**
 * Get or create a compiled Query for a language. Returns null if no query
 * is defined for this language or if the query string has syntax errors.
 */
function getOrCreateQuery(
  language: Language,
  grammarName: string,
): Query | null {
  const cached = queryCache.get(grammarName);
  if (cached !== undefined) return cached;

  const querySource = LANGUAGE_QUERIES[grammarName];
  if (!querySource) {
    queryCache.set(grammarName, null);
    return null;
  }

  try {
    const query = new Query(language, querySource);
    queryCache.set(grammarName, query);
    return query;
  } catch {
    queryCache.set(grammarName, null);
    return null;
  }
}

/**
 * Walk up the AST via node.parent to find the nearest container ancestor
 * (class, interface, module, etc.) and return its scope name.
 * Returns undefined if the node is at the top level.
 */
function findParentScope(node: ASTNode): string | undefined {
  let current = node.parent;
  while (current && current.parent !== null) {
    const inner = unwrapNode(current as ASTNode);
    if (isContainerType(inner.type)) {
      return getNodeScopeName(current as ASTNode) ?? undefined;
    }
    current = current.parent;
  }
  return undefined;
}

// --- Public API ---

/**
 * Initialize web-tree-sitter. Must be called once before chunking.
 * @param wasmDir Directory containing tree-sitter.wasm and grammar .wasm files
 */
export async function initTreeSitter(wasmDir?: string): Promise<void> {
  if (initialized) return;
  wasmDirectory = wasmDir ?? path.join(__dirname, "wasm");

  const wasmPath = path.join(wasmDirectory, "web-tree-sitter.wasm");
  const wasmBinary = fs.readFileSync(wasmPath);

  await Parser.init({
    wasmBinary,
    locateFile(scriptName: string) {
      return path.join(wasmDirectory, scriptName);
    },
  } as Record<string, unknown>);

  parser = new Parser();
  initialized = true;
}

/**
 * Check if tree-sitter has a grammar for this file's language.
 */
export function isTreeSitterSupported(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext in LANG_MAP;
}

/**
 * Chunk a file using tree-sitter AST analysis.
 * Returns an empty array for unsupported languages, parse failures, etc.
 */
export async function treeSitterChunkFile(
  content: string,
  filePath: string,
  relPath: string,
): Promise<Chunk[]> {
  if (!content || content.trim().length === 0) return [];
  if (!initialized || !parser) return [];

  const ext = path.extname(filePath).toLowerCase();
  const grammarName = LANG_MAP[ext];
  if (!grammarName) return [];

  const lines = content.split("\n");

  // Small files → single chunk (skip AST overhead)
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
        embeddingContent: buildContextHeader() + trimmed,
      },
    ];
  }

  try {
    const language = await loadLanguage(grammarName);
    if (!language) return [];

    parser.setLanguage(language);
    const tree = parser.parse(content);
    if (!tree) return [];

    try {
      // Try query-based extraction first (finds nodes at any depth)
      const query = getOrCreateQuery(language, grammarName);
      let chunks: Chunk[];
      if (query) {
        chunks = extractChunksWithQueries(tree, query, lines, filePath, relPath);
      } else {
        // Fallback: top-level walk with EXTRACTABLE_TYPES
        const extractable = EXTRACTABLE_TYPES[grammarName];
        if (!extractable) return [];
        chunks = extractChunks(tree, extractable, lines, filePath, relPath);
      }

      // Deduplicate in fine mode — statement chunks may overlap with standard chunks
      if (currentGranularity === "fine" && chunks.length > 0) {
        const seen = new Set<string>();
        chunks = chunks.filter((c) => {
          const key = `${c.startLine}:${c.endLine}:${c.content.length}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      return chunks;
    } finally {
      tree.delete();
    }
  } catch {
    return [];
  }
}

// --- Internals ---

async function loadLanguage(grammarName: string): Promise<Language | null> {
  const cached = languageCache.get(grammarName);
  if (cached) return cached;

  // WASM filenames use hyphens: tree-sitter-c-sharp.wasm
  const wasmFileName = `tree-sitter-${grammarName.replace(/_/g, "-")}.wasm`;
  const wasmPath = path.join(wasmDirectory, wasmFileName);

  try {
    const lang = await Language.load(wasmPath);
    languageCache.set(grammarName, lang);
    return lang;
  } catch {
    return null;
  }
}

/**
 * Walk top-level AST nodes, extracting chunks at symbol boundaries.
 * Container types (classes, interfaces) are always recursively decomposed
 * into individual methods/properties for fine-grained embedding.
 */
function extractChunks(
  tree: ReturnType<InstanceType<typeof Parser>["parse"]> & {},
  extractable: Set<string>,
  lines: string[],
  filePath: string,
  relPath: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  const root = tree.rootNode;
  let gapStartRow = 0; // 0-based line tracking where the next gap begins
  const contextHeader = buildContextHeader();

  for (const child of root.namedChildren) {
    const nodeStartRow = child.startPosition.row;
    const nodeEndRow = child.endPosition.row;

    if (extractable.has(child.type)) {
      // Emit gap chunk for lines between previous extractable and this one
      if (nodeStartRow > gapStartRow) {
        emitGapChunk(
          lines,
          gapStartRow,
          nodeStartRow,
          filePath,
          relPath,
          chunks,
          contextHeader,
        );
      }

      // Process node — may recursively decompose containers
      chunks.push(...processNode(child, lines, filePath, relPath));

      gapStartRow = nodeEndRow + 1;
    }
    // Non-extractable top-level nodes accumulate as gap text
  }

  // Trailing gap chunk (e.g., trailing comments, module.exports)
  if (gapStartRow < lines.length) {
    emitGapChunk(
      lines,
      gapStartRow,
      lines.length,
      filePath,
      relPath,
      chunks,
      contextHeader,
    );
  }

  return chunks;
}

/**
 * Extract chunks using tree-sitter query captures.
 *
 * Unlike extractChunks() which only walks root.namedChildren, this uses
 * query.captures() to find definition nodes at ANY depth in the AST.
 * Captures are processed linearly by position with gap tracking, reusing
 * processNode() for container decomposition and context enrichment.
 */
function extractChunksWithQueries(
  tree: ReturnType<InstanceType<typeof Parser>["parse"]> & {},
  query: Query,
  lines: string[],
  filePath: string,
  relPath: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  const contextHeader = buildContextHeader();

  // 1. Run captures and filter to @definition.* patterns
  const allCaptures = query.captures(tree.rootNode);
  const definitionNodes: ASTNode[] = [];
  const seen = new Set<string>(); // deduplicate by byte range

  for (const capture of allCaptures) {
    if (!capture.name.startsWith("definition")) continue;
    const key = `${capture.node.startIndex}-${capture.node.endIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    definitionNodes.push(capture.node as ASTNode);
  }

  // 2. Sort by start position (ascending), then by span size (ascending — smaller first)
  //    This ensures that at the same start row, more-specific nodes come first.
  definitionNodes.sort((a, b) => {
    const startDiff = a.startPosition.row - b.startPosition.row;
    if (startDiff !== 0) return startDiff;
    // Same start row: smaller span first
    const sizeA = a.endPosition.row - a.startPosition.row;
    const sizeB = b.endPosition.row - b.startPosition.row;
    return sizeA - sizeB;
  });

  // 3. Walk linearly with gap tracking — same algorithm as extractChunks
  //    but driven by captures instead of root.namedChildren.
  let gapStartRow = 0;

  for (const node of definitionNodes) {
    const nodeStartRow = node.startPosition.row;
    const nodeEndRow = node.endPosition.row;

    // Skip if this node is already inside a previously processed capture
    if (nodeStartRow < gapStartRow) continue;

    // Emit gap chunk for lines between previous definition and this one
    if (nodeStartRow > gapStartRow) {
      emitGapChunk(
        lines,
        gapStartRow,
        nodeStartRow,
        filePath,
        relPath,
        chunks,
        contextHeader,
      );
    }

    // Determine parent scope for context-enriched embedding
    const parentScope = findParentScope(node);

    // Process node — may recursively decompose containers
    chunks.push(...processNode(node, lines, filePath, relPath, parentScope));

    gapStartRow = nodeEndRow + 1;
  }

  // Trailing gap chunk
  if (gapStartRow < lines.length) {
    emitGapChunk(
      lines,
      gapStartRow,
      lines.length,
      filePath,
      relPath,
      chunks,
      contextHeader,
    );
  }

  return chunks;
}

/**
 * Node types that are "containers" — their body children are semantically
 * meaningful units (methods, properties) rather than statements.
 * These are always recursively decomposed regardless of size.
 */
function isContainerType(nodeType: string): boolean {
  return (
    nodeType.includes("class") ||
    nodeType.includes("interface") ||
    nodeType.includes("impl") ||
    nodeType.includes("trait") ||
    nodeType.includes("module") ||
    nodeType === "mod_item" ||
    nodeType.includes("namespace") ||
    (nodeType.includes("struct") && nodeType !== "destructuring_pattern")
  );
}

/**
 * Process a single extractable AST node.
 * Container types (classes, interfaces, modules) are always decomposed
 * into individual body children. Other types are kept as single chunks
 * unless oversized.
 */
function processNode(
  node: ASTNode,
  lines: string[],
  filePath: string,
  relPath: string,
  parentScope?: string,
): Chunk[] {
  const inner = unwrapNode(node);
  const scope = getNodeScopeName(node) ?? parentScope;

  // Only decompose container types (classes, interfaces, modules) — not functions
  if (isContainerType(inner.type)) {
    const body = inner.childForFieldName("body");
    const bodyChildren = body?.namedChildren ?? [];

    if (bodyChildren.length > 0) {
      const result = decomposeContainer(
        node,
        body!,
        bodyChildren,
        lines,
        filePath,
        relPath,
        scope,
      );
      // If decomposition produced useful chunks, return them
      if (result.length > 0) return result;
      // Fall through to single-chunk handling if decomposition yielded nothing
    }
  }

  // Non-container or no useful decomposition — single chunk or split if oversized
  const text = node.text;
  const header = buildContextHeader(parentScope);
  let result: Chunk[] = [];

  if (text.length > EFFECTIVE_MAX) {
    const subChunks = splitByCharBoundaries(
      lines,
      node.startPosition.row,
      node.endPosition.row,
      filePath,
      relPath,
      header,
    );
    // Multi-scale: also emit whole node for context-rich embedding
    if (text.length <= MULTI_SCALE_MAX) {
      const trimmed = text.trim();
      result = [
        {
          content: trimmed,
          filePath,
          relPath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          embeddingContent: header + trimmed,
        },
        ...subChunks,
      ];
    } else {
      result = subChunks;
    }
  } else if (text.trim().length >= MIN_CHUNK_CHARS) {
    const trimmed = text.trim();
    result = [
      {
        content: trimmed,
        filePath,
        relPath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        embeddingContent: header + trimmed,
      },
    ];
  }

  // Fine granularity: add statement-level chunks from function bodies
  if (currentGranularity === "fine" && result.length > 0) {
    if (!isContainerType(inner.type) && inner.childForFieldName("body")) {
      result.push(
        ...extractStatementChunks(node, lines, filePath, relPath, scope),
      );
    }
  }

  return result;
}

/**
 * Decompose a container node (class, interface, module) into individual
 * body children. Each significant child (method, property) becomes its own
 * chunk with parent scope context. Tiny children are accumulated together
 * with surrounding gap text (class header, whitespace, closing brace).
 */
function decomposeContainer(
  outerNode: ASTNode,
  body: ASTNode,
  bodyChildren: ASTNode[],
  lines: string[],
  filePath: string,
  relPath: string,
  parentScope: string | null | undefined,
): Chunk[] {
  const chunks: Chunk[] = [];
  const header = buildContextHeader(parentScope ?? undefined);
  const outerStart = outerNode.startPosition.row;
  const outerEnd = outerNode.endPosition.row;

  // Track accumulated segment start (for gap text between children)
  let segStart = outerStart;

  for (const child of bodyChildren) {
    const childText = child.text;

    // Only emit children that are individually meaningful
    if (childText.trim().length >= MIN_CHUNK_CHARS) {
      // Check gap text before this child (class header, whitespace, etc.)
      const gapLen =
        child.startPosition.row > segStart
          ? lines.slice(segStart, child.startPosition.row).join("\n").trim()
              .length
          : 0;

      if (gapLen >= MIN_CHUNK_CHARS) {
        // Large gap → emit separately, then emit child from its own start
        const gapText = lines
          .slice(segStart, child.startPosition.row)
          .join("\n")
          .trim();
        chunks.push({
          content: gapText,
          filePath,
          relPath,
          startLine: segStart + 1,
          endLine: child.startPosition.row,
          embeddingContent: header + gapText,
        });
        // Child starts from its own position
        emitChild(child.startPosition.row, child);
      } else {
        // Small gap (class header, whitespace) → merge into child chunk
        // This preserves "class Foo {\n  method1() {..." as one chunk
        emitChild(segStart, child);
      }

      segStart = child.endPosition.row + 1;
    }
    // Tiny children (< MIN_CHUNK_CHARS) accumulate with surrounding gap text
  }

  // Flush remaining text (closing brace, trailing tiny children)
  if (segStart <= outerEnd) {
    const text = lines
      .slice(segStart, outerEnd + 1)
      .join("\n")
      .trim();
    if (text.length > EFFECTIVE_MAX) {
      chunks.push(
        ...splitByCharBoundaries(
          lines,
          segStart,
          outerEnd,
          filePath,
          relPath,
          header,
        ),
      );
    } else if (text.length >= MIN_CHUNK_CHARS) {
      chunks.push({
        content: text,
        filePath,
        relPath,
        startLine: segStart + 1,
        endLine: outerEnd + 1,
        embeddingContent: header + text,
      });
    }
  }

  // Multi-scale: also emit whole container for context-rich embedding
  const containerText = outerNode.text.trim();
  if (
    containerText.length >= MIN_CHUNK_CHARS &&
    containerText.length <= MULTI_SCALE_MAX
  ) {
    chunks.unshift({
      content: containerText,
      filePath,
      relPath,
      startLine: outerStart + 1,
      endLine: outerEnd + 1,
      embeddingContent: header + containerText,
    });
  }

  return chunks;

  /** Emit a body child as a chunk, starting from chunkStartRow. */
  function emitChild(chunkStartRow: number, child: ASTNode): void {
    const chunkEndRow = child.endPosition.row;
    const text = lines
      .slice(chunkStartRow, chunkEndRow + 1)
      .join("\n")
      .trim();

    if (text.length < MIN_CHUNK_CHARS) return;

    // Check if child is itself a container needing decomposition
    const innerChild = unwrapNode(child);
    const childBody = innerChild.childForFieldName("body");
    const childBodyChildren = childBody?.namedChildren ?? [];

    if (childBodyChildren.length > 0 && text.length > EFFECTIVE_MAX) {
      // Recursive decomposition for oversized nested containers
      chunks.push(
        ...processNode(
          child,
          lines,
          filePath,
          relPath,
          parentScope ?? undefined,
        ),
      );
    } else if (text.length > EFFECTIVE_MAX) {
      // Multi-scale: emit whole child + sub-chunks
      if (text.length <= MULTI_SCALE_MAX) {
        chunks.push({
          content: text,
          filePath,
          relPath,
          startLine: chunkStartRow + 1,
          endLine: chunkEndRow + 1,
          embeddingContent: header + text,
        });
      }
      chunks.push(
        ...splitByCharBoundaries(
          lines,
          chunkStartRow,
          chunkEndRow,
          filePath,
          relPath,
          header,
        ),
      );
    } else {
      chunks.push({
        content: text,
        filePath,
        relPath,
        startLine: chunkStartRow + 1,
        endLine: chunkEndRow + 1,
        embeddingContent: header + text,
      });
    }
  }
}

/**
 * Emit a gap chunk (non-extractable lines between symbols).
 * Splits oversized gaps at char boundaries.
 */
function emitGapChunk(
  lines: string[],
  startRow: number, // 0-based inclusive
  endRow: number, // 0-based exclusive
  filePath: string,
  relPath: string,
  chunks: Chunk[],
  contextHeader: string,
): void {
  const text = lines.slice(startRow, endRow).join("\n").trim();
  if (text.length < MIN_CHUNK_CHARS) return;

  if (text.length > EFFECTIVE_MAX) {
    chunks.push(
      ...splitByCharBoundaries(
        lines,
        startRow,
        endRow - 1, // convert exclusive → inclusive
        filePath,
        relPath,
        contextHeader,
      ),
    );
  } else {
    chunks.push({
      content: text,
      filePath,
      relPath,
      startLine: startRow + 1,
      endLine: endRow, // 0-based exclusive = 1-based inclusive
      embeddingContent: contextHeader + text,
    });
  }
}

/**
 * Split a range of lines into chunks respecting EFFECTIVE_MAX char limit.
 * Includes re-balancing: when the last chunk would be too small
 * (< MIN_CHUNK_REMAINDER_CHARS), walks back the previous split point
 * to create more balanced chunks.
 */
function splitByCharBoundaries(
  lines: string[],
  startRow: number, // 0-based inclusive
  endRow: number, // 0-based inclusive
  filePath: string,
  relPath: string,
  contextHeader: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  let accumLen = 0;
  let chunkStart = startRow;

  for (let row = startRow; row <= endRow; row++) {
    const lineLen = lines[row].length;
    const newLen = accumLen > 0 ? accumLen + 1 + lineLen : lineLen; // +1 for \n

    if (newLen > EFFECTIVE_MAX && accumLen > 0) {
      // Re-balancing: check if the remainder would be too small
      let splitRow = row; // exclusive end of this chunk
      const remainderLen = lines.slice(row, endRow + 1).join("\n").length;

      if (
        remainderLen < MIN_CHUNK_REMAINDER_CHARS &&
        remainderLen > 0 &&
        splitRow - chunkStart > 1
      ) {
        // Walk back the split point to give more to the remainder
        for (let k = row - 1; k > chunkStart; k--) {
          const firstPartLen = lines.slice(chunkStart, k).join("\n").length;
          const secondPartLen = lines.slice(k, endRow + 1).join("\n").length;
          if (
            firstPartLen >= MIN_CHUNK_CHARS &&
            secondPartLen >= MIN_CHUNK_REMAINDER_CHARS
          ) {
            splitRow = k;
            break;
          }
        }
      }

      // Flush accumulated lines
      const text = lines.slice(chunkStart, splitRow).join("\n").trim();
      if (text.length >= MIN_CHUNK_CHARS) {
        chunks.push({
          content: text,
          filePath,
          relPath,
          startLine: chunkStart + 1,
          endLine: splitRow,
          embeddingContent: contextHeader + text,
        });
      }
      chunkStart = splitRow;
      // Recalculate accumLen from new chunkStart to current row
      accumLen = lines.slice(chunkStart, row + 1).join("\n").length;
    } else {
      accumLen = newLen;
    }
  }

  // Flush remainder
  if (chunkStart <= endRow) {
    const text = lines
      .slice(chunkStart, endRow + 1)
      .join("\n")
      .trim();
    if (text.length >= MIN_CHUNK_CHARS) {
      chunks.push({
        content: text,
        filePath,
        relPath,
        startLine: chunkStart + 1,
        endLine: endRow + 1,
        embeddingContent: contextHeader + text,
      });
    }
  }

  return chunks;
}

/**
 * Extract statement-level chunks from a function/method body.
 * Each named child of the body that is >= MIN_CHUNK_CHARS becomes its own chunk.
 * Skips oversized children (already covered by standard splits) and containers
 * (already decomposed). Used in "fine" granularity mode.
 */
function extractStatementChunks(
  node: ASTNode,
  lines: string[],
  filePath: string,
  relPath: string,
  parentScope?: string | null,
): Chunk[] {
  const inner = unwrapNode(node);
  const body = inner.childForFieldName("body");
  if (!body) return [];

  const header = buildContextHeader(parentScope ?? undefined);
  const chunks: Chunk[] = [];

  for (const child of body.namedChildren) {
    const text = child.text.trim();
    if (text.length < MIN_CHUNK_CHARS) continue;
    if (text.length > EFFECTIVE_MAX) continue; // already covered by standard splits
    if (isContainerType(child.type)) continue; // already decomposed

    chunks.push({
      content: text,
      filePath,
      relPath,
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
      embeddingContent: header + text,
    });
  }

  return chunks;
}
