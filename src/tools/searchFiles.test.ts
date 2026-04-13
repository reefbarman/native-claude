import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";

const {
  execRipgrepSearch,
  getRipgrepBinPath,
  semanticSearch,
  resolveAndValidatePath,
  tryGetFirstWorkspaceRoot,
} = vi.hoisted(() => ({
  execRipgrepSearch: vi.fn(),
  getRipgrepBinPath: vi.fn(),
  semanticSearch: vi.fn(),
  resolveAndValidatePath: vi.fn(),
  tryGetFirstWorkspaceRoot: vi.fn(),
}));

vi.mock("../util/ripgrep.js", async () => {
  const actual =
    await vi.importActual<typeof import("../util/ripgrep.js")>(
      "../util/ripgrep.js",
    );
  return {
    ...actual,
    execRipgrepSearch,
    getRipgrepBinPath,
  };
});

vi.mock("../services/semanticSearch.js", () => ({
  semanticSearch,
}));

vi.mock("../util/paths.js", () => ({
  resolveAndValidatePath,
  tryGetFirstWorkspaceRoot,
}));

import {
  sanitizeRegex,
  getEscapingHint,
  needsMultiline,
  resolveFilePatternAsPath,
  expandSimpleBraceGlob,
  handleSearchFiles,
} from "./searchFiles.js";

describe("handleSearchFiles ripgrep args", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRipgrepBinPath.mockResolvedValue("rg");
    execRipgrepSearch.mockResolvedValue("");
    semanticSearch.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ total_matches: 0 }) }],
    });
    const resolvedPath = path.resolve(".");
    resolveAndValidatePath.mockReturnValue({
      absolutePath: resolvedPath,
      inWorkspace: true,
    });
    tryGetFirstWorkspaceRoot.mockReturnValue(resolvedPath);
  });

  it("adds default .git and node_modules exclude globs", async () => {
    await handleSearchFiles(
      { path: ".", regex: "workflowStepIdx", semantic: false },
      {
        isPathTrusted: () => true,
      } as never,
      {} as never,
      "session-1",
    );

    expect(execRipgrepSearch).toHaveBeenCalledTimes(1);
    const args = execRipgrepSearch.mock.calls[0][1] as string[];
    expect(args).toContain("--glob");
    expect(args).toContain("!**/.git/**");
    expect(args).toContain("!**/node_modules/**");
  });

  it("passes search dir as cwd to ripgrep execution", async () => {
    await handleSearchFiles(
      {
        path: ".",
        regex: "workflowStepIdx",
        file_pattern: "src/**/*.ts",
        semantic: false,
      },
      {
        isPathTrusted: () => true,
      } as never,
      {} as never,
      "session-2",
    );

    expect(execRipgrepSearch).toHaveBeenCalledTimes(1);
    const options = execRipgrepSearch.mock.calls[0][2] as
      | { cwd?: string }
      | undefined;
    expect(options?.cwd).toBe(path.resolve("."));
  });

  it("keeps excludes when file_pattern globs are provided", async () => {
    await handleSearchFiles(
      {
        path: ".",
        regex: "workflowStepIdx",
        file_pattern: "templates/templates/**/*.ts",
        semantic: false,
      },
      {
        isPathTrusted: () => true,
      } as never,
      {} as never,
      "session-3",
    );

    expect(execRipgrepSearch).toHaveBeenCalledTimes(1);
    const args = execRipgrepSearch.mock.calls[0][1] as string[];
    expect(args).toContain("!**/.git/**");
    expect(args).toContain("!**/node_modules/**");
    expect(args).toContain("templates/templates/**/*.ts");
  });
});

describe("sanitizeRegex", () => {
  it("collapses double-escaped character classes", () => {
    // \\s → \s, \\d → \d, etc.
    expect(sanitizeRegex("\\\\s")).toBe("\\s");
    expect(sanitizeRegex("\\\\S")).toBe("\\S");
    expect(sanitizeRegex("\\\\d")).toBe("\\d");
    expect(sanitizeRegex("\\\\D")).toBe("\\D");
    expect(sanitizeRegex("\\\\w")).toBe("\\w");
    expect(sanitizeRegex("\\\\W")).toBe("\\W");
    expect(sanitizeRegex("\\\\b")).toBe("\\b");
    expect(sanitizeRegex("\\\\B")).toBe("\\B");
  });

  it("collapses double-escaped whitespace sequences", () => {
    expect(sanitizeRegex("\\\\n")).toBe("\\n");
    expect(sanitizeRegex("\\\\t")).toBe("\\t");
    expect(sanitizeRegex("\\\\r")).toBe("\\r");
    expect(sanitizeRegex("\\\\f")).toBe("\\f");
  });

  it("collapses double-escaped punctuation", () => {
    expect(sanitizeRegex("\\\\(")).toBe("\\(");
    expect(sanitizeRegex("\\\\)")).toBe("\\)");
    expect(sanitizeRegex("\\\\{")).toBe("\\{");
    expect(sanitizeRegex("\\\\}")).toBe("\\}");
    expect(sanitizeRegex("\\\\[")).toBe("\\[");
    expect(sanitizeRegex("\\\\]")).toBe("\\]");
    expect(sanitizeRegex("\\\\.")).toBe("\\.");
    expect(sanitizeRegex("\\\\|")).toBe("\\|");
    expect(sanitizeRegex("\\\\+")).toBe("\\+");
    expect(sanitizeRegex("\\\\*")).toBe("\\*");
    expect(sanitizeRegex("\\\\?")).toBe("\\?");
    expect(sanitizeRegex("\\\\^")).toBe("\\^");
    expect(sanitizeRegex("\\\\$")).toBe("\\$");
  });

  it("strips backslash before quotes", () => {
    // Input string value: \" (backslash + quote) → just quote
    expect(sanitizeRegex('\\"')).toBe('"');
  });

  it("handles the feedback entry #0 pattern", () => {
    // Claude sent: servers:\\s*\\n\\s*-\\s*url:
    // (In JS string: "servers:\\\\s*\\\\n\\\\s*-\\\\s*url:")
    const input = "servers:\\\\s*\\\\n\\\\s*-\\\\s*url:";
    const expected = "servers:\\s*\\n\\s*-\\s*url:";
    expect(sanitizeRegex(input)).toBe(expected);
  });

  it("handles the feedback entry #2 pattern", () => {
    // Claude sent: security:\\\\s*\\\\n\\\\s*- \\\\{\\\\}
    // (quad-escaped in the JSON, double-escaped in the actual string)
    const input = "security:\\\\s*\\\\n\\\\s*- \\\\{\\\\}";
    const expected = "security:\\s*\\n\\s*- \\{\\}";
    expect(sanitizeRegex(input)).toBe(expected);
  });

  it("leaves correctly-escaped patterns alone", () => {
    expect(sanitizeRegex("\\s+")).toBe("\\s+");
    expect(sanitizeRegex("\\d{3}")).toBe("\\d{3}");
    expect(sanitizeRegex("foo\\.bar")).toBe("foo\\.bar");
    expect(sanitizeRegex("hello world")).toBe("hello world");
  });

  it("strips unnecessary forward slash escape", () => {
    // LLMs often produce \/ from JavaScript regex syntax — ripgrep doesn't need it
    expect(sanitizeRegex("\\/")).toBe("/");
    expect(sanitizeRegex('prefix\\s*=\\s*.*"\\/"|startsWith')).toBe(
      'prefix\\s*=\\s*.*"/"|startsWith',
    );
  });

  it("handles multiple double-escaped sequences in one pattern", () => {
    const input = "\\\\d{3}-\\\\d{4}";
    expect(sanitizeRegex(input)).toBe("\\d{3}-\\d{4}");
  });
});

describe("getEscapingHint", () => {
  it("returns a hint for double-escaped character classes", () => {
    expect(getEscapingHint("\\\\s+")).toBeDefined();
    expect(getEscapingHint("\\\\d{3}")).toBeDefined();
    expect(getEscapingHint("foo\\\\(bar\\\\)")).toBeDefined();
  });

  it("returns undefined for correctly-escaped patterns", () => {
    expect(getEscapingHint("\\s+")).toBeUndefined();
    expect(getEscapingHint("\\d{3}")).toBeUndefined();
    expect(getEscapingHint("hello world")).toBeUndefined();
    expect(getEscapingHint("foo.bar")).toBeUndefined();
  });

  it("returns undefined for plain text", () => {
    expect(getEscapingHint("simple search")).toBeUndefined();
  });

  it("detects double-escaped braces", () => {
    expect(getEscapingHint("\\\\{\\\\}")).toBeDefined();
  });

  it("detects double-escaped forward slash", () => {
    expect(getEscapingHint("\\\\/")).toBeDefined();
  });
});

describe("needsMultiline", () => {
  it("returns true for regex containing \\n", () => {
    expect(needsMultiline("\\n")).toBe(true);
    expect(needsMultiline("foo\\nbar")).toBe(true);
    expect(needsMultiline("\\s*\\n\\s*")).toBe(true);
  });

  it("returns false for plain text without \\n", () => {
    expect(needsMultiline("hello world")).toBe(false);
    expect(needsMultiline("foo")).toBe(false);
    expect(needsMultiline("")).toBe(false);
  });

  it("returns false for escaped backslash before n (\\\\n)", () => {
    // String value: \\n — matches literal backslash + n text, not a newline
    expect(needsMultiline("\\\\n")).toBe(false);
  });

  it("works with sanitized regex from common Claude patterns", () => {
    // After sanitizeRegex, double-escaped \\n becomes \n
    const sanitized = sanitizeRegex("servers:\\\\s*\\\\n\\\\s*-\\\\s*url:");
    expect(needsMultiline(sanitized)).toBe(true);
  });
});

describe("expandSimpleBraceGlob", () => {
  it("expands a common extension brace glob", () => {
    expect(expandSimpleBraceGlob("src/**/*.{ts,tsx}")).toEqual([
      "src/**/*.ts",
      "src/**/*.tsx",
    ]);
  });

  it("leaves non-brace patterns unchanged", () => {
    expect(expandSimpleBraceGlob("src/**/*.ts")).toEqual(["src/**/*.ts"]);
  });

  it("leaves malformed or nested brace patterns unchanged", () => {
    expect(expandSimpleBraceGlob("src/**/*.{ts")).toEqual(["src/**/*.{ts"]);
    expect(expandSimpleBraceGlob("src/{foo,{bar,baz}}.ts")).toEqual([
      "src/{foo,{bar,baz}}.ts",
    ]);
  });
});

describe("resolveFilePatternAsPath", () => {
  // Use this test file itself as a known-existing file
  const searchDir = path.resolve(__dirname, "..");
  const thisFile = "tools/searchFiles.test.ts";

  it("resolves a relative file path that exists", () => {
    const result = resolveFilePatternAsPath(thisFile, searchDir);
    expect(result).toBe(path.resolve(searchDir, thisFile));
  });

  it("resolves an absolute file path that exists", () => {
    const absPath = path.resolve(searchDir, thisFile);
    const result = resolveFilePatternAsPath(absPath, searchDir);
    expect(result).toBe(absPath);
  });

  it("returns undefined for a bare filename (no path separator)", () => {
    expect(resolveFilePatternAsPath("*.ts", searchDir)).toBeUndefined();
    expect(
      resolveFilePatternAsPath("searchFiles.ts", searchDir),
    ).toBeUndefined();
  });

  it("returns undefined for patterns with glob metacharacters", () => {
    expect(resolveFilePatternAsPath("src/**/*.ts", searchDir)).toBeUndefined();
    expect(
      resolveFilePatternAsPath("src/tools/search*.ts", searchDir),
    ).toBeUndefined();
    expect(
      resolveFilePatternAsPath("src/tools/[sS]earch.ts", searchDir),
    ).toBeUndefined();
    expect(resolveFilePatternAsPath("src/{a,b}.ts", searchDir)).toBeUndefined();
  });

  it("returns undefined for a file path that does not exist", () => {
    expect(
      resolveFilePatternAsPath("src/tools/nonexistent.ts", searchDir),
    ).toBeUndefined();
  });

  it("returns undefined for a directory path", () => {
    // "tools" is a directory, not a file — statSync will succeed but isFile() is false
    expect(resolveFilePatternAsPath("tools/", searchDir)).toBeUndefined();
  });

  it("rejects path traversal outside search directory", () => {
    // ../package.json exists but is outside searchDir
    expect(
      resolveFilePatternAsPath("../../package.json", searchDir),
    ).toBeUndefined();
  });

  it("rejects absolute path outside search directory", () => {
    expect(resolveFilePatternAsPath("/etc/hosts", searchDir)).toBeUndefined();
  });
});
