import { useState, useCallback, useMemo } from "preact/hooks";
import type { ContentBlock } from "../types";
import { InlineDiff } from "./InlineDiff";

type ToolCallData = ContentBlock & { type: "tool_call" };

interface ToolCallBlockProps {
  toolCall: ToolCallData;
  onOpenFile?: (path: string, line?: number) => void;
}

/** Format duration as human-readable string. */
function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Parse partial/full JSON safely. */
function tryParseJson(json: string): Record<string, unknown> | null {
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

/** A summary part — either plain text or a clickable file link. */
type SummaryPart =
  | { type: "text"; text: string }
  | { type: "file"; display: string; path: string; line?: number };

/** Generate a smart one-liner summary for known tools. */
function getToolSummary(
  name: string,
  input: Record<string, unknown> | null,
  result: string,
  complete: boolean,
): SummaryPart[] {
  // While streaming input, show what we can parse
  if (!complete) {
    return getStreamingSummary(name, input);
  }

  // Completed tool — summarize based on tool name
  const p = input ?? {};
  switch (name) {
    case "read_file": {
      const path = String(p.path ?? "");
      const lines = extractField(result, "total_lines");
      const suffix = lines ? ` (${lines} lines)` : "";
      return [filePart(path), { type: "text", text: suffix }];
    }
    case "list_files": {
      const dir = String(p.path ?? ".");
      const count =
        extractField(result, "total_files") ??
        extractField(result, "total_results");
      const suffix = count ? ` — ${count} files` : "";
      return [filePart(dir), { type: "text", text: suffix }];
    }
    case "search_files": {
      const pat = String(p.regex ?? "");
      const matches = extractField(result, "total_matches");
      return [
        {
          type: "text",
          text: matches !== null ? `/${pat}/ — ${matches} matches` : `/${pat}/`,
        },
      ];
    }
    case "codebase_search":
      return [{ type: "text", text: String(p.query ?? "").slice(0, 60) }];
    case "write_file": {
      const path = String(p.path ?? "");
      if (extractField(result, "error")) {
        return [filePart(path), { type: "text", text: " — error" }];
      }
      const status = extractField(result, "status");
      if (status) {
        return [filePart(path), { type: "text", text: ` — ${status}` }];
      }
      const op = extractField(result, "operation") ?? "written";
      return [filePart(path), { type: "text", text: ` (${op})` }];
    }
    case "apply_diff": {
      const path = String(p.path ?? "");
      const status = extractField(result, "status") ?? "";
      const hasError = !!extractField(result, "error");
      return [
        filePart(path),
        ...(status
          ? [{ type: "text" as const, text: ` — ${status}` }]
          : hasError
            ? [{ type: "text" as const, text: " — error" }]
            : []),
      ];
    }
    case "find_and_replace": {
      const pat = String(p.file_pattern ?? "");
      return [{ type: "text", text: pat || "bulk replace" }];
    }
    case "execute_command": {
      const cmd = String(p.command ?? "");
      const exitCode = extractField(result, "exit_code");
      // Reserve space for exit badge prefix; truncate command to fit
      const maxLen = exitCode !== null && exitCode !== "0" ? 48 : 60;
      const cmdText =
        cmd.length > maxLen ? cmd.slice(0, maxLen - 3) + "..." : cmd;
      if (exitCode !== null && exitCode !== "0") {
        return [
          { type: "text", text: `\x00exit:${exitCode}` }, // sentinel for exit badge — rendered before command
          { type: "text", text: " " + cmdText },
        ];
      }
      return [{ type: "text", text: cmdText }];
    }
    case "get_terminal_output":
      return [
        {
          type: "text",
          text: p.terminal_id
            ? `terminal ${String(p.terminal_id).slice(0, 8)}`
            : "terminal",
        },
      ];
    case "get_diagnostics": {
      const path = String(p.path ?? "");
      return path ? [filePart(path)] : [{ type: "text", text: "workspace" }];
    }
    case "get_symbols":
    case "get_hover":
    case "get_references":
    case "get_completions":
    case "get_code_actions":
    case "go_to_definition":
    case "go_to_implementation":
    case "go_to_type_definition": {
      const path = String(p.path ?? "");
      const line = p.line ? Number(p.line) : undefined;
      return [filePart(path, line)];
    }
    case "rename_symbol": {
      const oldName = String(p.old_name ?? p.symbol ?? "");
      const newName = String(p.new_name ?? "");
      if (oldName && newName)
        return [{ type: "text", text: `${oldName} → ${newName}` }];
      return [filePart(String(p.path ?? ""))];
    }
    case "open_file":
      return [
        filePart(String(p.path ?? ""), p.line ? Number(p.line) : undefined),
      ];
    case "show_notification":
      return [{ type: "text", text: String(p.message ?? "").slice(0, 50) }];
    case "todo_write":
      return [{ type: "text", text: result || "updated" }];
    default: {
      const t = result.length > 60 ? result.slice(0, 57) + "..." : result || "";
      return [{ type: "text", text: t }];
    }
  }
}

/** Create a file link summary part. */
function filePart(path: string, line?: number): SummaryPart {
  if (!path) return { type: "text", text: "" };
  return {
    type: "file",
    display: shortPath(path) + (line ? `:${line}` : ""),
    path,
    line,
  };
}

/** Summary while tool input is still streaming. */
function getStreamingSummary(
  name: string,
  input: Record<string, unknown> | null,
): SummaryPart[] {
  if (!input) return [];
  const path = input.path ? String(input.path) : "";
  switch (name) {
    case "write_file":
      return path
        ? [
            { type: "text", text: "Writing " },
            filePart(path),
            { type: "text", text: "..." },
          ]
        : [{ type: "text", text: "Writing..." }];
    case "apply_diff":
      return path
        ? [
            { type: "text", text: "Editing " },
            filePart(path),
            { type: "text", text: "..." },
          ]
        : [{ type: "text", text: "Editing..." }];
    case "execute_command":
      return [
        {
          type: "text",
          text: input.command
            ? String(input.command).slice(0, 50) + "..."
            : "Running...",
        },
      ];
    default:
      return path ? [filePart(path)] : [];
  }
}

function shortPath(p: string): string {
  if (!p) return "";
  const parts = p.split("/");
  return parts.length > 3
    ? ".../" + parts.slice(-2).join("/")
    : parts.join("/");
}

function extractField(text: string, field: string): string | null {
  // Try JSON parse first
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && field in obj) {
      const value = (obj as Record<string, unknown>)[field];
      if (value === null || value === undefined) return null;
      return String(value);
    }
  } catch {
    // Try regex fallback for partial JSON
    const re = new RegExp(`"${field}"\\s*:\\s*"?([^",}]+)`);
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function isJson(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Tokenize a JSON string into highlighted spans. */
function JsonHighlight({ json }: { json: string }) {
  const tokens = useMemo(() => tokenizeJson(json), [json]);
  return (
    <pre class="tool-call-code">
      {tokens.map((tok, i) =>
        tok.cls ? (
          <span key={i} class={tok.cls}>
            {tok.text}
          </span>
        ) : (
          tok.text
        ),
      )}
    </pre>
  );
}

type Token = { text: string; cls?: string };

function tokenizeJson(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    // String
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
        } else if (src[j] === '"') {
          j++;
          break;
        } else {
          j++;
        }
      }
      const str = src.slice(i, j);
      // Look ahead past whitespace for a colon → it's a key
      let k = j;
      while (k < src.length && (src[k] === " " || src[k] === "\t")) k++;
      const cls = src[k] === ":" ? "json-key" : "json-string";
      tokens.push({ text: str, cls });
      i = j;
      continue;
    }
    // Number
    if (src[i] === "-" || (src[i] >= "0" && src[i] <= "9")) {
      let j = i + 1;
      while (
        j < src.length &&
        ((src[j] >= "0" && src[j] <= "9") ||
          src[j] === "." ||
          src[j] === "e" ||
          src[j] === "E" ||
          src[j] === "+" ||
          src[j] === "-")
      )
        j++;
      tokens.push({ text: src.slice(i, j), cls: "json-number" });
      i = j;
      continue;
    }
    // Boolean / null
    if (src.startsWith("true", i)) {
      tokens.push({ text: "true", cls: "json-boolean" });
      i += 4;
      continue;
    }
    if (src.startsWith("false", i)) {
      tokens.push({ text: "false", cls: "json-boolean" });
      i += 5;
      continue;
    }
    if (src.startsWith("null", i)) {
      tokens.push({ text: "null", cls: "json-null" });
      i += 4;
      continue;
    }
    // Plain character (punctuation, whitespace, newlines)
    tokens.push({ text: src[i] });
    i++;
  }
  return tokens;
}

function parseResultObject(result: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore parse errors — many tools return plain text.
  }
  return null;
}

function getResultStatus(
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload) return null;
  const status = payload.status;
  return typeof status === "string" ? status.toLowerCase() : null;
}

function hasToolError(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  if (typeof payload.error === "string" && payload.error.trim()) return true;
  const status = getResultStatus(payload);
  return status === "error" || status === "failed";
}

function hasToolWarning(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  if (payload.partial === true) return true;

  const failedBlocks = payload.failed_blocks;
  if (Array.isArray(failedBlocks) && failedBlocks.length > 0) return true;

  const malformedBlocks = payload.malformed_blocks;
  if (typeof malformedBlocks === "number" && malformedBlocks > 0) return true;

  const status = getResultStatus(payload);
  return (
    status === "cancelled" ||
    status === "rejected" ||
    status === "rejected_by_user" ||
    status === "timed_out" ||
    status === "force-completed" ||
    status === "stopped"
  );
}

export interface ToolCallVisualState {
  statusClass: "tool-running" | "tool-success" | "tool-warning" | "tool-error";
  statusIconClass:
    | "codicon-loading codicon-modifier-spin"
    | "codicon-check"
    | "codicon-warning"
    | "codicon-error";
  cmdExitBadge: string | null;
}

export function getToolCallVisualState(toolCall: {
  name: string;
  complete: boolean;
  result: string;
}): ToolCallVisualState {
  const { complete, name, result } = toolCall;
  const resultPayload = complete ? parseResultObject(result) : null;
  const rawExitCode =
    name === "execute_command" && complete
      ? extractField(result, "exit_code")
      : null;
  const cmdExitBadge =
    rawExitCode !== null && rawExitCode !== "0" ? rawExitCode : null;

  const isError = complete && hasToolError(resultPayload);
  const isWarning =
    complete &&
    !isError &&
    (cmdExitBadge !== null || hasToolWarning(resultPayload));

  const statusClass = !complete
    ? "tool-running"
    : isError
      ? "tool-error"
      : isWarning
        ? "tool-warning"
        : "tool-success";

  const statusIconClass = !complete
    ? "codicon-loading codicon-modifier-spin"
    : isError
      ? "codicon-error"
      : isWarning
        ? "codicon-warning"
        : "codicon-check";

  return { statusClass, statusIconClass, cmdExitBadge };
}

export function ToolCallBlock({ toolCall, onOpenFile }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const complete = toolCall.complete;
  const input = tryParseJson(toolCall.inputJson);
  const summaryParts = getToolSummary(
    toolCall.name,
    input,
    toolCall.result,
    complete,
  );

  const { statusClass, statusIconClass, cmdExitBadge } =
    getToolCallVisualState(toolCall);

  const handleFileClick = useCallback(
    (e: MouseEvent, path: string, line?: number) => {
      e.stopPropagation();
      onOpenFile?.(path, line);
    },
    [onOpenFile],
  );

  // Format input JSON for expanded view
  let formattedInput = toolCall.inputJson;
  if (input) {
    formattedInput = JSON.stringify(input, null, 2);
  }

  const hasSummary = summaryParts.some(
    (p) => p.type === "file" || (p.type === "text" && p.text),
  );

  return (
    <div class={`tool-call-block ${statusClass}`}>
      <button
        class="tool-call-header"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <i
          class={`codicon codicon-chevron-${expanded ? "down" : "right"} tool-call-chevron`}
        />
        <i class={`codicon tool-call-status-icon ${statusIconClass}`} />
        <span class="tool-call-name">{toolCall.name}</span>
        {cmdExitBadge !== null && (
          <span class="tool-exit-badge">exit {cmdExitBadge}</span>
        )}
        {hasSummary && (
          <span class="tool-call-summary">
            {summaryParts
              .filter(
                (p) => !(p.type === "text" && p.text.startsWith("\x00exit:")),
              )
              .map((part, i) =>
                part.type === "file" ? (
                  <a
                    key={i}
                    class="tool-file-link"
                    title={part.path + (part.line ? `:${part.line}` : "")}
                    onClick={(e: MouseEvent) =>
                      handleFileClick(e, part.path, part.line)
                    }
                  >
                    {part.display}
                  </a>
                ) : (
                  <span key={i}>{part.text}</span>
                ),
              )}
          </span>
        )}
        {complete && toolCall.durationMs != null && (
          <span class="tool-call-duration">
            {fmtDuration(toolCall.durationMs)}
          </span>
        )}
      </button>

      {expanded && (
        <div class="tool-call-details">
          <InlineDiff toolName={toolCall.name} input={input} />
          {formattedInput && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Input</div>
              <JsonHighlight json={formattedInput} />
            </div>
          )}
          {toolCall.result && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Result</div>
              {isJson(toolCall.result) ? (
                <JsonHighlight json={formatJson(toolCall.result)} />
              ) : (
                <pre class="tool-call-code">{toolCall.result}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
