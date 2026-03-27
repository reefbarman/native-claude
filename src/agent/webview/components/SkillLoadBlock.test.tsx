import { describe, expect, it } from "vitest";
import { render } from "@testing-library/preact";

import { SkillLoadBlock } from "./SkillLoadBlock";

describe("SkillLoadBlock", () => {
  it("renders stopped results as warning", () => {
    const { container } = render(
      <SkillLoadBlock
        block={{
          type: "skill_load",
          id: "tool-1",
          inputJson: "{}",
          result: JSON.stringify({ status: "stopped" }),
          complete: true,
          skillName: "push-to-repo",
          path: "/tmp/skill.md",
          content: undefined,
        }}
      />,
    );

    const root = container.querySelector(".tool-call-block");
    expect(root?.classList.contains("tool-warning")).toBe(true);
  });

  it("renders completed non-stopped results as success", () => {
    const { container } = render(
      <SkillLoadBlock
        block={{
          type: "skill_load",
          id: "tool-2",
          inputJson: "{}",
          result: JSON.stringify({ status: "loaded" }),
          complete: true,
          skillName: "push-to-repo",
          path: "/tmp/skill.md",
          content: undefined,
        }}
      />,
    );

    const root = container.querySelector(".tool-call-block");
    expect(root?.classList.contains("tool-success")).toBe(true);
  });

  it("renders failed status as error", () => {
    const { container } = render(
      <SkillLoadBlock
        block={{
          type: "skill_load",
          id: "tool-3",
          inputJson: "{}",
          result: JSON.stringify({ status: "failed" }),
          complete: true,
          skillName: "push-to-repo",
          path: "/tmp/skill.md",
          content: undefined,
        }}
      />,
    );

    const root = container.querySelector(".tool-call-block");
    expect(root?.classList.contains("tool-error")).toBe(true);
  });
});
