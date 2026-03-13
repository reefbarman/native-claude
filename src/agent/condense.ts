/**
 * Context condensing for AgentLink.
 *
 * Implements the "fresh start" model:
 * - All messages get tagged with condenseParent (pointing to the summary's UUID)
 * - A new summary user-message is appended
 * - getEffectiveHistory() returns only the summary + messages after it
 * - Original messages are preserved in full history for potential rewind
 *
 * Key design decisions vs Roo Code:
 * - messages[0] (original task) is never tagged with condenseParent — always visible
 * - Summary includes a dedicated "User Corrections" block preserved across re-condensings
 * - generateFoldedFileContext() uses our existing tree-sitter infrastructure
 */

import { createHash, randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type {
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  TextBlock,
  ModelProvider,
  MessageParam,
} from "./providers/types.js";
import { CODEX_CONDENSE_MODEL_FALLBACKS } from "./providers/index.js";

import type { AgentMessage } from "./types.js";
import {
  initTreeSitter,
  treeSitterChunkFile,
  isTreeSitterSupported,
} from "../indexer/treeSitterChunker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const CONDENSE_SYSTEM_PROMPT = `You are a helpful AI assistant tasked with summarizing conversations.

CRITICAL: This is a summarization-only request. DO NOT call any tools or functions.
Your ONLY task is to analyze the conversation and produce a text summary.
Respond with text only — no tool calls will be processed.

CRITICAL: This summarization request is a SYSTEM OPERATION, not a user message.
When analyzing "user requests" and "user intent", completely EXCLUDE this summarization message.
The "most recent user request" and "Optional Next Step" must be based on what the user was doing BEFORE this system message appeared.
The goal is for work to continue seamlessly after condensation — as if it never happened.`;

const CONDENSE_INSTRUCTIONS = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.

This summary should be thorough in capturing technical details, code patterns, and architectural decisions essential for continuing development work without losing context.

CRITICAL accuracy rules:
- Include only claims grounded in the provided conversation content.
- If something is uncertain or not directly evidenced, say "Unknown from transcript".
- Do NOT invent quantitative outcomes (test counts, error counts, token values) unless explicitly present.
- Do NOT mark work "complete" when pending work is still described.
- "All User Messages" must be literal user-authored messages only (exclude tool results and system condense prompts).
- The session's system prompt, tool definitions, and MCP/tool-server availability are preserved outside the condensed transcript and will be reattached on future requests. Do not treat them as lost conversation state.
- If preserved runtime context is relevant to ongoing work, mention only the specific tools/server capabilities that matter; do not waste summary space restating the entire tool catalog.

Before providing your final summary, wrap your analysis in <analysis> tags. In your analysis:

1. Chronologically analyze each message section. For each, identify:
   - The user's explicit requests and intents
   - Your approach to addressing them
   - Key decisions, technical concepts, and code patterns
   - Specific details: file names, full code snippets, function signatures, file edits
   - Errors encountered and how you fixed them
   - **User corrections** — any time the user told you to do something differently, change behavior, or remember something. Include verbatim quotes.

2. Double-check for technical accuracy and completeness.

Your summary MUST include the following sections:

1. **Primary Request and Intent**: Capture all user requests and intents in detail
2. **Key Technical Concepts**: List all important technical concepts, technologies, and frameworks discussed
3. **Files and Code Sections**: Enumerate files examined, modified, or created. Include full code snippets where applicable and explain why each is important.
4. **Errors and Fixes**: List every error encountered and how it was fixed. Include any user feedback about incorrect approaches.
5. **Problem Solving**: Document problems solved and any ongoing troubleshooting.
6. **All User Messages**: List ALL user messages (not tool results) verbatim. Critical for preserving intent and changing instructions.
7. **User Corrections & Behavioral Directives** *(CRITICAL — preserve across all future condensings)*: Extract EVERY instance where the user:
   - Corrected your behavior ("use X not Y", "don't do Z")
   - Stated a persistent preference ("always use npm", "remember to check X first")
   - Gave behavioral feedback ("stop doing that", "that approach is wrong")
   Include verbatim quotes with turn numbers where possible. These MUST survive all future condensings.
8. **Pending Tasks**: Outline tasks explicitly asked but not yet completed.
9. **Current Work**: Describe in detail exactly what was being worked on immediately before this summary. Include file names and code snippets.
10. **Optional Next Step**: The single next step directly in line with the most recent work. Include direct quotes from recent conversation. Do NOT propose tangential tasks or revisit completed work without explicit user request.

Format your response exactly as:

<analysis>
[Your thorough analysis]
</analysis>

<summary>
[Your structured summary with the 10 sections above]
</summary>`;

// ---------------------------------------------------------------------------
// Tool block → text conversion (for summarization API call)
// ---------------------------------------------------------------------------

export function toolUseToText(block: ToolUseBlock): string {
  let input: string;
  if (typeof block.input === "object" && block.input !== null) {
    input = Object.entries(block.input)
      .map(
        ([k, v]) =>
          `${k}: ${typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)}`,
      )
      .join("\n");
  } else {
    input = String(block.input);
  }
  return `[Tool Use: ${block.name}]\n${input}`;
}

export function toolResultToText(block: ToolResultBlock): string {
  const errSuffix = block.is_error ? " (Error)" : "";
  if (typeof block.content === "string") {
    return `[Tool Result${errSuffix}]\n${block.content}`;
  }
  if (Array.isArray(block.content)) {
    const text = block.content
      .map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "image") return "[Image]";
        return `[${(b as { type: string }).type}]`;
      })
      .join("\n");
    return `[Tool Result${errSuffix}]\n${text}`;
  }
  return `[Tool Result${errSuffix}]`;
}

function convertToolBlocksToText(
  content: string | ContentBlock[],
): string | ContentBlock[] {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "tool_use")
      return { type: "text" as const, text: toolUseToText(block) };
    if (block.type === "tool_result")
      return { type: "text" as const, text: toolResultToText(block) };
    return block;
  });
}

function stripMedia(content: string | ContentBlock[]): string | ContentBlock[] {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "image")
      return { type: "text" as const, text: "[Image]" };
    if (block.type === "document") {
      const title = (block as { title?: string }).title ?? "PDF";
      return { type: "text" as const, text: `[Document: ${title}]` };
    }
    return block;
  });
}

const MAX_TOOL_RESULT_TEXT_CHARS = 20_000;

function normalizeToolResultText(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_TEXT_CHARS) return text;
  const headChars = Math.floor(MAX_TOOL_RESULT_TEXT_CHARS * 0.5);
  const head = text.slice(0, headChars);
  const tail = text.slice(
    text.length - (MAX_TOOL_RESULT_TEXT_CHARS - headChars),
  );
  const omittedChars = text.length - head.length - tail.length;
  const omittedTokens = Math.ceil(omittedChars / 4);
  return `${head}\n\n[... ~${omittedTokens.toLocaleString()} tokens (~${omittedChars.toLocaleString()} chars) omitted from middle ...]\n\n${tail}`;
}

function transformMessagesForCondensing(
  messages: AgentMessage[],
): AgentMessage[] {
  return messages.map((msg) => {
    const transformed = stripMedia(convertToolBlocksToText(msg.content));
    if (typeof transformed === "string") {
      return {
        ...msg,
        content:
          msg.role === "user" && msg.isSummary
            ? transformed
            : normalizeToolResultText(transformed),
      };
    }
    const normalizedBlocks = transformed.map((block) =>
      block.type === "text"
        ? { ...block, text: normalizeToolResultText(block.text) }
        : block,
    );
    return {
      ...msg,
      content: normalizedBlocks,
    };
  });
}

// ---------------------------------------------------------------------------
// Orphan tool result injection
// ---------------------------------------------------------------------------

/**
 * If condense is triggered mid-turn (assistant emitted tool_use but no tool_result yet),
 * inject a synthetic tool_result so the API doesn't reject the conversation.
 */
export function injectSyntheticToolResults(
  messages: AgentMessage[],
): AgentMessage[] {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use")
          toolCallIds.add((block as ToolUseBlock).id);
      }
    }
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result")
          toolResultIds.add((block as ToolResultBlock).tool_use_id);
      }
    }
  }

  const orphans = [...toolCallIds].filter((id) => !toolResultIds.has(id));
  if (orphans.length === 0) return messages;

  const syntheticResults: ToolResultBlock[] = orphans.map((id) => ({
    type: "tool_result" as const,
    tool_use_id: id,
    content: "Context condensation triggered. Tool execution deferred.",
  }));

  return [...messages, { role: "user", content: syntheticResults }];
}

// ---------------------------------------------------------------------------
// Effective history (what gets sent to the API)
// ---------------------------------------------------------------------------

/**
 * Returns messages after the last summary (exclusive). If no summary, returns all.
 * This avoids recursively re-summarizing prior summary prose.
 */
export function getMessagesSinceLastSummary(
  messages: AgentMessage[],
): AgentMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isSummary) return messages.slice(i + 1);
  }
  return messages;
}

/**
 * Filter full history down to what should be sent to the API.
 *
 * Rules:
 * - messages[0] is always included (original task — never condensed)
 * - If a summary exists, only messages from the summary onwards are sent
 *   (fresh-start model)
 * - Messages with condenseParent pointing to an existing summary are filtered out
 */
export function getEffectiveHistory(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length === 0) return messages;

  const filterOrphanToolResults = (window: AgentMessage[]): AgentMessage[] => {
    const toolUseIds = new Set<string>();
    for (const msg of window) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            toolUseIds.add((block as ToolUseBlock).id);
          }
        }
      }
    }

    return window
      .map((msg) => {
        if (msg.role === "user" && Array.isArray(msg.content)) {
          const kept = msg.content.filter((block) => {
            if (block.type === "tool_result") {
              return toolUseIds.has((block as ToolResultBlock).tool_use_id);
            }
            return true;
          });
          if (kept.length === 0) return null;
          if (kept.length !== msg.content.length) {
            return { ...msg, content: kept };
          }
        }
        return msg;
      })
      .filter((msg): msg is AgentMessage => msg !== null);
  };

  // Find the most recent summary
  let lastSummaryIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isSummary) {
      lastSummaryIdx = i;
      break;
    }
  }

  if (lastSummaryIdx === -1) return messages; // no summary yet

  const fromSummary = filterOrphanToolResults(messages.slice(lastSummaryIdx));
  const summary = fromSummary[0];
  if (!summary?.isSummary) {
    return fromSummary;
  }

  const laterMessages = fromSummary.slice(1);
  const canonicalUserMessages = extractCanonicalUserMessages(messages);
  const pendingTasks = extractPendingTasksHeuristic(messages);
  const resumeAnchor = extractResumeAnchor({
    userMessages: canonicalUserMessages,
    pendingTasks,
  });

  const preservedContext = summary.preservedContext;

  const resumeContextMessage: AgentMessage = {
    role: "user",
    isResumeContext: true,
    content: [
      {
        type: "text",
        text: renderDeterministicSections({
          userMessages: canonicalUserMessages,
          pendingTasks,
          resumeAnchor,
          preservedContext,
        }),
      } satisfies TextBlock,
    ],
  };

  let insertionIndex = laterMessages.findIndex(
    (msg) => msg.role === "user" && !msg.isSummary,
  );
  if (insertionIndex === -1) {
    insertionIndex = 0;
  }

  return [
    summary,
    ...laterMessages.slice(0, insertionIndex),
    resumeContextMessage,
    ...laterMessages.slice(insertionIndex),
  ];
}

// ---------------------------------------------------------------------------
// Folded file context (tree-sitter structural extraction)
// ---------------------------------------------------------------------------

/**
 * Generate a condensed structural outline of files the agent has read.
 * Uses our existing tree-sitter chunker to extract function/class signatures.
 * Each file is wrapped in a <system-reminder> block.
 */
export async function generateFoldedFileContext(
  filePaths: string[],
  cwd: string,
  maxChars = 50_000,
): Promise<string[]> {
  if (filePaths.length === 0) return [];

  // Ensure tree-sitter is initialized
  try {
    await initTreeSitter();
  } catch {
    return []; // tree-sitter not available
  }

  const sections: string[] = [];
  let totalChars = 0;

  for (const filePath of filePaths) {
    if (totalChars >= maxChars) break;

    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd, filePath);

    if (!isTreeSitterSupported(absPath)) continue;

    try {
      const content = await fs.readFile(absPath, "utf-8");
      const relPath = path.isAbsolute(filePath)
        ? path.relative(cwd, absPath)
        : filePath;

      const chunks = await treeSitterChunkFile(content, absPath, relPath);
      if (chunks.length === 0) continue;

      // Build signature lines: "startLine--endLine | first_line_of_chunk"
      const sigLines = chunks
        .map((chunk) => {
          const firstLine = chunk.content.split("\n")[0].trim();
          if (!firstLine) return null;
          return `${chunk.startLine}--${chunk.endLine} | ${firstLine}`;
        })
        .filter((l): l is string => l !== null);

      if (sigLines.length === 0) continue;

      const section = `<system-reminder>\n## File Context: ${relPath}\n${sigLines.join("\n")}\n</system-reminder>`;

      if (totalChars + section.length > maxChars) {
        // Truncate to fit
        const remaining = maxChars - totalChars;
        if (remaining < 100) break;
        const truncated =
          section.slice(0, remaining - 20) +
          "\n... (truncated)\n</system-reminder>";
        sections.push(truncated);
        totalChars += truncated.length;
        break;
      }

      sections.push(section);
      totalChars += section.length;
    } catch {
      // Skip files that can't be read
    }
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Main: summarizeConversation
// ---------------------------------------------------------------------------

export interface SummarizeOptions {
  messages: AgentMessage[];
  provider: ModelProvider;
  systemPrompt: string;
  isAutomatic: boolean;
  filesRead?: string[];
  cwd?: string;
  preservedContext?: {
    toolNames: string[];
    mcpServerNames?: string[];
  };
}

export interface SummarizeResult {
  messages: AgentMessage[];
  /** Full summary text (for debug/evaluation) */
  summary: string;
  prevInputTokens: number;
  newInputTokens: number;
  /** Non-fatal validator/retry warnings */
  validationWarnings?: string[];
  /** Structured condense metadata for debugging/forensics */
  metadata?: {
    inputMessageCount: number;
    sourceUserMessageCount: number;
    hadPriorSummaryInInput: boolean;
    retryUsed: boolean;
    validatorErrors: string[];
    sourceHash: string;
    providerId: string;
    condenseModel: string;
    modelCandidates: string[];
    selectedModel: string;
    latestUserMessage: string;
    currentTask: string;
    pendingTasks: string[];
    canonicalUserMessages: string[];
    requestMessageCount: number;
    effectiveHistoryMessageCount: number;
    effectiveHistoryRoles: string[];
  };
  error?: string;
}

function extractCanonicalUserMessages(messages: AgentMessage[]): string[] {
  return messages
    .filter((m) => m.role === "user" && !m.isSummary && !m.isResumeContext)
    .map((m) => {
      if (typeof m.content === "string") {
        return m.content.trim();
      }
      if (!Array.isArray(m.content)) {
        return "";
      }
      return m.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text.trim())
        .filter((text) => text.length > 0)
        .join("\n")
        .trim();
    })
    .filter((t) => t.length > 0);
}

function extractPendingTasksHeuristic(messages: AgentMessage[]): string[] {
  const userTexts = extractCanonicalUserMessages(messages);
  const candidates: string[] = [];
  for (const text of userTexts.slice(-8)) {
    const lower = text.toLowerCase();
    if (
      /(todo|next|left|implement|fix|add|finish|continue|do that|lets do that|let's do that)/.test(
        lower,
      )
    ) {
      candidates.push(text);
    }
  }
  return [...new Set(candidates)].slice(-6);
}

function extractResumeAnchor(options: {
  userMessages: string[];
  pendingTasks: string[];
}): { latestUserMessage: string; currentTask: string } {
  const latestUserMessage =
    options.userMessages[options.userMessages.length - 1] ??
    "Unknown from transcript";
  const currentTask =
    options.pendingTasks[options.pendingTasks.length - 1] ??
    "Unknown from transcript";
  return { latestUserMessage, currentTask };
}

export function renderDeterministicSections(options: {
  userMessages: string[];
  pendingTasks: string[];
  resumeAnchor: {
    latestUserMessage: string;
    currentTask: string;
  };
  preservedContext?: {
    toolNames: string[];
    mcpServerNames?: string[];
  };
}): string {
  const userLines =
    options.userMessages.length > 0
      ? options.userMessages.map((m, i) => `${i + 1}. "${m}"`).join("\n")
      : "1. None";

  const pendingLines =
    options.pendingTasks.length > 0
      ? options.pendingTasks.map((t) => `- ${t}`).join("\n")
      : "- None explicitly identified";

  const toolLines = options.preservedContext?.toolNames?.length
    ? options.preservedContext.toolNames.map((name) => `- ${name}`).join("\n")
    : "- Unknown";

  const serverLines = options.preservedContext?.mcpServerNames?.length
    ? options.preservedContext.mcpServerNames
        .map((name) => `- ${name}`)
        .join("\n")
    : "- None";

  return [
    "<system-reminder>",
    "## Resume Anchor (deterministic)",
    `- Latest user message: "${options.resumeAnchor.latestUserMessage}"`,
    `- Continue from this task: "${options.resumeAnchor.currentTask}"`,
    "",
    "## Canonical User Messages (deterministic)",
    userLines,
    "",
    "## Pending Tasks (deterministic heuristic)",
    pendingLines,
    "",
    "## Preserved Runtime Context (reattached outside transcript)",
    "### Available tool names",
    toolLines,
    "",
    "### MCP servers with exposed tools",
    serverLines,
    "</system-reminder>",
  ].join("\n");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractNumberedSection(summaryText: string, title: string): string {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const numberedMatch = summaryText.match(
    new RegExp(
      `(?:^|\\n)\\d+\\.\\s+\\*\\*${escapedTitle}(?:[^*]*)\\*\\*:?([\\s\\S]*?)(?=\\n\\d+\\.\\s+\\*\\*|$)`,
      "i",
    ),
  );
  if (numberedMatch?.[1]) return numberedMatch[1].trim();

  const boldMatch = summaryText.match(
    new RegExp(
      `(?:^|\\n)\\*\\*${escapedTitle}(?:[^*]*)\\*\\*:?([\\s\\S]*?)(?=\\n(?:\\d+\\.\\s+\\*\\*|\\*\\*)|$)`,
      "i",
    ),
  );
  return boldMatch?.[1]?.trim() ?? "";
}

function buildDeterministicFallbackSummary(options: {
  userMessages: string[];
  pendingTasks: string[];
  resumeAnchor: {
    latestUserMessage: string;
    currentTask: string;
  };
}): string {
  const allUserMessages =
    options.userMessages.length > 0
      ? options.userMessages.map((m) => `- "${m}"`).join("\n")
      : "- None";
  const pendingTasks =
    options.pendingTasks.length > 0
      ? options.pendingTasks.map((t) => `- ${t}`).join("\n")
      : "- None explicitly identified";

  return [
    "1. **Primary Request and Intent**: Continue the active work captured in the latest user message and pending task anchor.",
    "2. **Key Technical Concepts**: Unknown from transcript.",
    "3. **Files and Code Sections**: Unknown from transcript.",
    "4. **Errors and Fixes**: Unknown from transcript.",
    "5. **Problem Solving**: Use the deterministic resume anchor and canonical user messages below as the source of truth.",
    `6. **All User Messages**:\n${allUserMessages}`,
    "7. **User Corrections & Behavioral Directives**: Unknown from transcript.",
    `8. **Pending Tasks**:\n${pendingTasks}`,
    `9. **Current Work**: Continue from this task: "${options.resumeAnchor.currentTask}". Latest user message: "${options.resumeAnchor.latestUserMessage}".`,
    `10. **Optional Next Step**: Resume work on "${options.resumeAnchor.currentTask}".`,
  ].join("\n\n");
}

function isUnsupportedCodexModelError(message: string): boolean {
  return /model is not supported|unsupported model|invalid model/i.test(
    message,
  );
}

function validateSummary(options: {
  summaryText: string;
  canonicalUserMessages: string[];
}): {
  errors: string[];
  warnings: string[];
  stats: {
    unmatchedQuotedStrings: number;
    preservedCanonicalMessages: number;
    latestUserMessagePreserved: boolean;
  };
} {
  const { summaryText, canonicalUserMessages } = options;
  const errors: string[] = [];
  const warnings: string[] = [];
  const lower = summaryText.toLowerCase();

  if (!/all user messages/i.test(summaryText)) {
    warnings.push(
      "Summary missing an explicit 'All User Messages' section header.",
    );
  }

  const unsupportedQuant =
    /(\d+\s*\/\s*\d+\s+tests?\s+pass|all\s+tests\s+pass(ed)?|\b\d+\s+tests\s+pass(ed)?)/i;
  if (unsupportedQuant.test(summaryText)) {
    errors.push(
      "Summary includes high-confidence test pass counts/claims; requires direct evidence.",
    );
  }

  if (
    /(feature-complete|fully complete|all done|nothing left)/i.test(lower) &&
    /(not yet|in progress|pending|todo|to do|left to)/i.test(lower)
  ) {
    errors.push(
      "Summary has a completion contradiction (complete vs pending).",
    );
  }

  const allUserMessagesSection = extractNumberedSection(
    summaryText,
    "All User Messages",
  );
  const normalizedAllUserMessagesSection = normalizeWhitespace(
    allUserMessagesSection,
  );
  const normalizedCanonicalMessages =
    canonicalUserMessages.map(normalizeWhitespace);
  const preservedCanonicalMessages = normalizedCanonicalMessages.filter(
    (message) => normalizedAllUserMessagesSection.includes(message),
  ).length;
  const latestCanonicalMessage = normalizedCanonicalMessages.at(-1);
  const latestUserMessagePreserved = latestCanonicalMessage
    ? normalizedAllUserMessagesSection.includes(latestCanonicalMessage)
    : true;

  if (canonicalUserMessages.length > 0 && !latestUserMessagePreserved) {
    errors.push(
      "Summary's 'All User Messages' section does not preserve the latest canonical user message verbatim.",
    );
  }

  if (
    canonicalUserMessages.length > 1 &&
    preservedCanonicalMessages < Math.min(2, canonicalUserMessages.length)
  ) {
    warnings.push(
      `Summary preserved only ${preservedCanonicalMessages}/${canonicalUserMessages.length} canonical user messages verbatim in the 'All User Messages' section.`,
    );
  }

  const quoted = [...summaryText.matchAll(/"([^"]{2,400})"/g)].map((m) => m[1]);
  const unmatched = quoted.filter(
    (q) =>
      q.trim().length > 4 &&
      !canonicalUserMessages.some((u) => u.includes(q) || q.includes(u)),
  );
  if (unmatched.length > 0) {
    warnings.push(
      `Summary contains ${unmatched.length} quoted strings not matched to canonical user messages.`,
    );
  }

  return {
    errors,
    warnings,
    stats: {
      unmatchedQuotedStrings: unmatched.length,
      preservedCanonicalMessages,
      latestUserMessagePreserved,
    },
  };
}

function sourceWindowHash(messages: AgentMessage[]): string {
  const basis = messages
    .map(
      (m) =>
        `${m.role}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
    )
    .join("\n---\n");
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function extractSummaryText(raw: string): string {
  const summary = raw.trim();
  if (!summary) return "";
  const summaryMatch = summary.match(/<summary>([\s\S]*?)<\/summary>/i);
  return summaryMatch ? summaryMatch[1].trim() : summary;
}

export async function summarizeConversation(
  options: SummarizeOptions,
  prevInputTokens = 0,
): Promise<SummarizeResult> {
  const { messages, provider, systemPrompt, filesRead, cwd, preservedContext } =
    options;

  const errorResult = (error: string): SummarizeResult => ({
    messages,
    summary: "",
    prevInputTokens,
    newInputTokens: prevInputTokens,
    error,
  });

  const toSummarize = getMessagesSinceLastSummary(messages);
  if (toSummarize.length <= 1) {
    return errorResult(
      messages.length <= 1
        ? "Not enough messages to condense."
        : "Already condensed recently — more conversation needed first.",
    );
  }

  const hadPriorSummaryInInput = toSummarize.some((m) => m.isSummary);
  const canonicalUserMessages = extractCanonicalUserMessages(toSummarize);
  const pendingTasks = extractPendingTasksHeuristic(toSummarize);
  const resumeAnchor = extractResumeAnchor({
    userMessages: canonicalUserMessages,
    pendingTasks,
  });
  const deterministicSections = renderDeterministicSections({
    userMessages: canonicalUserMessages,
    pendingTasks,
    resumeAnchor,
    preservedContext,
  });

  const withSyntheticResults = injectSyntheticToolResults(toSummarize);
  const transformed = transformMessagesForCondensing(withSyntheticResults);

  const finalMsg: MessageParam = {
    role: "user",
    content: `${CONDENSE_INSTRUCTIONS}\n\n${deterministicSections}`,
  };

  const requestMessages: MessageParam[] = [
    ...transformed.map(({ role, content }) => ({ role, content })),
    finalMsg,
  ];

  const fileContextPromise =
    filesRead && filesRead.length > 0 && cwd
      ? generateFoldedFileContext(filesRead, cwd).catch(() => [] as string[])
      : Promise.resolve([] as string[]);

  const validationWarnings: string[] = [];
  let retryUsed = false;
  let validatorErrors: string[] = [];
  let summaryText = "";
  const modelCandidates =
    provider.id === "codex"
      ? [...CODEX_CONDENSE_MODEL_FALLBACKS]
      : [provider.condenseModel];
  let selectedModel = modelCandidates[0];

  const completeOnce = async (
    extraInstruction?: string,
  ): Promise<{ text: string; error?: string }> => {
    const adjustedMessages =
      extraInstruction && requestMessages.length > 0
        ? [
            ...requestMessages.slice(0, -1),
            {
              role: "user" as const,
              content: `${requestMessages[requestMessages.length - 1].content}\n\n${extraInstruction}`,
            },
          ]
        : requestMessages;

    let lastError = "";

    for (const model of modelCandidates) {
      try {
        const result = await provider.complete({
          model,
          systemPrompt: CONDENSE_SYSTEM_PROMPT,
          messages: adjustedMessages,
          maxTokens: 8192,
          temperature: 0,
        });
        selectedModel = model;
        return { text: result.text };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;
        const shouldRetry =
          provider.id === "codex" && isUnsupportedCodexModelError(msg);
        if (!shouldRetry) {
          return { text: "", error: `Condensing API call failed: ${msg}` };
        }
      }
    }

    return { text: "", error: `Condensing API call failed: ${lastError}` };
  };

  const first = await completeOnce();
  if (first.error) return errorResult(first.error);
  summaryText = extractSummaryText(first.text);
  if (!summaryText) return errorResult("Condensing produced no output.");

  let validation = validateSummary({
    summaryText,
    canonicalUserMessages,
  });
  validatorErrors = [...validation.errors];
  validationWarnings.push(...validation.warnings);

  if (validation.errors.length > 0) {
    retryUsed = true;
    const retry = await completeOnce(
      `VALIDATION FAILED. Fix these issues and regenerate a corrected summary:\n- ${validation.errors.join("\n- ")}\n\nDo not invent unsupported metrics or completion claims.`,
    );
    if (retry.error) {
      validationWarnings.push(
        `Validation retry failed, using first-pass summary: ${retry.error}`,
      );
    } else {
      const retried = extractSummaryText(retry.text);
      if (retried) {
        summaryText = retried;
        validation = validateSummary({ summaryText, canonicalUserMessages });
        validatorErrors = [...validation.errors];
        validationWarnings.push(...validation.warnings);
      }
    }
    if (validatorErrors.length > 0) {
      validationWarnings.push(
        `Summary still has validator issues after retry: ${validatorErrors.join("; ")}`,
      );
      summaryText = buildDeterministicFallbackSummary({
        userMessages: canonicalUserMessages,
        pendingTasks,
        resumeAnchor,
      });
      validationWarnings.push(
        "Fell back to a deterministic summary because the model-authored summary could not be trusted after retry.",
      );
    }
  }

  const summaryContent: ContentBlock[] = [
    {
      type: "text",
      text: deterministicSections,
    } satisfies TextBlock,
    {
      type: "text",
      text: `## Conversation Summary\n\n${summaryText}`,
    } satisfies TextBlock,
  ];

  const correctionsMatch = summaryText.match(
    /\*\*User Corrections[^*]*\*\*([\s\S]*?)(?=\n\*\*|\n\d+\.|$)/i,
  );
  if (correctionsMatch) {
    const corrections = correctionsMatch[1].trim();
    if (corrections && corrections.length > 20) {
      summaryContent.push({
        type: "text",
        text: `<system-reminder>\n## Persistent User Corrections & Preferences\n${corrections}\n</system-reminder>`,
      });
    }
  }

  const fileContextSections = await fileContextPromise;
  for (const section of fileContextSections) {
    summaryContent.push({ type: "text", text: section });
  }

  const condenseId = randomUUID();
  const summaryMessage: AgentMessage = {
    role: "user",
    content: summaryContent,
    isSummary: true,
    condenseId,
    preservedContext,
  };

  const newMessages: AgentMessage[] = messages.map((msg, idx) => {
    if (idx === 0) return msg;
    if (msg.condenseParent) return msg;
    return { ...msg, condenseParent: condenseId };
  });

  newMessages.push(summaryMessage);

  const newInputTokens = Math.ceil(
    (systemPrompt.length +
      summaryContent.reduce(
        (acc, b) => acc + (b.type === "text" ? b.text.length : 0),
        0,
      )) /
      4,
  );

  const effectiveHistory = getEffectiveHistory(newMessages);

  return {
    messages: newMessages,
    summary: summaryText,
    prevInputTokens,
    newInputTokens,
    validationWarnings,
    metadata: {
      inputMessageCount: toSummarize.length,
      sourceUserMessageCount: canonicalUserMessages.length,
      hadPriorSummaryInInput,
      retryUsed,
      validatorErrors,
      sourceHash: sourceWindowHash(toSummarize),
      providerId: provider.id,
      condenseModel: provider.condenseModel,
      modelCandidates,
      selectedModel,
      latestUserMessage: resumeAnchor.latestUserMessage,
      currentTask: resumeAnchor.currentTask,
      pendingTasks,
      canonicalUserMessages,
      requestMessageCount: requestMessages.length,
      effectiveHistoryMessageCount: effectiveHistory.length,
      effectiveHistoryRoles: effectiveHistory.map((msg) => {
        if (msg.isSummary) return `${msg.role}:summary`;
        if (msg.isResumeContext) return `${msg.role}:resume`;
        return msg.role;
      }),
    },
  };
}
