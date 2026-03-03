import { describe, it, expect } from "vitest";
import {
  extractKeywords,
  expandQuery,
  rrfMerge,
  rerankResults,
} from "./semanticSearch.js";

// --- extractKeywords ---

describe("extractKeywords", () => {
  it("splits CamelCase identifiers", () => {
    const result = extractKeywords("TerminalManager");
    expect(result).toContain("TerminalManager");
    expect(result).toContain("Terminal");
    expect(result).toContain("Manager");
  });

  it("splits snake_case identifiers", () => {
    const result = extractKeywords("shell_integration");
    expect(result).toContain("shell_integration");
    expect(result).toContain("shell");
    expect(result).toContain("integration");
  });

  it("removes stop words", () => {
    const result = extractKeywords("how does the server work");
    expect(result).not.toContain("how");
    expect(result).not.toContain("does");
    expect(result).not.toContain("the");
    expect(result).toContain("server");
    expect(result).toContain("work");
  });

  it("removes code noise words", () => {
    const result = extractKeywords("function class interface");
    expect(result).toHaveLength(0);
  });

  it("filters short tokens (< 3 chars)", () => {
    const result = extractKeywords("a to by DiffView");
    expect(result).not.toContain("a");
    expect(result).not.toContain("to");
    expect(result).not.toContain("by");
    expect(result).toContain("DiffView");
  });

  it("deduplicates keywords", () => {
    const result = extractKeywords("server server Server");
    const lowerResults = result.map((r) => r.toLowerCase());
    const unique = new Set(lowerResults);
    expect(unique.size).toBe(lowerResults.length);
  });

  it("handles mixed query with identifiers and natural language", () => {
    const result = extractKeywords(
      "DiffViewProvider open diff editor approval",
    );
    expect(result).toContain("DiffViewProvider");
    expect(result).toContain("Diff");
    expect(result).toContain("open");
    // "diff" is deduplicated against "Diff" from CamelCase split (case-insensitive)
    expect(result).toContain("editor");
    expect(result).toContain("approval");
  });

  it("returns empty array for all-stop-word queries", () => {
    const result = extractKeywords("is a the");
    expect(result).toHaveLength(0);
  });
});

// --- expandQuery ---

describe("expandQuery", () => {
  it("expands CamelCase terms", () => {
    const result = expandQuery("DiffViewProvider");
    expect(result).toContain("DiffViewProvider");
    expect(result).toContain("Diff");
    expect(result).toContain("View");
    expect(result).toContain("Provider");
  });

  it("expands snake_case terms", () => {
    const result = expandQuery("shell_integration command");
    expect(result).toContain("shell_integration");
    expect(result).toContain("shell integration");
  });

  it("preserves original query for plain words", () => {
    const result = expandQuery("search files");
    expect(result).toBe("search files");
  });

  it("handles mixed CamelCase and snake_case", () => {
    const result = expandQuery("TerminalManager execute_command");
    expect(result).toContain("TerminalManager");
    expect(result).toContain("Terminal");
    expect(result).toContain("Manager");
    expect(result).toContain("execute command");
  });
});

// --- rrfMerge ---

describe("rrfMerge", () => {
  const makeResult = (
    id: string,
    score: number,
    filePath = "test.ts",
  ): { id: string; score: number; payload: { filePath: string; codeChunk: string; startLine: number; endLine: number } } => ({
    id,
    score,
    payload: { filePath, codeChunk: `code ${id}`, startLine: 1, endLine: 10 },
  });

  it("ranks items appearing in both lists higher", () => {
    const vectorResults = [makeResult("a", 0.9), makeResult("b", 0.8)];
    const keywordResults = [makeResult("b", 0.7), makeResult("c", 0.6)];

    const merged = rrfMerge(vectorResults, keywordResults, 10);

    // "b" appears in both lists → should rank highest
    expect(merged[0].id).toBe("b");
  });

  it("includes items from both lists", () => {
    const vectorResults = [makeResult("a", 0.9)];
    const keywordResults = [makeResult("b", 0.7)];

    const merged = rrfMerge(vectorResults, keywordResults, 10);

    expect(merged).toHaveLength(2);
    const ids = merged.map((r) => r.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  it("respects the limit parameter", () => {
    const vectorResults = [
      makeResult("a", 0.9),
      makeResult("b", 0.8),
      makeResult("c", 0.7),
    ];
    const keywordResults = [
      makeResult("d", 0.6),
      makeResult("e", 0.5),
    ];

    const merged = rrfMerge(vectorResults, keywordResults, 3);
    expect(merged).toHaveLength(3);
  });

  it("handles empty keyword results", () => {
    const vectorResults = [makeResult("a", 0.9), makeResult("b", 0.8)];
    const merged = rrfMerge(vectorResults, [], 10);

    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe("a");
  });

  it("handles empty vector results", () => {
    const keywordResults = [makeResult("a", 0.7)];
    const merged = rrfMerge([], keywordResults, 10);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("a");
  });
});

// --- rerankResults ---

describe("rerankResults", () => {
  const makeResult = (
    id: string,
    score: number,
    filePath: string,
    codeChunk: string,
  ): { id: string; score: number; payload: { filePath: string; codeChunk: string; startLine: number; endLine: number } } => ({
    id,
    score,
    payload: { filePath, codeChunk, startLine: 1, endLine: 10 },
  });

  it("boosts results containing query keywords in code", () => {
    const results = [
      makeResult("a", 0.8, "other.ts", "unrelated code here"),
      makeResult("b", 0.7, "manager.ts", "class TerminalManager { }"),
    ];

    const reranked = rerankResults(results, ["TerminalManager"]);

    // "b" should be boosted above "a" despite lower vector score
    // because it contains the keyword "TerminalManager"
    expect(reranked[0].id).toBe("b");
  });

  it("boosts results with file path matches", () => {
    const results = [
      makeResult("a", 0.8, "other.ts", "some code"),
      makeResult("b", 0.75, "src/TerminalManager.ts", "some code"),
    ];

    const reranked = rerankResults(results, ["Terminal"]);

    // "b" has the keyword in the file path — should get boosted
    expect(reranked[0].id).toBe("b");
  });

  it("returns results unchanged when no keywords", () => {
    const results = [
      makeResult("a", 0.9, "a.ts", "code a"),
      makeResult("b", 0.8, "b.ts", "code b"),
    ];

    const reranked = rerankResults(results, []);

    expect(reranked[0].id).toBe("a");
    expect(reranked[1].id).toBe("b");
  });

  it("combines all three signals", () => {
    const results = [
      makeResult("a", 0.9, "foo.ts", "unrelated stuff"),
      makeResult("b", 0.5, "DiffViewProvider.ts", "class DiffViewProvider implements open diff"),
    ];

    // "b" has much lower vector score but keyword + path match
    const reranked = rerankResults(results, ["DiffViewProvider", "diff", "open"]);

    // b: vector=0.5*0.6=0.3, keyword=3/3*0.25=0.25, path=1/3*0.15=0.05 = 0.6
    // a: vector=0.9*0.6=0.54, keyword=0/3*0.25=0, path=0/3*0.15=0 = 0.54
    expect(reranked[0].id).toBe("b");
  });
});
