import { describe, expect, it } from "vitest";

import { matchFilePaths } from "./filePathLinks";

describe("matchFilePaths", () => {
  it("matches absolute paths including the leading slash", () => {
    const text =
      "Open /home/trist/workspace/openapi-generation/plans/arazzo-phase-0-5-generic-ast-refactor-plan.md in the editor";

    expect(matchFilePaths(text)).toEqual([
      {
        fullMatch:
          "/home/trist/workspace/openapi-generation/plans/arazzo-phase-0-5-generic-ast-refactor-plan.md",
        filePath:
          "/home/trist/workspace/openapi-generation/plans/arazzo-phase-0-5-generic-ast-refactor-plan.md",
        line: undefined,
        index: 5,
      },
    ]);
  });

  it("matches relative paths with line numbers", () => {
    const text =
      "Check src/agent/webview/components/MessageBubble.tsx:337 next";

    expect(matchFilePaths(text)).toEqual([
      {
        fullMatch: "src/agent/webview/components/MessageBubble.tsx:337",
        filePath: "src/agent/webview/components/MessageBubble.tsx",
        line: 337,
        index: 6,
      },
    ]);
  });

  it("does not include surrounding punctuation in the match prefix", () => {
    const text =
      "(/home/trist/workspace/native-claude/src/agent/webview/App.tsx)";

    expect(matchFilePaths(text)).toEqual([
      {
        fullMatch:
          "/home/trist/workspace/native-claude/src/agent/webview/App.tsx",
        filePath:
          "/home/trist/workspace/native-claude/src/agent/webview/App.tsx",
        line: undefined,
        index: 1,
      },
    ]);
  });

  it("does not match file-like suffixes inside urls", () => {
    expect(
      matchFilePaths("Visit https://github.com/org/repo/blob/main/src/foo.ts"),
    ).toEqual([]);
    expect(matchFilePaths("Visit https://example.com/foo/bar.ts")).toEqual([]);
  });

  it("returns no matches for plain text", () => {
    expect(matchFilePaths("just some normal chat text")).toEqual([]);
  });
});
