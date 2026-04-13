import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";

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

  it("renders attachment markers as basename chips and removes them from the message body", () => {
    const message: ChatMessage = {
      id: "user-3",
      role: "user",
      content:
        "Please inspect this file\n[Attached: src/agent/webview/App.tsx]",
      timestamp: Date.now(),
      blocks: [],
    };

    const { container } = render(
      <MessageBubble message={message} streaming={false} />,
    );

    expect(container.querySelector(".user-attachments")).toBeTruthy();
    expect(screen.getByText("App.tsx")).toBeTruthy();
    expect(
      screen.queryByText("[Attached: src/agent/webview/App.tsx]"),
    ).toBeNull();
    expect(screen.getByText("Please inspect this file")).toBeTruthy();
  });

  it("renders detected question fallback options and dispatches selected payload", () => {
    const onAnswer = vi.fn();
    const onDismiss = vi.fn();
    const message: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [{ type: "text", text: "Proceed?" }],
    };

    render(
      <MessageBubble
        message={message}
        streaming={false}
        detectedQuestion={{
          messageId: "assistant-1",
          kind: "yes_no",
          prompt: "Proceed?",
          options: [
            { label: "Yes", payload: "Yes, proceed with test updates." },
            { label: "No", payload: "No" },
          ],
        }}
        onDetectedQuestionAnswer={onAnswer}
        onDismissDetectedQuestion={onDismiss}
      />,
    );

    expect(screen.getByText("Detected choice prompt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(onAnswer).toHaveBeenCalledWith("Yes, proceed with test updates.");
    expect(onDismiss).toHaveBeenCalledWith("assistant-1");
  });
});
