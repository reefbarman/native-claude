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

  it("converts load_skill tool calls into dedicated skill_load blocks", () => {
    const toolCallId = "skill-tool-1";
    const skillPath = "/workspace/.claude/skills/push-to-repo/SKILL.md";
    const content = "# Push to repo\n\nUse this skill to commit and tag.";

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "load the push skill",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "load_skill",
    });

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId,
      toolName: "load_skill",
      result: JSON.stringify({
        skill_name: "push-to-repo",
        path: skillPath,
        content,
      }),
      durationMs: 7,
      input: { path: skillPath },
    });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");

    const skillBlock = assistant?.blocks.find(
      (b) => b.type === "skill_load" && b.id === toolCallId,
    );
    expect(skillBlock).toBeDefined();
    expect(skillBlock).toMatchObject({
      type: "skill_load",
      id: toolCallId,
      inputJson: JSON.stringify({ path: skillPath }),
      result: JSON.stringify({
        skill_name: "push-to-repo",
        path: skillPath,
        content,
      }),
      complete: true,
      durationMs: 7,
      skillName: "push-to-repo",
      path: skillPath,
      content,
    });
  });

  it("marks incomplete skill_load blocks complete when DONE is dispatched", () => {
    const toolCallId = "skill-tool-stop";

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "load the push skill",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId,
      toolName: "load_skill",
    });

    state = reducer(state, { type: "DONE" });

    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");

    const skillBlock = assistant?.blocks.find(
      (b) => b.type === "skill_load" && b.id === toolCallId,
    );
    expect(skillBlock).toBeDefined();
    expect(skillBlock).toMatchObject({
      type: "skill_load",
      id: toolCallId,
      complete: true,
      result: '{"status":"stopped"}',
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

  it("preserves slash command label alongside attachment indicators", () => {
    const state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "[1 image attached]\nplease inspect this",
      isSlashCommand: true,
      slashCommandLabel: "/snapshot latest",
    });

    expect(state.messages[0]).toMatchObject({
      role: "user",
      content: "[1 image attached]\nplease inspect this",
      isSlashCommand: true,
      slashCommandLabel: "/snapshot latest",
    });
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

  it("maps checkpoint turn indices to the preceding user message", () => {
    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "first prompt",
    });
    state = reducer(state, { type: "DONE" });
    state = reducer(state, {
      type: "ADD_USER_MESSAGE",
      text: "second prompt",
    });
    state = reducer(state, { type: "DONE" });

    state = reducer(state, {
      type: "SET_CHECKPOINT",
      checkpointId: "cp-live",
      turnIndex: 1,
    });

    expect(state.messages[0]).toMatchObject({
      role: "user",
      content: "first prompt",
      checkpointId: "cp-live",
    });
    expect(state.messages[2]).toMatchObject({
      role: "user",
      content: "second prompt",
    });
    expect(state.messages[2]).not.toHaveProperty("checkpointId");

    const restored = reducer(initialState, {
      type: "LOAD_SESSION",
      sessionId: "session-1",
      title: "Checkpoint session",
      mode: "code",
      messages: state.messages.map(
        ({ checkpointId: _checkpointId, ...message }) => message,
      ),
      checkpoints: [{ turnIndex: 1, checkpointId: "cp-restored" }],
      lastInputTokens: 0,
      lastOutputTokens: 0,
    });

    expect(restored.messages[0]).toMatchObject({
      role: "user",
      content: "first prompt",
      checkpointId: "cp-restored",
    });
    expect(restored.messages[2]).toMatchObject({
      role: "user",
      content: "second prompt",
    });
    expect(restored.messages[2]).not.toHaveProperty("checkpointId");
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

  it("restores condense row metadata from persisted uiHint", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "Investigate condense" },
      {
        role: "assistant",
        isSummary: true,
        content: [{ type: "text", text: "Summary body" }],
        uiHint: {
          condense: {
            prevInputTokens: 12000,
            newInputTokens: 4200,
            durationMs: 950,
            validationWarnings: ["retry used"],
          },
        },
      },
    ] as unknown[]);

    expect(restored).toHaveLength(3);
    expect(restored[1]?.role).toBe("condense");
    expect(restored[1]?.condenseInfo).toEqual({
      prevInputTokens: 12000,
      newInputTokens: 4200,
      durationMs: 950,
      validationWarnings: ["retry used"],
      errorMessage: undefined,
      condensing: undefined,
    });
  });

  it("restores slash-command display text and pill metadata from persisted uiHint", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      {
        role: "user",
        content: "expanded slash command body",
        uiHint: {
          userMessage: {
            displayText: "/review",
            isSlashCommand: true,
          },
        },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    ] as unknown[]);

    expect(restored).toHaveLength(2);
    expect(restored[0]?.role).toBe("user");
    expect(restored[0]?.content).toBe("/review");
    expect(restored[0]?.isSlashCommand).toBe(true);
    expect(restored[0]?.slashCommandLabel).toBe("/review");
  });

  it("preserves user context text around persisted slash commands", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      {
        role: "user",
        content: "Please do this before sending",
        uiHint: {
          userMessage: {
            displayText: "Please do this before sending",
            isSlashCommand: true,
            slashCommandLabel: "/snapshot important state",
          },
        },
      },
    ] as unknown[]);

    expect(restored).toHaveLength(1);
    expect(restored[0]?.role).toBe("user");
    expect(restored[0]?.content).toBe("Please do this before sending");
    expect(restored[0]?.isSlashCommand).toBe(true);
    expect(restored[0]?.slashCommandLabel).toBe("/snapshot important state");
  });

  it("restores persisted load_skill tool calls as skill_load blocks", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const skillPath = "/workspace/.claude/skills/push-to-repo/SKILL.md";
    const content = "# Push to repo\n\nUse this skill to commit and tag.";

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "load the push skill" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "skill-tool-restore",
            name: "load_skill",
            input: { path: skillPath },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "skill-tool-restore",
            content: JSON.stringify({
              skill_name: "push-to-repo",
              path: skillPath,
              content,
            }),
          },
        ],
      },
    ] as unknown[]);

    expect(restored).toHaveLength(2);
    expect(restored[0]?.role).toBe("user");
    expect(restored[1]?.role).toBe("assistant");
    expect(restored[1]?.blocks).toEqual([
      {
        type: "skill_load",
        id: "skill-tool-restore",
        inputJson: JSON.stringify({ path: skillPath }),
        result: JSON.stringify({
          skill_name: "push-to-repo",
          path: skillPath,
          content,
        }),
        complete: true,
        skillName: "push-to-repo",
        path: skillPath,
        content,
      },
    ]);
  });

  it("restores persisted background tool calls into bg_agent and bg_agent_result blocks", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const bgSessionId = "bg-session-restore";
    const task = "Review implementation";
    const message = "Review the patch and report correctness issues.";
    const resultText = "Looks good overall. I found one edge case to fix.";

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "run a background review" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bg-spawn-tool",
            name: "spawn_background_agent",
            input: { task, message },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bg-spawn-tool",
            content: JSON.stringify({
              sessionId: bgSessionId,
              resolvedMode: "review",
              resolvedProvider: "openai",
              resolvedModel: "gpt-5.3-codex",
              taskClass: "review_code",
              routingReason: "taskClass policy",
            }),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bg-result-tool",
            name: "get_background_result",
            input: { sessionId: bgSessionId },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bg-result-tool",
            content: resultText,
          },
        ],
      },
    ] as unknown[]);

    expect(restored).toHaveLength(3);
    expect(restored[0]?.role).toBe("user");

    expect(restored[1]?.role).toBe("assistant");
    expect(restored[1]?.blocks).toEqual([
      {
        type: "tool_call",
        id: "bg-spawn-tool",
        name: "spawn_background_agent",
        inputJson: JSON.stringify({ task, message }),
        result: JSON.stringify({
          sessionId: bgSessionId,
          resolvedMode: "review",
          resolvedProvider: "openai",
          resolvedModel: "gpt-5.3-codex",
          taskClass: "review_code",
          routingReason: "taskClass policy",
        }),
        complete: true,
      },
      {
        type: "bg_agent",
        sessionId: bgSessionId,
        task,
        message,
        resolvedMode: "review",
        resolvedProvider: "openai",
        resolvedModel: "gpt-5.3-codex",
        taskClass: "review_code",
        routingReason: "taskClass policy",
      },
    ]);

    expect(restored[2]?.role).toBe("assistant");
    expect(restored[2]?.blocks).toEqual([
      {
        type: "tool_call",
        id: "bg-result-tool",
        name: "get_background_result",
        inputJson: JSON.stringify({ sessionId: bgSessionId }),
        result: resultText,
        complete: true,
      },
      {
        type: "bg_agent_result",
        sessionId: bgSessionId,
        task,
        status: "completed",
        resultText,
      },
    ]);
  });

  it("restores persisted runtime errors on assistant messages with retry metadata", async () => {
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
    expect(restored[1]?.role).toBe("assistant");
    expect(restored[1]?.blocks).toEqual([
      {
        type: "text",
        text: "Codex API error: An error occurred while processing your request.",
      },
    ]);
    expect(restored[1]?.error).toEqual({
      message:
        "Codex API error: An error occurred while processing your request.",
      retryable: true,
    });
  });

  it("restores oauth usage-limit exhausted runtime error action metadata on assistant messages", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "Try Codex again" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Codex API error 429" }],
        runtimeError: {
          message: "Codex API error 429: The usage limit has been reached.",
          retryable: true,
          code: "oauth_usage_limit_exhausted",
          actions: {
            signInAnotherAccount: true,
          },
        },
      },
    ] as unknown[]);

    expect(restored).toHaveLength(2);
    expect(restored[1]?.role).toBe("assistant");
    expect(restored[1]?.error).toEqual({
      message: "Codex API error 429: The usage limit has been reached.",
      retryable: true,
      code: "oauth_usage_limit_exhausted",
      actions: {
        signInAnotherAccount: true,
      },
    });
  });

  it("restores runtime errors even when assistant content is empty", async () => {
    const { agentMessagesToChatMessages } = await import("./App");

    const restored = agentMessagesToChatMessages([
      { role: "user", content: "Try again" },
      {
        role: "assistant",
        content: [],
        runtimeError: {
          message: "Codex API error: timeout",
          retryable: true,
        },
      },
    ] as unknown[]);

    expect(restored).toHaveLength(2);
    expect(restored[1]?.role).toBe("assistant");
    expect(restored[1]?.blocks).toEqual([]);
    expect(restored[1]?.error).toEqual({
      message: "Codex API error: timeout",
      retryable: true,
    });
  });

  it("maps condense errors with metadata into a standard error block", () => {
    let state = reducer(initialState, {
      type: "CONDENSE_START",
    });

    state = reducer(state, {
      type: "ADD_CONDENSE_ERROR",
      errorMessage:
        "Condensing API call failed: Codex API error 429: The usage limit has been reached",
      retryable: true,
      code: "oauth_usage_limit_exhausted",
      actions: { signInAnotherAccount: true },
    });

    const last = state.messages[state.messages.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.error).toEqual({
      message:
        "Condensing API call failed: Codex API error 429: The usage limit has been reached",
      retryable: true,
      code: "oauth_usage_limit_exhausted",
      actions: { signInAnotherAccount: true },
    });
  });

  it("stores and clears detected question fallback state", () => {
    const detected = {
      messageId: "assistant-1",
      kind: "yes_no" as const,
      prompt: "Proceed?",
      options: [
        { label: "Yes", payload: "Yes" },
        { label: "No", payload: "No" },
      ],
    };

    let state = reducer(initialState, {
      type: "SET_DETECTED_QUESTION",
      detectedQuestion: detected,
    });
    expect(state.detectedQuestion).toEqual(detected);

    state = reducer(state, {
      type: "DISMISS_DETECTED_QUESTION",
      messageId: "assistant-1",
    });
    expect(state.detectedQuestion).toBeNull();
    expect(state.dismissedDetectedQuestionIds).toContain("assistant-1");
  });

  it("resets detected question state on NEW_SESSION", () => {
    let state = reducer(initialState, {
      type: "SET_DETECTED_QUESTION",
      detectedQuestion: {
        messageId: "assistant-2",
        kind: "yes_no",
        prompt: "Proceed?",
        options: [
          { label: "Yes", payload: "Yes" },
          { label: "No", payload: "No" },
        ],
      },
    });

    state = reducer(state, {
      type: "DISMISS_DETECTED_QUESTION",
      messageId: "assistant-2",
    });

    state = reducer(state, { type: "NEW_SESSION" });
    expect(state.detectedQuestion).toBeNull();
    expect(state.dismissedDetectedQuestionIds).toEqual([]);
  });
});
