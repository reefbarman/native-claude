import { useState, useCallback } from "preact/hooks";
import type { Question } from "../types";

interface QuestionCardProps {
  id: string;
  questions: Question[];
  onSubmit: (
    id: string,
    answers: Record<string, string | string[] | number | boolean | undefined>,
    notes: Record<string, string>,
  ) => void;
}

export function QuestionCard({ id, questions, onSubmit }: QuestionCardProps) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<
    Record<string, string | string[] | number | boolean | undefined>
  >({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const q = questions[step];
  const isLast = step === questions.length - 1;
  const currentAnswer = answers[q.id];
  const currentNote = notes[q.id] ?? "";

  const isAnswered = useCallback(() => {
    const hasNote = currentNote.trim() !== "";
    if (q.type === "text")
      return (
        (typeof currentAnswer === "string" && currentAnswer.trim() !== "") ||
        hasNote
      );
    if (q.type === "confirmation") return currentAnswer === "confirmed";
    if (q.type === "multiple_select")
      return (
        (Array.isArray(currentAnswer) && currentAnswer.length > 0) || hasNote
      );
    // For choice/scale/yes_no: option selected OR note filled
    return (
      (currentAnswer !== undefined &&
        currentAnswer !== null &&
        currentAnswer !== "") ||
      hasNote
    );
  }, [q.type, currentAnswer, currentNote]);

  const setAnswer = useCallback(
    (value: string | string[] | number | boolean | undefined) => {
      setAnswers((prev) => {
        if (value === undefined) {
          const next = { ...prev };
          delete next[q.id];
          return next;
        }
        return { ...prev, [q.id]: value };
      });
    },
    [q.id],
  );

  const setNote = useCallback(
    (text: string) => {
      setNotes((prev) => ({ ...prev, [q.id]: text }));
    },
    [q.id],
  );

  const handleNext = useCallback(() => {
    if (!isAnswered()) return;
    setStep((s) => s + 1);
  }, [isAnswered]);

  const handleBack = useCallback(() => {
    setStep((s) => Math.max(0, s - 1));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!isAnswered()) return;
    onSubmit(id, answers, notes);
  }, [id, answers, notes, isAnswered, onSubmit]);

  const showNoteInput = q.type !== "confirmation";

  return (
    <div class="question-card">
      {questions.length > 1 && (
        <div class="question-progress">
          {questions.map((_, i) => (
            <span
              key={i}
              class={`question-dot${i === step ? " question-dot-active" : i < step ? " question-dot-done" : ""}`}
            />
          ))}
          <span class="question-progress-label">
            {step + 1} / {questions.length}
          </span>
        </div>
      )}

      <div class="question-text">{q.question}</div>

      <QuestionInput question={q} value={currentAnswer} onChange={setAnswer} />

      {showNoteInput && (
        <textarea
          class="question-other-input"
          placeholder="Other / add context (optional)"
          value={currentNote}
          onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
          rows={2}
        />
      )}

      <div class="question-nav">
        <button
          class="question-nav-btn"
          onClick={handleBack}
          disabled={step === 0}
        >
          Back
        </button>
        {isLast ? (
          <button
            class="question-submit"
            disabled={!isAnswered()}
            onClick={handleSubmit}
          >
            Submit
          </button>
        ) : (
          <button
            class="question-nav-btn question-nav-next"
            disabled={!isAnswered()}
            onClick={handleNext}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}

interface QuestionInputProps {
  question: Question;
  value: string | string[] | number | boolean | undefined;
  onChange: (v: string | string[] | number | boolean | undefined) => void;
}

function QuestionInput({ question, value, onChange }: QuestionInputProps) {
  const { type, options = [], scale_min = 1, scale_max = 5 } = question;

  if (type === "text") {
    return (
      <textarea
        class="question-text-input"
        value={(value as string) ?? ""}
        onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        rows={3}
        placeholder="Type your answer..."
        autoFocus
      />
    );
  }

  if (type === "confirmation") {
    return (
      <button
        class={`question-option${value === "confirmed" ? " selected" : ""}`}
        onClick={() =>
          onChange(value === "confirmed" ? undefined : "confirmed")
        }
      >
        Got it
      </button>
    );
  }

  if (type === "yes_no") {
    return (
      <div class="question-options">
        {(["Yes", "No"] as const).map((label) => {
          const val = label === "Yes";
          const sel = value === val;
          return (
            <button
              key={label}
              class={`question-option${sel ? " selected" : ""}`}
              onClick={() => onChange(sel ? undefined : val)}
            >
              {label}
            </button>
          );
        })}
      </div>
    );
  }

  if (type === "scale") {
    const nums = Array.from(
      { length: scale_max - scale_min + 1 },
      (_, i) => scale_min + i,
    );
    const hasLabels = question.scale_min_label || question.scale_max_label;
    return (
      <div class="question-scale">
        <div class="scale-options">
          {nums.map((n) => (
            <button
              key={n}
              class={`question-option scale-option${value === n ? " selected" : ""}`}
              onClick={() => onChange(value === n ? undefined : n)}
            >
              {n}
            </button>
          ))}
        </div>
        {hasLabels && (
          <div class="scale-labels-row">
            <span class="scale-label scale-label-min">
              {question.scale_min_label ?? ""}
            </span>
            <span class="scale-label scale-label-max">
              {question.scale_max_label ?? ""}
            </span>
          </div>
        )}
      </div>
    );
  }

  // multiple_choice or multiple_select
  const isMulti = type === "multiple_select";

  const isSelected = (opt: string) => {
    if (isMulti)
      return Array.isArray(value) && (value as string[]).includes(opt);
    return value === opt;
  };

  const toggle = (opt: string) => {
    if (!isMulti) {
      onChange(isSelected(opt) ? undefined : opt);
    } else {
      const cur = Array.isArray(value) ? (value as string[]) : [];
      onChange(
        cur.includes(opt) ? cur.filter((v) => v !== opt) : [...cur, opt],
      );
    }
  };

  return (
    <div class="question-options">
      {options.map((opt) => (
        <button
          key={opt}
          class={`question-option${isSelected(opt) ? " selected" : ""}`}
          onClick={() => toggle(opt)}
        >
          {isMulti && (
            <span
              class={`q-checkbox${isSelected(opt) ? " q-checkbox-checked" : ""}`}
            />
          )}
          {opt}
          {question.recommended === opt && (
            <span class="question-recommended-badge">Recommended</span>
          )}
        </button>
      ))}
    </div>
  );
}
