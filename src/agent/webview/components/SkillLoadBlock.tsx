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

export function SkillLoadBlock({ block }: SkillLoadBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const summary =
    (block.skillName ?? formatPath(block.path)) || "Loading skill…";

  return (
    <div
      class={`tool-call-block ${block.complete ? "tool-success" : "tool-running"}`}
    >
      <button
        class="tool-call-header"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <i
          class={`codicon codicon-chevron-${expanded ? "down" : "right"} tool-call-chevron`}
        />
        <i
          class={`codicon tool-call-status-icon ${
            block.complete
              ? "codicon-library"
              : "codicon-loading codicon-modifier-spin"
          }`}
        />
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
