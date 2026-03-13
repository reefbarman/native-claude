import { describe, expect, it, vi } from "vitest";
import { getEffectiveHistory, summarizeConversation } from "./condense.js";
import type { AgentMessage } from "./types.js";
import type {
  CompleteRequest,
  CompleteResult,
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  StreamRequest,
  ProviderStreamEvent,
} from "./providers/types.js";

const TEST_MODEL = "claude-sonnet-4-6";

const TEST_CAPABILITIES: ModelCapabilities = {
  supportsThinking: false,
  supportsCaching: true,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
};

function makeProvider(
  onComplete?: (request: CompleteRequest) => CompleteResult,
) {
  const complete = vi.fn(async (request: CompleteRequest) =>
    onComplete
      ? onComplete(request)
      : {
          text: `<summary>
1. **Primary Request and Intent**: Keep working.
2. **Key Technical Concepts**: TypeScript.
3. **Files and Code Sections**: src/agent/condense.ts.
4. **Errors and Fixes**: None.
5. **Problem Solving**: Preserved context.
6. **All User Messages**: "Investigate condense"
7. **User Corrections & Behavioral Directives**: None.
8. **Pending Tasks**: None.
9. **Current Work**: Inspecting condense behavior.
10. **Optional Next Step**: Continue.
</summary>`,
        },
  );

  const provider: ModelProvider = {
    id: "mock",
    displayName: "Mock",
    condenseModel: "mock-condense",
    async isAuthenticated() {
      return true;
    },
    getCapabilities() {
      return TEST_CAPABILITIES;
    },
    listModels(): ModelInfo[] {
      return [
        {
          id: TEST_MODEL,
          displayName: "Test Model",
          provider: "mock",
          capabilities: TEST_CAPABILITIES,
        },
      ];
    },
    async *stream(
      _request: StreamRequest,
    ): AsyncGenerator<ProviderStreamEvent> {
      yield* [];
    },
    complete,
  };

  return { provider, complete };
}

function makeMessages(): AgentMessage[] {
  return [
    { role: "user", content: "Investigate condense" } as AgentMessage,
    { role: "assistant", content: [{ type: "text", text: "Looking now." }] },
  ];
}

describe("summarizeConversation", () => {
  it("passes preserved runtime context into the condense prompt", async () => {
    const { provider, complete } = makeProvider();

    await summarizeConversation({
      messages: makeMessages(),
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: ["read_file", "codebase_search", "linear__get_issue"],
        mcpServerNames: ["linear", "notion"],
      },
    });

    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0][0] as CompleteRequest;
    const finalMessage = request.messages[request.messages.length - 1];
    expect(finalMessage.role).toBe("user");
    expect(String(finalMessage.content)).toContain(
      "## Preserved Runtime Context (reattached outside transcript)",
    );
    expect(String(finalMessage.content)).toContain("- read_file");
    expect(String(finalMessage.content)).toContain("- codebase_search");
    expect(String(finalMessage.content)).toContain("- linear");
    expect(String(finalMessage.content)).toContain("- notion");
  });

  it("includes preserved runtime context in post-condense token estimates", async () => {
    const messages = makeMessages();
    const { provider } = makeProvider();

    const withoutContext = await summarizeConversation({
      messages,
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
    });

    const withContext = await summarizeConversation({
      messages,
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: [
          "read_file",
          "codebase_search",
          "search_files",
          "notion__notion-fetch",
          "linear__get_issue",
        ],
        mcpServerNames: ["notion", "linear"],
      },
    });

    expect(withContext.error).toBeUndefined();
    expect(withContext.newInputTokens).toBeGreaterThan(
      withoutContext.newInputTokens,
    );
  });

  it("still appends a summary message and tags prior messages on success", async () => {
    const { provider } = makeProvider();
    const result = await summarizeConversation({
      messages: makeMessages(),
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: ["read_file"],
        mcpServerNames: [],
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.validationWarnings ?? []).toHaveLength(0);
    expect(result.messages).toHaveLength(3);
    const summary = result.messages[result.messages.length - 1];
    expect(summary.isSummary).toBe(true);
    expect(summary.condenseId).toBeTruthy();
    expect(result.messages[1].condenseParent).toBe(summary.condenseId);
    expect(Array.isArray(summary.content)).toBe(true);
    const content = summary.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("## Resume Anchor (deterministic)");
    expect(content[1]?.text).toContain("## Conversation Summary");
  });

  it("falls back to a deterministic summary when the model omits the latest user message after retry", async () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Investigate condense" } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "Looking now." }] },
      {
        role: "user",
        content:
          "Continue fixing the condense resume bug for Codex after summarization.",
      } as AgentMessage,
    ];

    let callCount = 0;
    const { provider, complete } = makeProvider(() => {
      callCount += 1;
      return {
        text: `<summary>
1. **Primary Request and Intent**: Keep working.
2. **Key Technical Concepts**: TypeScript.
3. **Files and Code Sections**: src/agent/condense.ts.
4. **Errors and Fixes**: None.
5. **Problem Solving**: Preserved context.
6. **All User Messages**: "Investigate condense"
7. **User Corrections & Behavioral Directives**: None.
8. **Pending Tasks**: None.
9. **Current Work**: Inspecting condense behavior.
10. **Optional Next Step**: Continue.
</summary>`,
      };
    });

    const result = await summarizeConversation({
      messages,
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: ["read_file", "codebase_search"],
        mcpServerNames: ["linear"],
      },
    });

    expect(result.error).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(callCount).toBe(2);
    expect(result.validationWarnings).toContain(
      "Fell back to a deterministic summary because the model-authored summary could not be trusted after retry.",
    );

    const summary = result.messages[result.messages.length - 1];
    expect(summary.isSummary).toBe(true);
    const content = summary.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("Continue from this task");
    expect(content[0]?.text).toContain(
      "Continue fixing the condense resume bug for Codex after summarization.",
    );
    expect(content[1]?.text).toContain(
      '9. **Current Work**: Continue from this task: "Continue fixing the condense resume bug for Codex after summarization."',
    );
  });

  it("uses an honest resume anchor when no pending task heuristic matches", async () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Investigate condense" } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "Looking now." }] },
      {
        role: "user",
        content: "What likely caused the context loss after summarization?",
      } as AgentMessage,
    ];

    const { provider } = makeProvider();
    const result = await summarizeConversation({
      messages,
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: ["read_file"],
        mcpServerNames: [],
      },
    });

    expect(result.error).toBeUndefined();
    const summary = result.messages[result.messages.length - 1];
    const content = summary.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain(
      'Latest user message: "What likely caused the context loss after summarization?"',
    );
    expect(content[0]?.text).toContain(
      'Continue from this task: "Unknown from transcript"',
    );
  });

  it("injects a canonical resume-context message into effective history after the summary", async () => {
    const { provider } = makeProvider();
    const result = await summarizeConversation({
      messages: [
        { role: "user", content: "Investigate condense" } as AgentMessage,
        {
          role: "assistant",
          content: [{ type: "text", text: "Looking now." }],
        },
        {
          role: "user",
          content:
            "Continue fixing the condense resume bug for Codex after summarization.",
        } as AgentMessage,
      ],
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: ["read_file", "codebase_search"],
        mcpServerNames: ["linear"],
      },
    });

    expect(result.error).toBeUndefined();
    const effective = getEffectiveHistory(result.messages);
    expect(effective).toHaveLength(2);
    expect(effective[0]?.isSummary).toBe(true);
    expect(effective[1]?.isResumeContext).toBe(true);
    expect(Array.isArray(effective[1]?.content)).toBe(true);
    const injected = effective[1]?.content as Array<{
      type: string;
      text?: string;
    }>;
    expect(injected[0]?.text).toContain("## Resume Anchor (deterministic)");
    expect(injected[0]?.text).toContain(
      'Continue from this task: "Continue fixing the condense resume bug for Codex after summarization."',
    );
  });

  it("places the injected resume-context message immediately before the next real user message", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        isSummary: true,
        condenseId: "condense-1",
        preservedContext: {
          toolNames: ["read_file"],
          mcpServerNames: ["linear"],
        },
        content: [
          {
            type: "text",
            text: '<system-reminder>\n## Resume Anchor (deterministic)\n- Latest user message: "Fix issue"\n- Continue from this task: "Fix issue"\n\n## Canonical User Messages (deterministic)\n1. "Fix issue"\n\n## Pending Tasks (deterministic heuristic)\n- Fix issue\n\n## Preserved Runtime Context (reattached outside transcript)\n### Available tool names\n- read_file\n\n### MCP servers with exposed tools\n- linear\n</system-reminder>',
          },
          { type: "text", text: "## Conversation Summary\n\nSummary body" },
        ],
      } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "Need a bit more context." }],
      },
      { role: "user", content: "Continue fixing the issue." } as AgentMessage,
    ];

    const effective = getEffectiveHistory(messages);
    expect(effective).toHaveLength(4);
    expect(effective[0]?.isSummary).toBe(true);
    expect(effective[1]?.role).toBe("assistant");
    expect(effective[2]?.role).toBe("user");
    expect(effective[2]?.isResumeContext).toBe(true);
    expect(Array.isArray(effective[2]?.content)).toBe(true);
    const injected = effective[2]?.content as Array<{
      type: string;
      text?: string;
    }>;
    expect(injected[0]?.text).toContain("## Resume Anchor (deterministic)");
    expect(effective[3]).toEqual({
      role: "user",
      content: "Continue fixing the issue.",
    });
  });

  it("derives canonical user messages from array-content user messages", async () => {
    const { provider } = makeProvider(() => ({
      text: `<summary>
1. **Primary Request and Intent**: Keep working.
2. **Key Technical Concepts**: TypeScript.
3. **Files and Code Sections**: src/agent/condense.ts.
4. **Errors and Fixes**: None.
5. **Problem Solving**: Preserved context.
6. **All User Messages**: "Please investigate the screenshot and continue the fix." 
7. **User Corrections & Behavioral Directives**: None.
8. **Pending Tasks**: - Please investigate the screenshot and continue the fix.
9. **Current Work**: Continue from this task: "Please investigate the screenshot and continue the fix."
10. **Optional Next Step**: Continue.
</summary>`,
    }));

    const result = await summarizeConversation({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Please investigate the screenshot and continue the fix.",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "abc123",
              },
            },
          ],
        } as AgentMessage,
        {
          role: "assistant",
          content: [{ type: "text", text: "Looking now." }],
        },
      ],
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: ["read_file"],
        mcpServerNames: [],
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.metadata?.canonicalUserMessages).toEqual([
      "Please investigate the screenshot and continue the fix.",
    ]);
    expect(result.metadata?.latestUserMessage).toBe(
      "Please investigate the screenshot and continue the fix.",
    );
  });
});
