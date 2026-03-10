import { useState } from "preact/hooks";

interface BgQuestionBlockProps {
  bgTask: string;
  questions: string[];
  answer: string;
}

export function BgQuestionBlock({
  bgTask,
  questions,
  answer,
}: BgQuestionBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div class="tool-call-block tool-success">
      <button
        class="tool-call-header"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <i
          class={`codicon codicon-chevron-${expanded ? "down" : "right"} tool-call-chevron`}
        />
        <i class="codicon codicon-comment-discussion tool-call-status-icon" />
        <span class="tool-call-name">BG Question</span>
        <span class="tool-call-summary">{bgTask}</span>
      </button>

      {expanded && (
        <div class="tool-call-details">
          <div class="tool-call-section">
            <div class="tool-call-section-label">
              {questions.length === 1 ? "Question" : "Questions"}
            </div>
            {questions.map((q, i) => (
              <pre key={i} class="tool-call-code">
                {q}
              </pre>
            ))}
          </div>
          <div class="tool-call-section">
            <div class="tool-call-section-label">Answer</div>
            <pre class="tool-call-code">{answer}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
