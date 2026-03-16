import {
  useReducer,
  useEffect,
  useCallback,
  useRef,
  useState,
} from "preact/hooks";
import type {
  ExtensionMessage,
  ChatMessage,
  ChatState,
  ContentBlock,
  TodoItem,
  ModeInfo,
  SlashCommandInfo,
  Question,
  SessionSummary,
} from "./types";
import type {
  ApprovalRequest,
  DecisionMessage,
} from "../../approvals/webview/types";
import { ChatView } from "./components/ChatView";
import { ElicitationModal } from "./components/ElicitationModal";
import { InputArea } from "./components/InputArea";
import { DebugInfo } from "./components/DebugInfo";
import { ContextBar } from "./components/ContextBar";
import { TodoPanel } from "./components/TodoPanel";
import { CommandCard } from "../../approvals/webview/components/CommandCard";
import { WriteCard } from "../../approvals/webview/components/WriteCard";
import { RenameCard } from "../../approvals/webview/components/RenameCard";
import { PathCard } from "../../approvals/webview/components/PathCard";
import { McpCard } from "../../approvals/webview/components/McpCard";
import { ModeSwitchCard } from "../../approvals/webview/components/ModeSwitchCard";
import { QuestionCard } from "./components/QuestionCard";
import { SessionHistory } from "./components/SessionHistory";
import { BackgroundSessionStrip } from "./components/BackgroundSessionStrip";
import type { BgSessionInfoProps } from "./components/BackgroundSessionStrip";
import { getStreamingActivity } from "./components/MessageBubble";
import { TranscriptView } from "./components/TranscriptView";
import { BtwPanel } from "./components/BtwPanel";
import type { BtwState } from "./components/BtwPanel";
import type { WebviewModelInfo } from "./types";

const DEFAULT_MAX_TOKENS = 200_000;

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

interface AppState {
  messages: ChatMessage[];
  chatState: ChatState;
  streaming: boolean;
  thinkingEnabled: boolean;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastCacheReadTokens: number;
  debugInfo: Record<string, string | number> | null;
  systemPrompt: string | null;
  loadedInstructions: Array<{ source: string; chars: number }> | null;
  todos: TodoItem[];
  modes: ModeInfo[];
  availableModels: WebviewModelInfo[];
  slashCommands: SlashCommandInfo[];
  messageQueue: Array<{
    id: string;
    text: string;
    fullText?: string;
    isSlashCommand?: boolean;
    attachments?: string[];
    images?: Array<{ name: string; mimeType: string; base64: string }>;
    documents?: Array<{ name: string; mimeType: string; base64: string }>;
  }>;
  questionRequest: { id: string; questions: Question[] } | null;
  /** Temporary status override shown in the streaming spinner (e.g. "Refreshing credentials…") */
  statusOverride: string | null;
  restoringSession: boolean;
}

type AppAction =
  | { type: "SET_STATE"; state: ChatState }
  | {
      type: "SET_DEBUG_INFO";
      info: Record<string, string | number>;
      systemPrompt?: string;
      loadedInstructions?: Array<{ source: string; chars: number }>;
    }
  | { type: "ADD_USER_MESSAGE"; text: string; isSlashCommand?: boolean }
  | { type: "THINKING_START"; thinkingId: string }
  | { type: "THINKING_DELTA"; thinkingId: string; text: string }
  | { type: "THINKING_END"; thinkingId: string }
  | { type: "TEXT_DELTA"; text: string }
  | {
      type: "API_REQUEST";
      requestId: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      durationMs: number;
      timeToFirstToken: number;
    }
  | { type: "TOOL_START"; toolCallId: string; toolName: string }
  | { type: "TOOL_INPUT_DELTA"; toolCallId: string; partialJson: string }
  | {
      type: "TOOL_COMPLETE";
      toolCallId: string;
      toolName: string;
      result: string;
      durationMs: number;
      input?: unknown;
    }
  | { type: "TODO_UPDATE"; todos: TodoItem[] }
  | { type: "ADD_ANNOTATION"; text: string; badge: "follow-up" | "rejection" }
  | { type: "ERROR"; error: string; retryable: boolean }
  | { type: "DONE" }
  | { type: "NEW_SESSION" }
  | { type: "TOGGLE_THINKING" }
  | { type: "SET_MODES"; modes: ModeInfo[] }
  | { type: "SET_MODELS"; models: WebviewModelInfo[] }
  | { type: "SET_SLASH_COMMANDS"; commands: SlashCommandInfo[] }
  | {
      type: "ENQUEUE_MESSAGE";
      id: string;
      text: string;
      fullText?: string;
      isSlashCommand?: boolean;
      attachments?: string[];
      images?: Array<{ name: string; mimeType: string; base64: string }>;
      documents?: Array<{ name: string; mimeType: string; base64: string }>;
    }
  | { type: "EDIT_QUEUE_MESSAGE"; id: string; text: string }
  | { type: "REMOVE_FROM_QUEUE"; id: string }
  | { type: "CLEAR_QUEUE" }
  | { type: "ADD_INTERJECTION"; text: string }
  | { type: "SET_QUESTION"; id: string; questions: Question[] }
  | { type: "CLEAR_QUESTION" }
  | {
      type: "ADD_CONDENSE";
      prevInputTokens: number;
      newInputTokens: number;
      durationMs: number;
      validationWarnings?: string[];
    }
  | { type: "ADD_CONDENSE_ERROR"; errorMessage: string }
  | { type: "ADD_WARNING"; message: string }
  | { type: "SET_STATUS_OVERRIDE"; message: string | null }
  | { type: "SET_RESTORING_SESSION"; restoring: boolean }
  | {
      type: "LOAD_SESSION";
      sessionId: string;
      title: string;
      mode: string;
      messages: ChatMessage[];
      lastInputTokens?: number;
      lastOutputTokens?: number;
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
    }
  | { type: "SET_CHECKPOINT"; checkpointId: string; turnIndex: number }
  | { type: "CONDENSE_START" }
  | { type: "CLEAR_ERROR" }
  | {
      type: "BG_AGENT_DONE";
      sessionId: string;
      task: string;
      status: "completed" | "error" | "cancelled";
      resultText?: string;
    }
  | {
      type: "ADD_BG_QUESTION";
      bgTask: string;
      questions: string[];
      answer: string;
    };

/**
 * Convert persisted AgentMessage[] (Anthropic API format) to ChatMessage[] (webview display format).
 * Tool-result user messages are filtered out as they're internal plumbing.
 * Condense summary messages are rendered as condense rows.
 */
export function agentMessagesToChatMessages(raw: unknown[]): ChatMessage[] {
  const getSummaryText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return (content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  };

  // First pass: collect tool results keyed by tool_use_id
  const toolResults = new Map<string, string>();
  for (const msg of raw) {
    const m = msg as { role: string; content: unknown };
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const block of m.content as Array<{
        type: string;
        tool_use_id?: string;
        content?: unknown;
      }>) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const text = Array.isArray(block.content)
            ? (block.content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("\n")
            : typeof block.content === "string"
              ? block.content
              : "";
          toolResults.set(block.tool_use_id, text);
        }
      }
    }
  }

  // Second pass: build ChatMessages
  const result: ChatMessage[] = [];
  for (const msg of raw) {
    const m = msg as {
      role: string;
      content: unknown;
      isSummary?: boolean;
      runtimeError?: { message: string; retryable: boolean };
    };
    if (m.runtimeError?.message) {
      result.push({
        id: crypto.randomUUID(),
        role: "warning",
        content: "",
        timestamp: Date.now(),
        blocks: [],
        warningMessage: m.runtimeError.message,
        error: {
          message: m.runtimeError.message,
          retryable: m.runtimeError.retryable,
        },
      });
      continue;
    }
    if (m.isSummary) {
      const summaryText = getSummaryText(m.content);
      result.push({
        id: crypto.randomUUID(),
        role: "condense",
        content: "",
        timestamp: Date.now(),
        blocks: [],
        condenseInfo: {
          prevInputTokens: 0,
          newInputTokens: 0,
          errorMessage: undefined,
        },
      });
      if (summaryText) {
        result.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          blocks: [{ type: "text", text: summaryText }],
        });
      }
      continue;
    }

    if (m.role === "user") {
      if (typeof m.content === "string") {
        result.push({
          id: crypto.randomUUID(),
          role: "user",
          content: m.content,
          timestamp: Date.now(),
          blocks: [],
        });
      }
      // Skip tool_result arrays — they're internal and shouldn't be displayed
    } else if (m.role === "assistant") {
      const blocks: ContentBlock[] = [];
      const contentArr = Array.isArray(m.content) ? m.content : [];
      for (const block of contentArr as Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
        thinking?: string;
      }>) {
        if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking" && block.thinking) {
          blocks.push({
            type: "thinking",
            id: block.id ?? crypto.randomUUID(),
            text: block.thinking,
            complete: true,
          });
        } else if (block.type === "tool_use") {
          const toolId = block.id ?? crypto.randomUUID();
          blocks.push({
            type: "tool_call",
            id: toolId,
            name: block.name ?? "",
            inputJson: JSON.stringify(block.input ?? {}),
            result: toolResults.get(toolId) ?? "",
            complete: true,
          });
        }
      }
      if (blocks.length > 0) {
        result.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          blocks,
        });
      }
    }
  }
  return result;
}

/** Ensure the last message is an assistant message with blocks. */
function ensureAssistant(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") return messages;
  return [
    ...messages,
    {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [],
    },
  ];
}

/** Get the last block of a given type, or null. */
function lastBlock(blocks: ContentBlock[], type: string) {
  const last = blocks[blocks.length - 1];
  return last?.type === type ? last : null;
}

/** Clone messages array with cloned last message. */
function cloneLast(messages: ChatMessage[]): {
  msgs: ChatMessage[];
  last: ChatMessage;
} {
  const msgs = [...messages];
  const last = {
    ...msgs[msgs.length - 1],
    blocks: [...msgs[msgs.length - 1].blocks],
  };
  msgs[msgs.length - 1] = last;
  return { msgs, last };
}

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_STATE":
      return {
        ...state,
        chatState: action.state,
        streaming: action.state.streaming,
      };

    case "SET_DEBUG_INFO":
      return {
        ...state,
        debugInfo: action.info,
        systemPrompt: action.systemPrompt ?? state.systemPrompt,
        loadedInstructions:
          action.loadedInstructions ?? state.loadedInstructions,
      };

    case "ADD_USER_MESSAGE":
      return {
        ...state,
        streaming: true,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: "user",
            content: action.text,
            timestamp: Date.now(),
            blocks: [],
            isSlashCommand: action.isSlashCommand,
          },
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            timestamp: Date.now(),
            blocks: [],
          },
        ],
      };

    case "ADD_ANNOTATION":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: "user",
            content: action.text,
            badge: action.badge,
            timestamp: Date.now(),
            blocks: [],
          },
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            timestamp: Date.now(),
            blocks: [],
          },
        ],
      };

    case "ADD_BG_QUESTION": {
      const bgMsgs = [...state.messages];
      const bgLast =
        bgMsgs.length > 0 ? { ...bgMsgs[bgMsgs.length - 1] } : null;
      const bgBlock = {
        type: "bg_question" as const,
        bgTask: action.bgTask,
        questions: action.questions,
        answer: action.answer,
      };
      if (bgLast && bgLast.role === "assistant") {
        bgLast.blocks = [...(bgLast.blocks ?? []), bgBlock];
        bgMsgs[bgMsgs.length - 1] = bgLast;
        return { ...state, messages: bgMsgs };
      }
      bgMsgs.push({
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        blocks: [bgBlock],
      });
      return { ...state, messages: bgMsgs };
    }

    case "THINKING_START": {
      const all = ensureAssistant(state.messages);
      const { msgs, last } = cloneLast(all);
      last.blocks.push({
        type: "thinking",
        id: action.thinkingId,
        text: "",
        complete: false,
      });
      return { ...state, messages: msgs, statusOverride: null };
    }

    case "THINKING_DELTA": {
      const { msgs, last } = cloneLast(state.messages);
      last.blocks = last.blocks.map((b) =>
        b.type === "thinking" && b.id === action.thinkingId
          ? { ...b, text: b.text + action.text }
          : b,
      );
      return { ...state, messages: msgs };
    }

    case "THINKING_END": {
      const { msgs, last } = cloneLast(state.messages);
      last.blocks = last.blocks.map((b) =>
        b.type === "thinking" && b.id === action.thinkingId
          ? { ...b, complete: true }
          : b,
      );
      return { ...state, messages: msgs };
    }

    case "TOOL_START": {
      const all = ensureAssistant(state.messages);
      const { msgs, last } = cloneLast(all);
      last.blocks.push({
        type: "tool_call",
        id: action.toolCallId,
        name: action.toolName,
        inputJson: "",
        result: "",
        complete: false,
      });
      return { ...state, messages: msgs, statusOverride: null };
    }

    case "TOOL_INPUT_DELTA": {
      // Search backwards for the message containing this tool_call (same
      // rationale as TOOL_COMPLETE — events can push new messages).
      let tiIdx = state.messages.length - 1;
      for (; tiIdx >= 0; tiIdx--) {
        if (
          state.messages[tiIdx].blocks.some(
            (b) => b.type === "tool_call" && b.id === action.toolCallId,
          )
        ) {
          break;
        }
      }
      if (tiIdx < 0) return state;
      const tiMsgs = [...state.messages];
      const tiTarget = { ...tiMsgs[tiIdx] };
      tiTarget.blocks = tiTarget.blocks.map((b) =>
        b.type === "tool_call" && b.id === action.toolCallId
          ? { ...b, inputJson: b.inputJson + action.partialJson }
          : b,
      );
      tiMsgs[tiIdx] = tiTarget;
      return { ...state, messages: tiMsgs };
    }

    case "TOOL_COMPLETE": {
      // Search ALL messages for the matching tool_call — not just the last one.
      // Events like ADD_ANNOTATION, ADD_INTERJECTION, BG_AGENT_DONE, or ADD_CONDENSE
      // can push new messages between TOOL_START and TOOL_COMPLETE, leaving the
      // tool_call block in an earlier message. This is especially common with
      // long-running tools like get_background_result.
      let targetIdx = -1;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (
          state.messages[i].blocks.some(
            (b) => b.type === "tool_call" && b.id === action.toolCallId,
          )
        ) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx === -1) return state; // tool_call not found — no-op

      const msgs = [...state.messages];
      const target = { ...msgs[targetIdx] };
      target.blocks = target.blocks.map((b) =>
        b.type === "tool_call" && b.id === action.toolCallId
          ? {
              ...b,
              inputJson:
                b.inputJson !== "" || action.input === undefined
                  ? b.inputJson
                  : JSON.stringify(action.input),
              result: action.result,
              complete: true,
              durationMs: action.durationMs,
            }
          : b,
      );
      msgs[targetIdx] = target;

      // When ask_user completes, add a question_answer summary block
      if (action.toolName === "ask_user") {
        try {
          const parsed = JSON.parse(action.result);
          if (parsed.responses && Array.isArray(parsed.responses)) {
            const items = parsed.responses.map(
              (r: { question: string; answer: unknown; note?: string }) => ({
                question: r.question ?? "",
                answer: r.answer ?? null,
                ...(r.note ? { note: r.note } : {}),
              }),
            );
            if (items.length > 0) {
              target.blocks = [
                ...target.blocks,
                { type: "question_answer" as const, items },
              ];
              msgs[targetIdx] = target;
            }
          }
        } catch {
          // ignore parse error
        }
      }

      // When spawn_background_agent completes, add a bg_agent block to track progress
      if (action.toolName === "spawn_background_agent") {
        try {
          const parsed = JSON.parse(action.result);
          if (parsed.sessionId) {
            // Extract task and message from the tool_call input
            const toolBlock = target.blocks.find(
              (b) => b.type === "tool_call" && b.id === action.toolCallId,
            );
            let task = "Background Agent";
            let message: string | undefined;

            const finalInput =
              action.input &&
              typeof action.input === "object" &&
              !Array.isArray(action.input)
                ? action.input
                : null;
            if (finalInput) {
              const input = finalInput as { task?: unknown; message?: unknown };
              if (typeof input.task === "string" && input.task)
                task = input.task;
              if (typeof input.message === "string" && input.message) {
                message = input.message;
              }
            }

            if (toolBlock && toolBlock.type === "tool_call") {
              try {
                const input = JSON.parse(toolBlock.inputJson) as {
                  task?: unknown;
                  message?: unknown;
                };
                if (
                  task === "Background Agent" &&
                  typeof input.task === "string" &&
                  input.task
                ) {
                  task = input.task;
                }
                if (
                  !message &&
                  typeof input.message === "string" &&
                  input.message
                ) {
                  message = input.message;
                }
              } catch {
                // ignore parse error
              }
            }
            target.blocks = [
              ...target.blocks,
              {
                type: "bg_agent",
                sessionId: parsed.sessionId,
                task,
                message,
                resolvedModel: parsed.resolvedModel,
                resolvedProvider: parsed.resolvedProvider,
                resolvedMode: parsed.resolvedMode,
                taskClass: parsed.taskClass,
                routingReason: parsed.routingReason,
              },
            ];
            msgs[targetIdx] = target;
          }
        } catch {
          // ignore parse error
        }
      }
      return { ...state, messages: msgs };
    }

    case "TEXT_DELTA": {
      const all = ensureAssistant(state.messages);
      const { msgs, last } = cloneLast(all);
      // Append to existing text block or start a new one.
      // Each Claude API turn naturally produces interleaved text+tool blocks:
      //   [text: "Let me do X:"] → [tool_call] → [text: "Follow-up:"] → ...
      // The colon at the end of pre-tool text is Claude's natural lead-in style.
      const tail = lastBlock(last.blocks, "text");
      if (tail && tail.type === "text") {
        last.blocks[last.blocks.length - 1] = {
          ...tail,
          text: tail.text + action.text,
        };
      } else {
        last.blocks.push({ type: "text", text: action.text });
      }
      return { ...state, messages: msgs };
    }

    case "API_REQUEST": {
      if (state.messages.length === 0) return state;
      const { msgs, last } = cloneLast(state.messages);
      last.apiRequest = {
        requestId: action.requestId,
        model: action.model,
        inputTokens: action.inputTokens,
        outputTokens: action.outputTokens,
        durationMs: action.durationMs,
        timeToFirstToken: action.timeToFirstToken,
      };
      return {
        ...state,
        messages: msgs,
        lastInputTokens: action.inputTokens,
        lastOutputTokens: action.outputTokens,
        lastCacheReadTokens: action.cacheReadTokens,
      };
    }

    case "TODO_UPDATE":
      return {
        ...state,
        todos: Array.isArray(action.todos) ? action.todos : [],
      };

    case "ERROR": {
      const all = ensureAssistant(state.messages);
      const { msgs, last } = cloneLast(all);
      last.error = { message: action.error, retryable: action.retryable };
      return {
        ...state,
        streaming: false,
        messages: msgs,
        statusOverride: null,
      };
    }

    case "CLEAR_ERROR": {
      // Remove the error from the last message and set streaming=true for retry
      if (state.messages.length === 0) return state;
      const all2 = [...state.messages];
      const lastMsg2 = { ...all2[all2.length - 1] };
      delete lastMsg2.error;
      all2[all2.length - 1] = lastMsg2;
      return { ...state, messages: all2, streaming: true };
    }

    case "DONE": {
      // Mark any incomplete tool calls / thinking blocks as complete so
      // their spinners stop when the user clicks Stop.
      const doneMessages = state.messages.map((m) => {
        const hasIncomplete = m.blocks.some(
          (b) =>
            (b.type === "tool_call" && !b.complete) ||
            (b.type === "thinking" && !b.complete),
        );
        if (!hasIncomplete) return m;
        return {
          ...m,
          blocks: m.blocks.map((b) => {
            if (b.type === "tool_call" && !b.complete) {
              return {
                ...b,
                complete: true,
                result: b.result || '{"status":"stopped"}',
              };
            }
            if (b.type === "thinking" && !b.complete) {
              return { ...b, complete: true };
            }
            return b;
          }),
        };
      });

      // Mark any in_progress todos as pending so their spinners stop
      const stopTodos = (items: TodoItem[]): TodoItem[] =>
        items.map((t) => ({
          ...t,
          status: t.status === "in_progress" ? "pending" : t.status,
          children: t.children ? stopTodos(t.children) : t.children,
        }));

      // Remove the empty assistant placeholder added after condensing if the
      // agent ended before producing any content (e.g. manual /condense).
      const last = doneMessages[doneMessages.length - 1];
      const secondToLast = doneMessages[doneMessages.length - 2];
      const finalMessages =
        last?.role === "assistant" &&
        last.blocks.length === 0 &&
        !last.error &&
        secondToLast?.role === "condense"
          ? doneMessages.slice(0, -1)
          : doneMessages;

      return {
        ...state,
        streaming: false,
        messages: finalMessages,
        todos: stopTodos(state.todos),
        statusOverride: null,
      };
    }

    case "NEW_SESSION":
      return {
        ...state,
        messages: [],
        streaming: false,
        lastInputTokens: 0,
        lastOutputTokens: 0,
        lastCacheReadTokens: 0,
        todos: [],
        messageQueue: [],
        questionRequest: null,
        statusOverride: null,
      };

    case "TOGGLE_THINKING":
      return { ...state, thinkingEnabled: !state.thinkingEnabled };

    case "SET_MODES":
      return {
        ...state,
        modes: Array.isArray(action.modes) ? action.modes : state.modes,
      };

    case "SET_MODELS":
      return {
        ...state,
        availableModels: Array.isArray(action.models)
          ? action.models
          : state.availableModels,
      };

    case "SET_SLASH_COMMANDS":
      return {
        ...state,
        slashCommands: Array.isArray(action.commands)
          ? action.commands
          : state.slashCommands,
      };

    case "ENQUEUE_MESSAGE":
      return {
        ...state,
        messageQueue: [
          ...state.messageQueue,
          {
            id: action.id,
            text: action.text,
            ...(action.fullText ? { fullText: action.fullText } : {}),
            ...(action.isSlashCommand ? { isSlashCommand: true } : {}),
            ...(action.attachments ? { attachments: action.attachments } : {}),
            ...(action.images ? { images: action.images } : {}),
            ...(action.documents ? { documents: action.documents } : {}),
          },
        ],
      };

    case "EDIT_QUEUE_MESSAGE":
      return {
        ...state,
        messageQueue: state.messageQueue.map((q) =>
          q.id === action.id
            ? {
                ...q,
                text: action.text,
                fullText: action.text,
                isSlashCommand: false,
              }
            : q,
        ),
      };

    case "REMOVE_FROM_QUEUE":
      return {
        ...state,
        messageQueue: state.messageQueue.filter((q) => q.id !== action.id),
      };

    case "CLEAR_QUEUE":
      return { ...state, messageQueue: [] };

    case "ADD_INTERJECTION":
      // Insert user interjection bubble mid-run without resetting streaming state
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: "user" as const,
            content: action.text,
            timestamp: Date.now(),
            blocks: [],
          },
          {
            id: crypto.randomUUID(),
            role: "assistant" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
          },
        ],
      };

    case "SET_QUESTION":
      return {
        ...state,
        questionRequest: { id: action.id, questions: action.questions },
      };

    case "CLEAR_QUESTION":
      return { ...state, questionRequest: null };

    case "CONDENSE_START": {
      // Add a pending condense row — replaced with final stats when complete.
      // Set streaming: true so the input area queues messages during condense
      // (prevents racing with message history changes).
      const tail = state.messages[state.messages.length - 1];
      const base =
        tail?.role === "assistant" && tail.blocks.length === 0 && !tail.error
          ? state.messages.slice(0, -1)
          : state.messages;
      return {
        ...state,
        streaming: true,
        messages: [
          ...base,
          {
            id: crypto.randomUUID(),
            role: "condense" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
            condenseInfo: {
              prevInputTokens: 0,
              newInputTokens: 0,
              condensing: true,
            },
          },
        ],
      };
    }

    case "ADD_CONDENSE": {
      // Remove any trailing empty assistant placeholder (added optimistically by ADD_USER_MESSAGE)
      // Also remove the pending condense row (condensing: true) if present
      const filtered = state.messages.filter(
        (m) => !(m.role === "condense" && m.condenseInfo?.condensing),
      );
      return {
        ...state,
        messages: [
          ...filtered,
          {
            id: crypto.randomUUID(),
            role: "condense" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
            condenseInfo: {
              prevInputTokens: action.prevInputTokens,
              newInputTokens: action.newInputTokens,
              durationMs: action.durationMs,
              validationWarnings: action.validationWarnings,
            },
          },
          // Add an empty assistant placeholder so the streaming dots appear
          // immediately after condensing while waiting for the next API response.
          // DONE strips this if the agent ends without producing any content.
          {
            id: crypto.randomUUID(),
            role: "assistant" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
          },
        ],
        lastInputTokens: action.newInputTokens,
        lastOutputTokens: 0,
        lastCacheReadTokens: 0,
      };
    }

    case "ADD_WARNING": {
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: "warning" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
            warningMessage: action.message,
          },
        ],
      };
    }

    case "SET_STATUS_OVERRIDE": {
      return { ...state, statusOverride: action.message };
    }

    case "SET_RESTORING_SESSION": {
      return { ...state, restoringSession: action.restoring };
    }

    case "ADD_CONDENSE_ERROR": {
      const filtered = state.messages.filter(
        (m) => !(m.role === "condense" && m.condenseInfo?.condensing),
      );
      return {
        ...state,
        messages: [
          ...filtered,
          {
            id: crypto.randomUUID(),
            role: "condense" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
            condenseInfo: {
              prevInputTokens: 0,
              newInputTokens: 0,
              errorMessage: action.errorMessage,
            },
          },
        ],
      };
    }

    case "LOAD_SESSION": {
      // Apply checkpoint IDs to user messages if provided
      let msgs = action.messages;
      if (action.checkpoints && action.checkpoints.length > 0) {
        msgs = [...msgs];
        for (const cp of action.checkpoints) {
          let userCount = 0;
          for (let i = 0; i < msgs.length; i++) {
            if (msgs[i].role === "user") {
              if (userCount === cp.turnIndex) {
                msgs[i] = { ...msgs[i], checkpointId: cp.checkpointId };
                break;
              }
              userCount++;
            }
          }
        }
      }
      return {
        ...state,
        messages: msgs,
        streaming: false,
        restoringSession: false,
        lastInputTokens: action.lastInputTokens ?? 0,
        lastOutputTokens: action.lastOutputTokens ?? 0,
        todos: [],
        messageQueue: [],
        questionRequest: null,
        chatState: {
          ...state.chatState,
          sessionId: action.sessionId,
          mode: action.mode,
          streaming: false,
        },
      };
    }

    case "BG_AGENT_DONE": {
      // Insert a bg_agent_result notification at the current position in chat.
      // If the last message is an assistant message, append the block to it.
      // Otherwise, create a new assistant message for the notification.
      const resultBlock: ContentBlock = {
        type: "bg_agent_result",
        sessionId: action.sessionId,
        task: action.task,
        status: action.status,
        resultText: action.resultText,
      };
      const lastMsg = state.messages[state.messages.length - 1];
      if (lastMsg?.role === "assistant") {
        const { msgs, last } = cloneLast(state.messages);
        last.blocks = [...last.blocks, resultBlock];
        return { ...state, messages: msgs };
      }
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [resultBlock],
          },
        ],
      };
    }

    case "SET_CHECKPOINT": {
      // Attach checkpointId to the most recent user message (turnIndex = its position)
      const msgs = [...state.messages];
      // Find the user message at the given turnIndex (0-based index into user messages)
      let userCount = 0;
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].role === "user") {
          if (userCount === action.turnIndex) {
            msgs[i] = { ...msgs[i], checkpointId: action.checkpointId };
            break;
          }
          userCount++;
        }
      }
      return { ...state, messages: msgs };
    }

    default:
      return state;
  }
}

export const initialState: AppState = {
  messages: [],
  chatState: {
    sessionId: null,
    mode: "code",
    model: "claude-sonnet-4-6",
    streaming: false,
  },
  streaming: false,
  thinkingEnabled: true,
  lastInputTokens: 0,
  lastOutputTokens: 0,
  lastCacheReadTokens: 0,
  debugInfo: null,
  systemPrompt: null,
  loadedInstructions: null,
  todos: [],
  modes: [
    { slug: "code", name: "Code", icon: "code" },
    { slug: "architect", name: "Architect", icon: "organization" },
    { slug: "ask", name: "Ask", icon: "question" },
    { slug: "debug", name: "Debug", icon: "debug" },
    { slug: "review", name: "Review", icon: "checklist" },
  ],
  availableModels: [],
  slashCommands: [],
  messageQueue: [],
  questionRequest: null,
  statusOverride: null,
  restoringSession: false,
};

export interface Injection {
  type: "prompt" | "attachment" | "context";
  prompt?: string;
  attachments?: string[];
  autoSubmit?: boolean;
  path?: string;
  context?: string;
}

export function App({ vscodeApi }: { vscodeApi: VsCodeApi }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state.chatState);
  stateRef.current = state.chatState;
  const startupRestorePendingRef = useRef(true);
  const messageQueueRef = useRef(state.messageQueue);
  messageQueueRef.current = state.messageQueue;
  const thinkingEnabledRef = useRef(state.thinkingEnabled);
  thinkingEnabledRef.current = state.thinkingEnabled;
  // Guards against stale delta events arriving after agentDone (stop race condition).
  // Set true when a turn starts, false when agentDone fires.
  const streamingRef = useRef(false);
  // Buffers for coalescing streaming deltas — flushed once per animation frame.
  const textDeltaBuf = useRef("");
  const thinkingDeltaBuf = useRef(new Map<string, string>());
  const toolInputDeltaBuf = useRef(new Map<string, string>());
  const deltaRafRef = useRef<number | null>(null);
  const [injection, setInjection] = useState<Injection | null>(null);
  const [shiftDragOver, setShiftDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const [mcpStatusInfos, setMcpStatusInfos] = useState<Array<{
    name: string;
    status: string;
    error?: string;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
  }> | null>(null);
  const [elicitation, setElicitation] = useState<{
    id: string;
    serverName: string;
    message: string;
    fields: Record<
      string,
      {
        type: "string" | "number" | "boolean";
        title?: string;
        description?: string;
        enum?: string[];
        default?: unknown;
        minimum?: number;
        maximum?: number;
      }
    >;
    required: string[];
  } | null>(null);
  const [sessionHistory, setSessionHistory] = useState<SessionSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [forwardedApproval, setForwardedApproval] =
    useState<ApprovalRequest | null>(null);
  const forwardedFollowUpRef = useRef("");
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState("");
  const [bgSessions, setBgSessions] = useState<BgSessionInfoProps[]>([]);
  const [expandedQueueIds, setExpandedQueueIds] = useState<Set<string>>(
    new Set(),
  );
  const [transcriptView, setTranscriptView] = useState<{
    task: string;
    messages: ChatMessage[];
  } | null>(null);
  const [btwState, setBtwState] = useState<BtwState | null>(null);

  useEffect(() => {
    // Drain all delta buffers, dispatching one action per buffer.
    // React 18 batches these synchronous dispatches into a single render.
    const drainDeltaBuffers = () => {
      if (textDeltaBuf.current) {
        dispatch({ type: "TEXT_DELTA", text: textDeltaBuf.current });
        textDeltaBuf.current = "";
      }
      for (const [thinkingId, text] of thinkingDeltaBuf.current) {
        dispatch({ type: "THINKING_DELTA", thinkingId, text });
      }
      thinkingDeltaBuf.current.clear();
      for (const [toolCallId, partialJson] of toolInputDeltaBuf.current) {
        dispatch({ type: "TOOL_INPUT_DELTA", toolCallId, partialJson });
      }
      toolInputDeltaBuf.current.clear();
    };
    const scheduleDeltaFlush = () => {
      if (deltaRafRef.current !== null) return;
      deltaRafRef.current = requestAnimationFrame(() => {
        deltaRafRef.current = null;
        drainDeltaBuffers();
      });
    };
    const flushDeltasNow = () => {
      if (deltaRafRef.current !== null) {
        cancelAnimationFrame(deltaRafRef.current);
        deltaRafRef.current = null;
      }
      drainDeltaBuffers();
    };

    const handler = (e: MessageEvent) => {
      const msg = e.data as ExtensionMessage;

      const currentSessionId = stateRef.current.sessionId;
      const eventSessionId =
        "sessionId" in msg
          ? (msg as { sessionId: string }).sessionId
          : undefined;
      const isBackgroundEvent =
        msg.type === "agentBgThinkingStart" ||
        msg.type === "agentBgThinkingDelta" ||
        msg.type === "agentBgThinkingEnd" ||
        msg.type === "agentBgTextDelta" ||
        msg.type === "agentBgToolStart" ||
        msg.type === "agentBgToolComplete" ||
        msg.type === "agentBgApiRequest" ||
        msg.type === "agentBgError" ||
        msg.type === "agentBgDone";

      const reportDrop = (
        reason: "session_mismatch" | "streaming_false",
      ): void => {
        vscodeApi.postMessage({
          command: "agentStreamDrop",
          reason,
          eventType: msg.type,
          eventSessionId: eventSessionId ?? null,
          currentSessionId: stateRef.current.sessionId,
          streaming: streamingRef.current,
        });
      };

      // Filter session-scoped foreground events from non-foreground sessions.
      // agentSessionLoaded is excluded — it intentionally switches the active session.
      // showBgTranscript is excluded — it carries the bg session's ID but is a
      // response to a user-initiated action, not a stream event.
      if (
        eventSessionId &&
        msg.type !== "agentSessionLoaded" &&
        msg.type !== "showBgTranscript" &&
        !isBackgroundEvent &&
        eventSessionId !== currentSessionId
      ) {
        console.debug(
          `[agentlink-webview] dropping ${msg.type}: session mismatch (event=${eventSessionId}, current=${currentSessionId ?? "null"})`,
        );
        reportDrop("session_mismatch");
        return;
      }

      const dropIfNotStreaming = () => {
        if (streamingRef.current) return false;
        console.debug(
          `[agentlink-webview] dropping ${msg.type}: streamingRef=false (eventSession=${eventSessionId ?? "none"}, current=${stateRef.current.sessionId ?? "null"})`,
        );
        reportDrop("streaming_false");
        return true;
      };

      switch (msg.type) {
        case "stateUpdate":
          streamingRef.current = Boolean(msg.state.streaming);
          dispatch({ type: "SET_STATE", state: msg.state });
          break;
        case "agentRestoreSessionStart":
          dispatch({ type: "SET_RESTORING_SESSION", restoring: true });
          break;
        case "agentRestoreSessionDone":
          startupRestorePendingRef.current = false;
          dispatch({ type: "SET_RESTORING_SESSION", restoring: false });
          break;
        case "agentThinkingStart":
          if (dropIfNotStreaming()) break;
          dispatch({ type: "THINKING_START", thinkingId: msg.thinkingId });
          break;
        case "agentThinkingDelta":
          if (dropIfNotStreaming()) break;
          thinkingDeltaBuf.current.set(
            msg.thinkingId,
            (thinkingDeltaBuf.current.get(msg.thinkingId) ?? "") + msg.text,
          );
          scheduleDeltaFlush();
          break;
        case "agentThinkingEnd":
          if (dropIfNotStreaming()) break;
          // Flush buffered thinking deltas so content arrives before the block
          // is marked complete (same pattern as agentToolComplete).
          flushDeltasNow();
          dispatch({ type: "THINKING_END", thinkingId: msg.thinkingId });
          break;
        case "agentToolStart":
          if (dropIfNotStreaming()) break;
          // Flush any buffered text deltas first so pre-tool text lands in its
          // own block before the tool_call block is inserted.
          flushDeltasNow();
          dispatch({
            type: "TOOL_START",
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
          });
          break;
        case "agentToolInputDelta":
          if (dropIfNotStreaming()) break;
          toolInputDeltaBuf.current.set(
            msg.toolCallId,
            (toolInputDeltaBuf.current.get(msg.toolCallId) ?? "") +
              msg.partialJson,
          );
          scheduleDeltaFlush();
          break;
        case "agentToolComplete":
          if (dropIfNotStreaming()) break;
          // Flush any buffered input deltas before marking complete,
          // otherwise the input JSON may be empty/partial when the
          // tool block switches to its "complete" state.
          flushDeltasNow();
          dispatch({
            type: "TOOL_COMPLETE",
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            result: msg.result,
            durationMs: msg.durationMs,
            input: msg.input,
          });
          break;
        case "agentUserAnnotation":
          if (dropIfNotStreaming()) break;
          dispatch({
            type: "ADD_ANNOTATION",
            text: msg.text,
            badge: msg.badge,
          });
          break;
        case "agentTextDelta":
          if (dropIfNotStreaming()) break;
          textDeltaBuf.current += msg.text;
          scheduleDeltaFlush();
          break;
        case "agentApiRequest":
          if (dropIfNotStreaming()) break;
          dispatch({
            type: "API_REQUEST",
            requestId: msg.requestId,
            model: msg.model,
            inputTokens: msg.inputTokens,
            outputTokens: msg.outputTokens,
            cacheReadTokens: msg.cacheReadTokens,
            durationMs: msg.durationMs,
            timeToFirstToken: msg.timeToFirstToken,
          });
          break;
        case "agentError":
          flushDeltasNow();
          streamingRef.current = false;
          dispatch({
            type: "ERROR",
            error: msg.error,
            retryable: msg.retryable,
          });
          break;
        case "agentTodoUpdate":
          dispatch({ type: "TODO_UPDATE", todos: msg.todos });
          break;
        case "agentDone": {
          flushDeltasNow();
          streamingRef.current = false;
          dispatch({ type: "DONE" });
          dispatch({ type: "CLEAR_QUESTION" });
          const queue = messageQueueRef.current;
          if (queue.length > 0) {
            // Display text for the chat UI (shows slash command names and media indicators)
            const displayCombined = queue.map((q) => q.text).join("\n\n");
            // Full text for the agent (expanded slash command bodies)
            const sendCombined = queue
              .map((q) => q.fullText ?? q.text)
              .join("\n\n");
            const attachmentsCombined = queue.flatMap(
              (q) => q.attachments ?? [],
            );
            const imagesCombined = queue.flatMap((q) => q.images ?? []);
            const documentsCombined = queue.flatMap((q) => q.documents ?? []);
            messageQueueRef.current = [];
            dispatch({ type: "CLEAR_QUEUE" });
            setTimeout(() => {
              streamingRef.current = true;
              dispatch({
                type: "ADD_USER_MESSAGE",
                text: displayCombined,
              });
              vscodeApi.postMessage({
                command: "agentSend",
                text: sendCombined,
                attachments:
                  attachmentsCombined.length > 0
                    ? attachmentsCombined
                    : undefined,
                images: imagesCombined.length > 0 ? imagesCombined : undefined,
                documents:
                  documentsCombined.length > 0 ? documentsCombined : undefined,
                sessionId: stateRef.current.sessionId,
                mode: stateRef.current.mode,
                thinkingEnabled: thinkingEnabledRef.current,
              });
            }, 0);
          }
          break;
        }
        case "agentDebugInfo":
          dispatch({
            type: "SET_DEBUG_INFO",
            info: msg.info,
            systemPrompt: msg.systemPrompt,
            loadedInstructions: msg.loadedInstructions,
          });
          break;
        case "agentInjectPrompt":
          setInjection({
            type: "prompt",
            prompt: msg.prompt,
            attachments: msg.attachments,
            autoSubmit: msg.autoSubmit,
          });
          break;
        case "agentInjectAttachment":
          setInjection({ type: "attachment", path: msg.path });
          break;
        case "agentInjectContext":
          setInjection({ type: "context", context: msg.context });
          break;
        case "agentModesUpdate":
          dispatch({ type: "SET_MODES", modes: msg.modes });
          break;
        case "agentModelsUpdate":
          dispatch({ type: "SET_MODELS", models: msg.models });
          break;
        case "agentSlashCommandsUpdate":
          dispatch({ type: "SET_SLASH_COMMANDS", commands: msg.commands });
          break;
        case "agentModeSwitchRequest":
          // Agent requested a mode switch — create a new session in the new mode
          // but do NOT clear the current chat history (it stays visible while the
          // new session is being created; the next stateUpdate will set the new sessionId)
          vscodeApi.postMessage({ command: "agentNewSession", mode: msg.mode });
          break;
        case "agentElicitationRequest":
          setElicitation({
            id: msg.id,
            serverName: msg.serverName,
            message: msg.message,
            fields: msg.fields,
            required: msg.required,
          });
          break;
        case "agentMcpStatus":
          if (msg.open) {
            // /mcp-status command — always open the panel
            setMcpStatusInfos(msg.infos);
          } else {
            // live update from onStatusChange — only refresh if already open
            setMcpStatusInfos((prev) => (prev !== null ? msg.infos : prev));
          }
          break;
        case "showApproval":
          setForwardedApproval(msg.request as ApprovalRequest);
          break;
        case "idle":
          setForwardedApproval(null);
          break;

        case "agentCondense":
          dispatch({
            type: "ADD_CONDENSE",
            prevInputTokens: msg.prevInputTokens,
            newInputTokens: msg.newInputTokens,
            durationMs: msg.durationMs,
            validationWarnings: msg.validationWarnings,
          });
          break;

        case "agentCondenseStart":
          dispatch({ type: "CONDENSE_START" });
          break;

        case "agentWarning":
          dispatch({
            type: "ADD_WARNING",
            message: msg.message,
          });
          break;

        case "agentStatusUpdate":
          dispatch({
            type: "SET_STATUS_OVERRIDE",
            message: msg.message,
          });
          break;

        case "agentCondenseError":
          dispatch({
            type: "ADD_CONDENSE_ERROR",
            errorMessage: msg.error,
          });
          break;

        case "agentQuestionRequest":
          dispatch({
            type: "SET_QUESTION",
            id: msg.id,
            questions: msg.questions,
          });
          break;

        case "agentSessionList":
          setSessionHistory(msg.sessions);
          break;

        case "agentSessionLoaded":
          if (msg.restored && !startupRestorePendingRef.current) {
            break;
          }
          startupRestorePendingRef.current = false;
          dispatch({
            type: "LOAD_SESSION",
            sessionId: msg.sessionId,
            title: msg.title,
            mode: msg.mode,
            messages: agentMessagesToChatMessages(msg.messages as unknown[]),
            lastInputTokens: msg.lastInputTokens,
            lastOutputTokens: msg.lastOutputTokens,
            checkpoints: msg.checkpoints,
          });
          setShowHistory(false);
          break;

        case "agentCheckpointCreated":
          dispatch({
            type: "SET_CHECKPOINT",
            checkpointId: msg.checkpointId,
            turnIndex: msg.turnIndex,
          });
          break;

        case "agentInterjection":
          // User message injected mid-run between tool batches
          dispatch({
            type: "ADD_INTERJECTION",
            text: (msg.displayText as string | undefined) ?? msg.text,
          });
          dispatch({ type: "REMOVE_FROM_QUEUE", id: msg.queueId });
          messageQueueRef.current = messageQueueRef.current.filter(
            (q) => q.id !== msg.queueId,
          );
          break;

        case "agentBgSessionsUpdate":
          setBgSessions(msg.sessions as BgSessionInfoProps[]);
          break;

        // Background-only stream events are intentionally not rendered into the
        // foreground transcript. They only trigger bg session UI refresh.
        case "agentBgThinkingStart":
        case "agentBgThinkingDelta":
        case "agentBgThinkingEnd":
        case "agentBgTextDelta":
        case "agentBgToolStart":
        case "agentBgToolComplete":
        case "agentBgApiRequest":
        case "agentBgError":
          // Bg status updates are sent separately (and throttled) by the extension.
          break;
        case "agentBgDone": {
          // Insert a completion notification at the current chat position
          const bgSessionId = msg.sessionId;
          // Find the task name from existing bg_agent blocks in messages
          let bgTask = "Background Agent";
          for (const m of state.messages) {
            for (const b of m.blocks) {
              if (b.type === "bg_agent" && b.sessionId === bgSessionId) {
                bgTask = b.task;
                break;
              }
            }
          }
          // Determine status from bgSessions state
          const bgInfo = bgSessions.find((s) => s.id === bgSessionId);
          const bgStatus: "completed" | "error" | "cancelled" =
            bgInfo?.status === "error"
              ? "error"
              : bgInfo?.status === "cancelled"
                ? "cancelled"
                : "completed";
          dispatch({
            type: "BG_AGENT_DONE",
            sessionId: bgSessionId,
            task: bgTask,
            status: bgStatus,
            resultText:
              (msg.resultText as string | undefined) ?? bgInfo?.resultText,
          });
          break;
        }

        case "agentBgQuestion": {
          dispatch({
            type: "ADD_BG_QUESTION",
            bgTask: msg.bgTask,
            questions: msg.questions,
            answer: msg.answer,
          });
          break;
        }

        case "agentBtwLoading":
          setBtwState({
            requestId: msg.requestId,
            question: msg.question,
            answer: "",
          });
          break;

        case "agentBtwResponse":
          setBtwState((prev) => {
            // Discard stale responses
            if (!prev || prev.requestId !== msg.requestId) return prev;
            return {
              ...prev,
              answer: msg.answer,
              error: msg.error,
            };
          });
          break;

        case "showBgTranscript": {
          const converted = agentMessagesToChatMessages(
            (msg.messages as unknown[]) ?? [],
          );
          setTranscriptView({ task: msg.task as string, messages: converted });
          break;
        }
      }
    };

    window.addEventListener("message", handler);

    // Tell extension we're ready
    vscodeApi.postMessage({ command: "webviewReady" });

    return () => {
      window.removeEventListener("message", handler);
      if (deltaRafRef.current !== null)
        cancelAnimationFrame(deltaRafRef.current);
    };
  }, [vscodeApi]);

  const handleSend = useCallback(
    (
      text: string,
      attachments: string[] = [],
      displayText?: string,
      media?: Array<{
        name: string;
        mimeType: string;
        base64: string;
        kind: "image" | "document";
      }>,
    ) => {
      // Build message text: prepend attached file references
      let fullText = text;
      if (attachments.length > 0) {
        const fileRefs = attachments.map((p) => `[Attached: ${p}]`).join("\n");
        fullText = fileRefs + "\n\n" + text;
      }

      // Split media into images and documents for the extension
      const images =
        media
          ?.filter((m) => m.kind === "image")
          .map((m) => ({
            name: m.name,
            mimeType: m.mimeType,
            base64: m.base64,
          })) ?? [];
      const documents =
        media
          ?.filter((m) => m.kind === "document")
          .map((m) => ({
            name: m.name,
            mimeType: m.mimeType,
            base64: m.base64,
          })) ?? [];

      // Build display text with media indicators
      let displayWithMedia = displayText ?? fullText;
      if (images.length > 0 || documents.length > 0) {
        const indicators: string[] = [];
        if (images.length > 0)
          indicators.push(
            `${images.length} image${images.length > 1 ? "s" : ""}`,
          );
        if (documents.length > 0)
          indicators.push(
            `${documents.length} PDF${documents.length > 1 ? "s" : ""}`,
          );
        displayWithMedia =
          `[${indicators.join(", ")} attached]\n` + displayWithMedia;
      }

      // While streaming, enqueue the message instead of sending immediately.
      if (state.streaming) {
        const queueId = crypto.randomUUID();
        dispatch({
          type: "ENQUEUE_MESSAGE",
          id: queueId,
          text: displayWithMedia,
          // Preserve the clean payload text whenever the display form differs
          // (e.g. slash commands or media indicators) so queue drain sends the
          // actual agent input rather than UI-only decoration.
          fullText: displayWithMedia !== fullText ? fullText : undefined,
          isSlashCommand: displayText !== undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
          images: images.length > 0 ? images : undefined,
          documents: documents.length > 0 ? documents : undefined,
        });
        // Notify extension about this queued item so it can inject it ASAP
        // between tool batches. Only the first pending item will be used.
        vscodeApi.postMessage({
          command: "agentQueueMessage",
          text: fullText,
          displayText: displayWithMedia,
          queueId,
          sessionId: stateRef.current.sessionId,
          attachments: attachments.length > 0 ? attachments : undefined,
          images: images.length > 0 ? images : undefined,
          documents: documents.length > 0 ? documents : undefined,
        });
        return;
      }

      // displayText is shown in the chat UI; fullText is sent to the agent
      streamingRef.current = true;
      dispatch({
        type: "ADD_USER_MESSAGE",
        text: displayWithMedia,
        isSlashCommand: displayText !== undefined,
      });
      vscodeApi.postMessage({
        command: "agentSend",
        text: fullText,
        attachments,
        images: images.length > 0 ? images : undefined,
        documents: documents.length > 0 ? documents : undefined,
        sessionId: stateRef.current.sessionId,
        mode: stateRef.current.mode,
        thinkingEnabled: thinkingEnabledRef.current,
      });
    },
    [vscodeApi, state.streaming, state.thinkingEnabled],
  );

  const handleStop = useCallback(() => {
    if (stateRef.current.sessionId) {
      vscodeApi.postMessage({
        command: "agentStop",
        sessionId: stateRef.current.sessionId,
      });
    }
  }, [vscodeApi]);

  const handleStopBackground = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "agentStop", sessionId });
    },
    [vscodeApi],
  );

  const handleOpenBgTranscript = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "openBgTranscript", sessionId });
    },
    [vscodeApi],
  );

  const handleNewSession = useCallback(() => {
    startupRestorePendingRef.current = false;
    dispatch({ type: "SET_RESTORING_SESSION", restoring: false });
    dispatch({ type: "NEW_SESSION" });
    setBgSessions([]);
    vscodeApi.postMessage({
      command: "agentNewSession",
      mode: stateRef.current.mode,
    });
  }, [vscodeApi]);

  const handleSwitchMode = useCallback(
    (slug: string) => {
      // If there's an active session, switch mode in-place without creating
      // a new session. Otherwise create a fresh session in the target mode.
      if (stateRef.current.sessionId) {
        startupRestorePendingRef.current = false;
        dispatch({ type: "SET_RESTORING_SESSION", restoring: false });
        vscodeApi.postMessage({ command: "agentSwitchMode", mode: slug });
      } else {
        startupRestorePendingRef.current = false;
        dispatch({ type: "SET_RESTORING_SESSION", restoring: false });
        dispatch({ type: "NEW_SESSION" });
        setBgSessions([]);
        vscodeApi.postMessage({ command: "agentNewSession", mode: slug });
      }
    },
    [vscodeApi],
  );

  const handleSelectModel = useCallback(
    (modelId: string) => {
      vscodeApi.postMessage({
        command: "agentSetModel",
        model: modelId,
      });
    },
    [vscodeApi],
  );

  const handleSetCondenseThreshold = useCallback(
    (threshold: number) => {
      vscodeApi.postMessage({
        command: "agentSetCondenseThreshold",
        threshold,
      });
    },
    [vscodeApi],
  );

  const handleSignIn = useCallback(
    (provider: string) => {
      if (
        provider.toLowerCase() === "codex" ||
        provider.toLowerCase() === "openai"
      ) {
        vscodeApi.postMessage({ command: "agentCodexSignIn" });
      } else if (provider.toLowerCase() === "anthropic") {
        vscodeApi.postMessage({ command: "agentAnthropicSignIn" });
      }
    },
    [vscodeApi],
  );

  const handleSetAgentWriteApproval = useCallback(
    (mode: string) => {
      vscodeApi.postMessage({
        command: "agentSetWriteApproval",
        mode,
      });
    },
    [vscodeApi],
  );

  const handleExecuteBuiltinCommand = useCallback(
    (name: string, args: string) => {
      switch (name) {
        case "new":
          startupRestorePendingRef.current = false;
          dispatch({ type: "SET_RESTORING_SESSION", restoring: false });
          dispatch({ type: "NEW_SESSION" });
          setBgSessions([]);
          vscodeApi.postMessage({
            command: "agentNewSession",
            mode: stateRef.current.mode,
          });
          break;

        case "mode": {
          const slug = args.trim();
          if (slug) handleSwitchMode(slug);
          break;
        }
        case "model":
          vscodeApi.postMessage({
            command: "agentSetModel",
            model: args.trim(),
          });
          break;
        case "help":
          // Inject a help message as user text so the agent responds
          vscodeApi.postMessage({
            command: "agentSend",
            text: "List all available slash commands and what they do.",
            attachments: [],
            sessionId: stateRef.current.sessionId,
            mode: stateRef.current.mode,
            thinkingEnabled: false,
          });
          break;
        case "mcp":
          // args is "project" or "global" (from the webview sub-picker)
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
        case "mcp-refresh":
        case "mcp-status":
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
        case "btw":
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
        case "condense":
        case "checkpoint":
        case "revert":
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
      }
    },
    [vscodeApi, handleSwitchMode],
  );

  const handleElicitSubmit = useCallback(
    (id: string, values: Record<string, unknown>) => {
      setElicitation(null);
      vscodeApi.postMessage({
        command: "agentElicitationResponse",
        id,
        values,
        cancelled: false,
      });
    },
    [vscodeApi],
  );

  const handleElicitCancel = useCallback(
    (id: string) => {
      setElicitation(null);
      vscodeApi.postMessage({
        command: "agentElicitationResponse",
        id,
        values: {},
        cancelled: true,
      });
    },
    [vscodeApi],
  );

  const handleForwardedApprovalSubmit = useCallback(
    (data: Omit<DecisionMessage, "type">) => {
      setForwardedApproval(null);
      forwardedFollowUpRef.current = "";
      vscodeApi.postMessage({ command: "approvalDecision", ...data });
    },
    [vscodeApi],
  );

  const handleToggleThinking = useCallback(() => {
    dispatch({ type: "TOGGLE_THINKING" });
  }, []);

  const handleExportTranscript = useCallback(() => {
    vscodeApi.postMessage({
      command: "agentExportTranscript",
      messages: state.messages,
    });
  }, [vscodeApi, state.messages]);

  const handleOpenFile = useCallback(
    (path: string, line?: number) => {
      vscodeApi.postMessage({ command: "agentOpenFile", path, line });
    },
    [vscodeApi],
  );

  const handleOpenSpecialBlockPanel = useCallback(
    (block: { kind: "mermaid" | "vega" | "vega-lite"; source: string }) => {
      vscodeApi.postMessage({
        command: "agentOpenSpecialBlockPanel",
        ...block,
      });
    },
    [vscodeApi],
  );

  const handleRevertCheckpoint = useCallback(
    (sessionId: string, checkpointId: string) => {
      vscodeApi.postMessage({
        command: "agentRevertCheckpoint",
        sessionId,
        checkpointId,
      });
    },
    [vscodeApi],
  );

  const handleViewCheckpointDiff = useCallback(
    (sessionId: string, checkpointId: string, scope: "turn" | "all") => {
      vscodeApi.postMessage({
        command: "agentViewCheckpointDiff",
        sessionId,
        checkpointId,
        scope,
      });
    },
    [vscodeApi],
  );

  const handleRetry = useCallback(() => {
    if (stateRef.current.sessionId) {
      streamingRef.current = true;
      dispatch({ type: "CLEAR_ERROR" });
      vscodeApi.postMessage({
        command: "agentRetry",
        sessionId: stateRef.current.sessionId,
      });
    }
  }, [vscodeApi]);

  const handleErrorSignIn = useCallback(() => {
    const model = state.availableModels.find(
      (m) => m.id === stateRef.current.model,
    );
    if (model) {
      handleSignIn(model.provider);
    }
  }, [state.availableModels, handleSignIn]);

  const handleShowHistory = useCallback(() => {
    vscodeApi.postMessage({ command: "agentListSessions" });
    setShowHistory((prev) => !prev);
  }, [vscodeApi]);

  const handleLoadSession = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "agentLoadSession", sessionId });
    },
    [vscodeApi],
  );

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "agentDeleteSession", sessionId });
    },
    [vscodeApi],
  );

  const handleRenameSession = useCallback(
    (sessionId: string, title: string) => {
      vscodeApi.postMessage({
        command: "agentRenameSession",
        sessionId,
        title,
      });
    },
    [vscodeApi],
  );

  const handleCopyFirstPrompt = useCallback(
    (sessionId: string) => {
      handleNewSession();
      vscodeApi.postMessage({ command: "agentCopyFirstPrompt", sessionId });
      setShowHistory(false);
    },
    [vscodeApi, handleNewSession],
  );

  const handleContainerDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (e.shiftKey) {
      setShiftDragOver(true);
    }
  }, []);

  const handleContainerDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (e.shiftKey && e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
    // Update shift state in case user presses/releases shift mid-drag
    setShiftDragOver(e.shiftKey);
  }, []);

  const handleContainerDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setShiftDragOver(false);
    }
  }, []);

  const handleContainerDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setShiftDragOver(false);

      if (!e.shiftKey || !e.dataTransfer) return;

      // Try text/uri-list, then plain text
      let uriList = e.dataTransfer.getData("text/uri-list");
      if (!uriList) {
        const text =
          e.dataTransfer.getData("text/plain") ||
          e.dataTransfer.getData("text");
        if (
          text &&
          (text.startsWith("file://") || text.startsWith("vscode-"))
        ) {
          uriList = text;
        }
      }

      if (!uriList) return;

      const paths = uriList
        .split("\n")
        .map((u) => u.trim())
        .filter((u) => u && !u.startsWith("#"))
        .map((u) => {
          try {
            return decodeURIComponent(new URL(u).pathname);
          } catch {
            return u;
          }
        })
        .filter((p): p is string => !!p);

      if (paths.length > 0) {
        vscodeApi.postMessage({
          command: "agentResolveDroppedFiles",
          paths,
        });
      }
    },
    [vscodeApi],
  );

  return (
    <>
      {elicitation && (
        <ElicitationModal
          id={elicitation.id}
          serverName={elicitation.serverName}
          message={elicitation.message}
          fields={elicitation.fields}
          required={elicitation.required}
          onSubmit={handleElicitSubmit}
          onCancel={handleElicitCancel}
        />
      )}
      <div
        class="chat-container"
        onDragEnter={handleContainerDragEnter}
        onDragOver={handleContainerDragOver}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
      >
        {transcriptView && (
          <TranscriptView
            task={transcriptView.task}
            messages={transcriptView.messages}
            onClose={() => setTranscriptView(null)}
          />
        )}
        {shiftDragOver && (
          <div class="drop-overlay">
            <div class="drop-overlay-content">
              <i class="codicon codicon-attach" />
              <span>Drop to attach files</span>
            </div>
          </div>
        )}
        <div class="chat-header">
          <button
            class="icon-button"
            onClick={handleNewSession}
            title={
              state.restoringSession
                ? "Start a new session without waiting for restore"
                : "New Session"
            }
          >
            <i class="codicon codicon-add" />
          </button>
          {state.restoringSession && (
            <div
              class="session-restore-status"
              title="Restoring the last session"
            >
              <i class="codicon codicon-loading codicon-modifier-spin" />
              <span>Loading last session…</span>
            </div>
          )}
          <button
            class={`icon-button${showHistory ? " active" : ""}`}
            onClick={handleShowHistory}
            title="Session History"
          >
            <i class="codicon codicon-history" />
          </button>
        </div>
        {showHistory && (
          <SessionHistory
            sessions={sessionHistory}
            currentSessionId={state.chatState.sessionId}
            onLoad={handleLoadSession}
            onDelete={handleDeleteSession}
            onRename={handleRenameSession}
            onCopyFirstPrompt={handleCopyFirstPrompt}
            onClose={() => setShowHistory(false)}
          />
        )}
        {state.debugInfo && (
          <DebugInfo
            info={state.debugInfo}
            systemPrompt={state.systemPrompt}
            loadedInstructions={state.loadedInstructions ?? undefined}
          />
        )}
        <ChatView
          messages={state.messages}
          streaming={state.streaming}
          sessionId={state.chatState.sessionId}
          onOpenFile={handleOpenFile}
          onOpenSpecialBlockPanel={handleOpenSpecialBlockPanel}
          onRevertCheckpoint={handleRevertCheckpoint}
          onViewCheckpointDiff={handleViewCheckpointDiff}
          onRetry={handleRetry}
          onSignIn={handleErrorSignIn}
          bgSessions={bgSessions}
          onStopBackground={handleStopBackground}
          onOpenTranscript={handleOpenBgTranscript}
        />
        {state.messageQueue.length > 0 && (
          <div class="queue-panel">
            <div class="queue-header">
              <i class="codicon codicon-list-ordered" />
              <span>Queued ({state.messageQueue.length})</span>
            </div>
            {state.messageQueue.map((item) => (
              <div key={item.id} class="queue-item">
                {editingQueueId === item.id ? (
                  <textarea
                    class="queue-item-textarea"
                    value={editingQueueText}
                    onInput={(e) =>
                      setEditingQueueText(
                        (e.target as HTMLTextAreaElement).value,
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        const trimmed = editingQueueText.trim();
                        if (trimmed) {
                          dispatch({
                            type: "EDIT_QUEUE_MESSAGE",
                            id: item.id,
                            text: trimmed,
                          });
                          vscodeApi.postMessage({
                            command: "agentUpdateQueuedMessage",
                            sessionId: stateRef.current.sessionId,
                            queueId: item.id,
                            text: trimmed,
                            displayText: trimmed,
                            attachments: item.attachments,
                            images: item.images,
                            documents: item.documents,
                          });
                        }
                        setEditingQueueId(null);
                      } else if (e.key === "Escape") {
                        setEditingQueueId(null);
                      }
                    }}
                    autoFocus
                  />
                ) : (
                  <span
                    class={`queue-item-text${expandedQueueIds.has(item.id) ? " expanded" : ""}`}
                    title="Click to expand/collapse"
                    onClick={() =>
                      setExpandedQueueIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                  >
                    {item.text}
                  </span>
                )}
                <div class="queue-item-actions">
                  {editingQueueId !== item.id && (
                    <button
                      class="icon-button queue-item-edit"
                      title="Edit"
                      onClick={() => {
                        setEditingQueueText(item.text);
                        setEditingQueueId(item.id);
                      }}
                    >
                      <i class="codicon codicon-edit" />
                    </button>
                  )}
                  <button
                    class="icon-button queue-item-remove"
                    title="Remove"
                    onClick={() => {
                      dispatch({ type: "REMOVE_FROM_QUEUE", id: item.id });
                      const wasHead =
                        messageQueueRef.current[0]?.id === item.id;
                      const nextQueue = messageQueueRef.current.filter(
                        (q) => q.id !== item.id,
                      );
                      messageQueueRef.current = nextQueue;
                      if (wasHead) {
                        vscodeApi.postMessage({
                          command: "agentRemoveQueuedMessage",
                          sessionId: stateRef.current.sessionId,
                          queueId: item.id,
                        });
                        const nextHead = nextQueue[0];
                        if (nextHead) {
                          vscodeApi.postMessage({
                            command: "agentQueueMessage",
                            text: nextHead.fullText ?? nextHead.text,
                            displayText: nextHead.text,
                            queueId: nextHead.id,
                            sessionId: stateRef.current.sessionId,
                            attachments: nextHead.attachments,
                            images: nextHead.images,
                            documents: nextHead.documents,
                          });
                        }
                      }
                    }}
                  >
                    <i class="codicon codicon-close" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {(state.lastInputTokens > 0 || state.lastOutputTokens > 0) && (
          <ContextBar
            inputTokens={state.lastInputTokens}
            outputTokens={state.lastOutputTokens}
            cacheReadTokens={state.lastCacheReadTokens}
            maxContextWindow={
              state.availableModels.find((m) => m.id === state.chatState.model)
                ?.contextWindow ?? DEFAULT_MAX_TOKENS
            }
            condenseThreshold={state.chatState.condenseThreshold}
          />
        )}
        {mcpStatusInfos && (
          <div class="mcp-status-panel">
            <div class="mcp-status-header">
              <i class="codicon codicon-server" />
              <span>MCP Servers</span>
              <button
                class="mcp-status-close icon-button"
                onClick={() => setMcpStatusInfos(null)}
                title="Dismiss"
              >
                <i class="codicon codicon-close" />
              </button>
            </div>
            {mcpStatusInfos.length === 0 ? (
              <p class="mcp-status-empty">No MCP servers configured.</p>
            ) : (
              <ul class="mcp-status-list">
                {mcpStatusInfos.map((info) => (
                  <li
                    key={info.name}
                    class={`mcp-status-item mcp-status-${info.status}`}
                  >
                    <i
                      class={`codicon ${
                        info.status === "connected"
                          ? "codicon-check"
                          : info.status === "connecting"
                            ? "codicon-loading codicon-modifier-spin"
                            : "codicon-error"
                      }`}
                    />
                    <span class="mcp-status-name">{info.name}</span>
                    <span class="mcp-status-detail">
                      {info.status === "connected"
                        ? [
                            `${info.toolCount} tool${info.toolCount !== 1 ? "s" : ""}`,
                            info.resourceCount > 0 &&
                              `${info.resourceCount} resource${info.resourceCount !== 1 ? "s" : ""}`,
                            info.promptCount > 0 &&
                              `${info.promptCount} prompt${info.promptCount !== 1 ? "s" : ""}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : (info.error ?? info.status)}
                    </span>
                    <span class="mcp-status-actions">
                      {info.status !== "connecting" && (
                        <button
                          class="icon-button"
                          title="Reconnect"
                          onClick={() =>
                            vscodeApi.postMessage({
                              command: "agentMcpAction",
                              serverName: info.name,
                              action: "reconnect",
                            })
                          }
                        >
                          <i class="codicon codicon-refresh" />
                        </button>
                      )}
                      <button
                        class="icon-button"
                        title="Reauthenticate"
                        onClick={() =>
                          vscodeApi.postMessage({
                            command: "agentMcpAction",
                            serverName: info.name,
                            action: "reauthenticate",
                          })
                        }
                      >
                        <i class="codicon codicon-key" />
                      </button>
                      <button
                        class="icon-button mcp-action-disable"
                        title="Disable"
                        onClick={() =>
                          vscodeApi.postMessage({
                            command: "agentMcpAction",
                            serverName: info.name,
                            action: "disable",
                          })
                        }
                      >
                        <i class="codicon codicon-circle-slash" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {state.todos.length > 0 && <TodoPanel todos={state.todos} />}
        {state.questionRequest && (
          <QuestionCard
            id={state.questionRequest.id}
            questions={state.questionRequest.questions}
            onSubmit={(
              id: string,
              answers: Record<
                string,
                string | string[] | number | boolean | undefined
              >,
              notes: Record<string, string>,
            ) => {
              dispatch({ type: "CLEAR_QUESTION" });
              vscodeApi.postMessage({
                command: "agentQuestionResponse",
                id,
                answers,
                notes,
              });
            }}
          />
        )}
        {forwardedApproval && (
          <div class="approval-panel-embed">
            {forwardedApproval.kind === "command" ? (
              <CommandCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : forwardedApproval.kind === "write" ? (
              <WriteCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : forwardedApproval.kind === "rename" ? (
              <RenameCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : forwardedApproval.kind === "mcp" ? (
              <McpCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : forwardedApproval.kind === "mode-switch" ? (
              <ModeSwitchCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : (
              <PathCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            )}
          </div>
        )}
        {btwState && (
          <BtwPanel state={btwState} onDismiss={() => setBtwState(null)} />
        )}
        {state.streaming && (
          <div class="streaming-status-bar">
            <i class="codicon codicon-loading codicon-modifier-spin" />
            <span>
              {state.statusOverride ??
                (() => {
                  const lastMsg = state.messages[state.messages.length - 1];
                  if (lastMsg?.role === "assistant") {
                    return getStreamingActivity(lastMsg.blocks);
                  }
                  return "Waiting for response…";
                })()}
            </span>
          </div>
        )}
        <BackgroundSessionStrip
          sessions={bgSessions}
          onStop={handleStopBackground}
          onOpenTranscript={handleOpenBgTranscript}
        />
        <InputArea
          onSend={handleSend}
          onStop={handleStop}
          streaming={state.streaming}
          thinkingEnabled={state.thinkingEnabled}
          onToggleThinking={handleToggleThinking}
          onExportTranscript={handleExportTranscript}
          hasMessages={state.messages.length > 0}
          vscodeApi={vscodeApi}
          injection={injection}
          onInjectionConsumed={() => setInjection(null)}
          slashCommands={state.slashCommands}
          onExecuteBuiltinCommand={handleExecuteBuiltinCommand}
          modes={state.modes}
          currentMode={state.chatState.mode}
          currentModel={state.chatState.model}
          currentCondenseThreshold={state.chatState.condenseThreshold}
          availableModels={state.availableModels}
          onSelectModel={handleSelectModel}
          onSetCondenseThreshold={handleSetCondenseThreshold}
          onSignIn={handleSignIn}
          onSwitchMode={handleSwitchMode}
          agentWriteApproval={state.chatState.agentWriteApproval ?? "prompt"}
          onSetAgentWriteApproval={handleSetAgentWriteApproval}
        />
      </div>
    </>
  );
}
