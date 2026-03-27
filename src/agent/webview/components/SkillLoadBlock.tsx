import { useState } from "preact/hooks";

import type { ContentBlock } from "../types";

type SkillLoadData = ContentBlock & { type: "skill_load" };

interface SkillLoadBlockProps {
  block: SkillLoadData;
}

function formatPath(path?: string): string {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
}

function parseResultStatus(result: string): string | null {
  try {
    const parsed = JSON.parse(result) as { status?: unknown };
    return typeof parsed.status === "string"
      ? parsed.status.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function parseHasError(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.trim().length > 0;
  } catch {
    return false;
  }
}

export function SkillLoadBlock({ block }: SkillLoadBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const summary =
    (block.skillName ?? formatPath(block.path)) || "Loading skill…";

  const status = block.complete ? parseResultStatus(block.result) : null;
  const hasError = block.complete && parseHasError(block.result);
  const isError = hasError || status === "error" || status === "failed";
  const isWarning =
    !isError &&
    (status === "stopped" ||
      status === "cancelled" ||
      status === "rejected" ||
      status === "rejected_by_user" ||
      status === "timed_out" ||
      status === "force-completed");

  const statusClass = !block.complete
    ? "tool-running"
    : isError
      ? "tool-error"
      : isWarning
        ? "tool-warning"
        : "tool-success";
  const statusIconClass = !block.complete
    ? "codicon-loading codicon-modifier-spin"
    : isError
      ? "codicon-error"
      : isWarning
        ? "codicon-warning"
        : "codicon-library";

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
        <span class="tool-call-name">load_skill</span>
        <span class="tool-call-summary">{summary}</span>
        {block.complete && block.durationMs != null && (
          <span class="tool-call-duration">{block.durationMs}ms</span>
        )}
      </button>

      {expanded && (
        <div class="tool-call-details">
          {block.skillName && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Skill</div>
              <pre class="tool-call-code">{block.skillName}</pre>
            </div>
          )}
          {block.path && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Path</div>
              <pre class="tool-call-code">{block.path}</pre>
            </div>
          )}
          {block.content && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Content</div>
              <pre class="tool-call-code skill-load-content">
                {block.content}
              </pre>
            </div>
          )}
          {!block.content && block.result && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Result</div>
              <pre class="tool-call-code">{block.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
