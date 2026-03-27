export interface MatchedFilePath {
  fullMatch: string;
  filePath: string;
  line?: number;
  index: number;
}

// Matches file paths like `src/foo/bar.ts`, `/abs/path.ts`, `src/foo.ts:42`
const FILE_PATH_RE =
  /(^|[^.:/\w-])((?:(?:\/[\w.-]+)+|[\w][\w-]*(?:\/[\w.-]+)+)\.\w{1,8})(?::(\d+)(?:-\d+)?)?/g;

export function matchFilePaths(text: string): MatchedFilePath[] {
  const matches: MatchedFilePath[] = [];
  FILE_PATH_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const filePath = match[2];
    const line = match[3] ? parseInt(match[3], 10) : undefined;
    const fullMatch = match[0].slice(prefix.length);
    const index = match.index + prefix.length;

    matches.push({
      fullMatch,
      filePath,
      line,
      index,
    });
  }

  return matches;
}
