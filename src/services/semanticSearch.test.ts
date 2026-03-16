import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "semanticSearchEnabled") return true;
        if (key === "qdrantUrl") return "http://localhost:6333";
        return fallback;
      }),
    })),
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
  },
}));

const { resolveEmbeddingAuth, fetchMock } = vi.hoisted(() => ({
  resolveEmbeddingAuth: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("../agent/providers/index.js", () => ({
  openAiCodexAuthManager: {
    resolveEmbeddingAuth,
  },
}));

global.fetch = fetchMock as typeof fetch;

import {
  extractKeywords,
  expandQuery,
  rrfMerge,
  rerankResults,
  semanticFileList,
  semanticSearch,
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
  ): {
    id: string;
    score: number;
    payload: {
      filePath: string;
      codeChunk: string;
      startLine: number;
      endLine: number;
    };
  } => ({
    id,
    score,
    payload: { filePath, codeChunk: `code ${id}`, startLine: 1, endLine: 10 },
  });

  it("ranks items appearing in both lists higher", () => {
    const vectorResults = [makeResult("a", 0.9), makeResult("b", 0.8)];
    const keywordResults = [makeResult("b", 0.7), makeResult("c", 0.6)];

    const merged = rrfMerge(vectorResults, keywordResults, 10);

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
    const keywordResults = [makeResult("d", 0.6), makeResult("e", 0.5)];

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
  ): {
    id: string;
    score: number;
    payload: {
      filePath: string;
      codeChunk: string;
      startLine: number;
      endLine: number;
    };
  } => ({
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

    expect(reranked[0].id).toBe("b");
  });

  it("boosts results with file path matches", () => {
    const results = [
      makeResult("a", 0.8, "other.ts", "some code"),
      makeResult("b", 0.75, "src/TerminalManager.ts", "some code"),
    ];

    const reranked = rerankResults(results, ["Terminal"]);

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

  it("filters .agentlink runtime artifact paths from semantic results", () => {
    const results = [
      makeResult(
        "artifact",
        0.99,
        ".agentlink/history/session/messages.json",
        "TerminalManager debug transcript",
      ),
      makeResult(
        "source",
        0.6,
        "src/integrations/TerminalManager.ts",
        "class TerminalManager {}",
      ),
    ];

    const reranked = rerankResults(results, ["TerminalManager"]);

    expect(reranked).toHaveLength(1);
    expect(reranked[0].id).toBe("source");
  });

  it("filters caller-specified exclude globs from semantic results", () => {
    const results = [
      makeResult(
        "dist-artifact",
        0.97,
        "dist/generated/TerminalManager.js",
        "compiled output",
      ),
      makeResult(
        "source",
        0.6,
        "src/integrations/TerminalManager.ts",
        "class TerminalManager {}",
      ),
    ];

    const reranked = rerankResults(
      results,
      ["TerminalManager"],
      ["**/dist/**"],
    );

    expect(reranked).toHaveLength(1);
    expect(reranked[0].id).toBe("source");
  });

  it("normalizes leading dot-slash before applying exclude globs", () => {
    const results = [
      makeResult(
        "generated",
        0.95,
        "./src/generated/types.ts",
        "generated types",
      ),
      makeResult(
        "source",
        0.6,
        "src/integrations/TerminalManager.ts",
        "class TerminalManager {}",
      ),
    ];

    const reranked = rerankResults(
      results,
      ["TerminalManager"],
      ["src/generated/**"],
    );

    expect(reranked).toHaveLength(1);
    expect(reranked[0].id).toBe("source");
  });

  it("combines all three signals", () => {
    const results = [
      makeResult("a", 0.9, "foo.ts", "unrelated stuff"),
      makeResult(
        "b",
        0.5,
        "DiffViewProvider.ts",
        "class DiffViewProvider implements open diff",
      ),
    ];

    const reranked = rerankResults(results, [
      "DiffViewProvider",
      "diff",
      "open",
    ]);

    expect(reranked[0].id).toBe("b");
  });
});

describe("semantic search auth", () => {
  beforeEach(() => {
    resolveEmbeddingAuth.mockReset();
    fetchMock.mockReset();
  });

  it("returns a helpful error when no OpenAI auth is configured", async () => {
    resolveEmbeddingAuth.mockResolvedValue(null);

    const result = await semanticFileList("/workspace", "oauth test");

    expect(result).toEqual({
      files: [],
      error:
        "OpenAI authentication not configured. Run 'AgentLink: Sign In to OpenAI/Codex' to choose ChatGPT/Codex OAuth or an OpenAI API key, or set OPENAI_API_KEY in the environment. Either method enables semantic search and indexing.",
    });
  });

  it("uses the resolved bearer token for embeddings", async () => {
    resolveEmbeddingAuth.mockResolvedValue({
      method: "oauth",
      bearerToken: "oauth-token",
      canRefresh: true,
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: [] }),
      });

    await semanticSearch("/workspace", "oauth embeddings", 5);

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.openai.com/v1/embeddings",
    );
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer oauth-token",
    });
  });
});
