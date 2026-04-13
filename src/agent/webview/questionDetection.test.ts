import { describe, expect, it } from "vitest";

import { detectQuestionFromAssistantText } from "./questionDetection";

describe("detectQuestionFromAssistantText", () => {
  it("detects explicit yes/no proceed prompts", () => {
    const detected = detectQuestionFromAssistantText(
      "Recommended handling: update tests. Proceed? (yes/no)",
    );
    expect(detected).toEqual({
      kind: "yes_no",
      prompt: "Proceed?",
      options: [
        { label: "Yes", payload: "Yes" },
        { label: "No", payload: "No" },
      ],
    });
  });

  it("detects approval-to-act phrasing", () => {
    const detected = detectQuestionFromAssistantText(
      "I can post that thread reply and resolve it. Should I proceed with that?",
    );
    expect(detected?.kind).toBe("yes_no");
    expect(detected?.options).toHaveLength(2);
  });

  it("detects A/B choice prompts", () => {
    const detected = detectQuestionFromAssistantText(
      "Option A (recommended): reply with verification only. Option B: add defensive guard. Choose A or B.",
    );
    expect(detected).toEqual({
      kind: "single_choice",
      prompt: "Choose A or B.",
      options: [
        {
          label: "Option A",
          payload: "Option A — reply with verification only.",
        },
        {
          label: "Option B",
          payload: "Option B — add defensive guard.",
        },
      ],
    });
  });

  it("ignores open-ended strategy questions", () => {
    const detected = detectQuestionFromAssistantText(
      "I found two approaches. What do you think about this design?",
    );
    expect(detected).toBeNull();
  });

  it("ignores quoted/code examples of choose prompts", () => {
    const detected = detectQuestionFromAssistantText(
      "Update docs to include:\n```\nProceed? (yes/no)\n```",
    );
    expect(detected).toBeNull();
  });

  it("detects short action confirmation prompts", () => {
    const detected = detectQuestionFromAssistantText("Apply this?");
    expect(detected?.kind).toBe("yes_no");
  });
});
