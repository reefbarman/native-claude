import { describe, expect, it } from "vitest";

import { initialState, reducer } from "./App";

describe("webview App reducer background agent launch blocks", () => {
  it("uses final tool input to populate the bg_agent message for spawn_background_agent", () => {
    const toolCallId = "tool-1";
    const sessionId = "bg-123";
    const task = "Review implementation";
    const message = "Review these changes and report any issues.";

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "run review",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "spawn_background_agent",
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId,
      toolName: "spawn_background_agent",
      result: JSON.stringify({ sessionId }),
      durationMs: 12,
      input: { task, message },
    });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");

    const bgBlock = assistant?.blocks.find((b) => b.type === "bg_agent");
    expect(bgBlock).toBeDefined();
    expect(bgBlock).toMatchObject({
      type: "bg_agent",
      sessionId,
      task,
      message,
    });
  });

  it("falls back to parsed tool_call inputJson when final input is missing", () => {
    const toolCallId = "tool-2";
    const sessionId = "bg-456";
    const task = "Review architecture";
    const message = "Check the plan for gaps and inconsistencies.";

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "run architecture review",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "spawn_background_agent",
    });

    state = reducer(state, {
      type: "TOOL_INPUT_DELTA",
      toolCallId,
      partialJson: JSON.stringify({ task, message }),
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId,
      toolName: "spawn_background_agent",
      result: JSON.stringify({ sessionId }),
      durationMs: 8,
    });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");

    const bgBlock = assistant?.blocks.find((b) => b.type === "bg_agent");
    expect(bgBlock).toBeDefined();
    expect(bgBlock).toMatchObject({
      type: "bg_agent",
      sessionId,
      task,
      message,
    });
  });

  it("backfills tool inputJson from TOOL_COMPLETE when no input deltas arrived", () => {
    const toolCallId = "tool-no-delta";
    const finalInput = {
      path: "src/agent/webview/App.tsx",
      query: "tool input",
    };

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "Inspect tool input",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "read_file",
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId,
      toolName: "read_file",
      result: JSON.stringify({ total_lines: 10 }),
      durationMs: 5,
      input: finalInput,
    });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");

    const toolBlock = assistant?.blocks.find(
      (b) => b.type === "tool_call" && b.id === toolCallId,
    );
    expect(toolBlock).toBeDefined();
    expect(toolBlock).toMatchObject({
      type: "tool_call",
      id: toolCallId,
      inputJson: JSON.stringify(finalInput),
      result: JSON.stringify({ total_lines: 10 }),
      complete: true,
      durationMs: 5,
    });
  });

  it("preserves streamed tool inputJson when TOOL_COMPLETE also includes input", () => {
    const toolCallId = "tool-preserve-delta";
    const streamedInput = JSON.stringify({ path: "src/agent/webview/App.tsx" });
    const finalInput = {
      path: "src/agent/webview/App.tsx",
      query: "should not overwrite streamed input",
    };

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "Inspect streamed input",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "read_file",
    });

    state = reducer(state, {
      type: "TOOL_INPUT_DELTA",
      toolCallId,
      partialJson: streamedInput,
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId,
      toolName: "read_file",
      result: JSON.stringify({ total_lines: 10 }),
      durationMs: 6,
      input: finalInput,
    });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");

    const toolBlock = assistant?.blocks.find(
      (b) => b.type === "tool_call" && b.id === toolCallId,
    );
    expect(toolBlock).toBeDefined();
    expect(toolBlock).toMatchObject({
      type: "tool_call",
      id: toolCallId,
      inputJson: streamedInput,
      result: JSON.stringify({ total_lines: 10 }),
      complete: true,
      durationMs: 6,
    });
  });

  it("retains queued images and documents in messageQueue state", () => {
    const images = [
      { name: "diagram.png", mimeType: "image/png", base64: "img-base64" },
    ];
    const documents = [
      {
        name: "spec.pdf",
        mimeType: "application/pdf",
        base64: "pdf-base64",
      },
    ];

    const state = reducer(initialState, {
      type: "ENQUEUE_MESSAGE",
      id: "queue-1",
      text: "[1 image, 1 PDF attached]\nplease review",
      fullText: "please review",
      images,
      documents,
    });

    expect(state.messageQueue).toEqual([
      {
        id: "queue-1",
        text: "[1 image, 1 PDF attached]\nplease review",
        fullText: "please review",
        images,
        documents,
      },
    ]);
  });

  it("clears slash-command metadata when an enqueued message is edited", () => {
    let state = reducer(initialState, {
      type: "ENQUEUE_MESSAGE",
      id: "queue-1",
      text: "/review",
      fullText: "expanded prompt body",
      isSlashCommand: true,
    });

    state = reducer(state, {
      type: "EDIT_QUEUE_MESSAGE",
      id: "queue-1",
      text: "follow-up clarification",
    });

    expect(state.messageQueue).toEqual([
      {
        id: "queue-1",
        text: "follow-up clarification",
        fullText: "follow-up clarification",
        isSlashCommand: false,
      },
    ]);
  });

  it("restores persisted condense summaries even when they are stored as user messages", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "Investigate condense" },
      {
        role: "user",
        isSummary: true,
        content: [
          {
            type: "text",
            text: '## Resume Anchor (deterministic)\n- Continue from this task: "Investigate condense"',
          },
          { type: "text", text: "## Conversation Summary\n\nSummary body" },
        ],
      },
    ] as unknown[]);

    expect(restored).toHaveLength(3);
    expect(restored[0]?.role).toBe("user");
    expect(restored[1]?.role).toBe("condense");
    expect(restored[2]?.role).toBe("assistant");
    expect(restored[2]?.blocks).toEqual([
      {
        type: "text",
        text: '## Resume Anchor (deterministic)\n- Continue from this task: "Investigate condense"## Conversation Summary\n\nSummary body',
      },
    ]);
  });

  it("restores persisted runtime errors as warning rows with retry metadata", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "Try Codex again" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Codex API error: An error occurred while processing your request.",
          },
        ],
        runtimeError: {
          message:
            "Codex API error: An error occurred while processing your request.",
          retryable: true,
        },
      },
    ] as unknown[]);

    expect(restored).toHaveLength(2);
    expect(restored[0]?.role).toBe("user");
    expect(restored[1]?.role).toBe("warning");
    expect(restored[1]?.warningMessage).toBe(
      "Codex API error: An error occurred while processing your request.",
    );
    expect(restored[1]?.error).toEqual({
      message:
        "Codex API error: An error occurred while processing your request.",
      retryable: true,
    });
  });
});
