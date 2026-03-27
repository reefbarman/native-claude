import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/preact";

import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "../types";

describe("MessageBubble slash-command rendering", () => {
  it("renders standalone slash command as a tool-call-style block with args", () => {
    const message: ChatMessage = {
      id: "user-1",
      role: "user",
      content: "/review src/agent/webview/App.tsx",
      timestamp: Date.now(),
      blocks: [],
      isSlashCommand: true,
      slashCommandLabel: "/review src/agent/webview/App.tsx",
    };

    const { container } = render(
      <MessageBubble message={message} streaming={false} />,
    );

    expect(container.querySelector(".tool-call-block")).toBeTruthy();
    expect(screen.getByText("/review")).toBeTruthy();
    expect(screen.getByText("src/agent/webview/App.tsx")).toBeTruthy();
    expect(container.querySelector(".slash-tool-call-args")).toBeTruthy();
    expect(container.querySelector(".user-content")).toBeNull();
  });

  it("renders slash command chip in attachment row for non-standalone user text", () => {
    const message: ChatMessage = {
      id: "user-2",
      role: "user",
      content: "Please run this\n[Attached: src/agent/webview/App.tsx]",
      timestamp: Date.now(),
      blocks: [],
      isSlashCommand: true,
      slashCommandLabel: "/snapshot latest",
    };

    const { container } = render(
      <MessageBubble message={message} streaming={false} />,
    );

    expect(container.querySelector(".user-attachments")).toBeTruthy();
    expect(
      container.querySelector(".user-attachment-slash-command"),
    ).toBeTruthy();
    expect(screen.getByText("/snapshot latest")).toBeTruthy();
    expect(container.querySelector(".user-slash-command-tool-call")).toBeNull();
  });
});
