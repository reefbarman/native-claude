import { useState, useCallback, useEffect } from "preact/hooks";
import type { ComponentChild } from "preact";
import type { ChatMessage, ContentBlock } from "../types";
import { StreamingText } from "./StreamingText";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallBlock } from "./ToolCallBlock";
import { ErrorBlock } from "./ErrorBlock";
import { ApiRequestBlock } from "./ApiRequestBlock";
import { BgAgentBlock } from "./BgAgentBlock";
import { BgAgentResultBlock } from "./BgAgentResultBlock";
import { BgQuestionBlock } from "./BgQuestionBlock";
import { QuestionAnswerBlock } from "./QuestionAnswerBlock";
import type { BgSessionInfoProps } from "./BackgroundSessionStrip";

/**
 * Derive a short activity label from the current message blocks.
 * Covers: thinking, writing, running tools, and the gaps between
 * (waiting for API, processing tool results, etc.)
 */
export function getStreamingActivity(blocks: ContentBlock[]): string {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === "text") return "Writing…";
    if (b.type === "tool_call") {
      if (!b.complete) return "Running tool…";
      // Last block is a completed tool → agent is sending results back to the API
      return "Waiting for response…";
    }
    if (b.type === "thinking") {
      if (!b.complete) return "Thinking…";
      // Finished thinking, waiting for the model to start responding
      return "Waiting for response…";
    }
  }
  // No blocks yet → initial API call in flight
  return "Waiting for response…";
}

interface MessageBubbleProps {
  message: ChatMessage;
  streaming: boolean;
  onOpenFile?: (path: string, line?: number) => void;
  onOpenSpecialBlockPanel?: (block: {
    kind: "mermaid" | "vega" | "vega-lite";
    source: string;
  }) => void;
  onRetry?: () => void;
  onSignIn?: () => void;
  bgSessions?: BgSessionInfoProps[];
  onStopBackground?: (sessionId: string) => void;
  onOpenTranscript?: (sessionId: string) => void;
}

export function MessageBubble({
  message,
  streaming,
  onOpenFile,
  onOpenSpecialBlockPanel,
  onRetry,
  onSignIn,
  bgSessions,
  onStopBackground,
  onOpenTranscript,
}: MessageBubbleProps) {
  // Track whether the streaming text block has started its reveal animation
  const [_textRevealed, setTextRevealed] = useState(false);

  // Reset when streaming starts a new message
  useEffect(() => {
    if (streaming) setTextRevealed(false);
  }, [streaming]);

  if (message.role === "user") {
    // Slash command display — render as a compact pill, not a full bubble
    if (message.isSlashCommand) {
      return (
        <div class="message slash-cmd-message">
          <i class="codicon codicon-terminal slash-cmd-msg-icon" />
          <span class="slash-cmd-msg-name">{message.content}</span>
        </div>
      );
    }
    // Annotation messages (follow-up / rejection from approval cards)
    if (message.badge) {
      const isReject = message.badge === "rejection";
      return (
        <div class="message user-message">
          <div
            class={`message-content user-content annotation-${message.badge}`}
          >
            <div class="annotation-badge">
              <i
                class={`codicon codicon-${isReject ? "circle-slash" : "comment"}`}
              />
              {isReject ? "Rejected" : "Follow up"}
            </div>
            {message.content}
          </div>
          <CopyButton text={message.content} />
        </div>
      );
    }
    const { files, mediaLabel, cleanText } = parseAttachments(message.content);
    const hasAttachments = files.length > 0 || mediaLabel !== null;
    return (
      <div class="message user-message">
        <div class="message-content user-content">
          {hasAttachments && (
            <UserAttachments
              files={files}
              mediaLabel={mediaLabel}
              onOpenFile={onOpenFile}
            />
          )}
          <UserText text={cleanText} onOpenFile={onOpenFile} />
        </div>
        <CopyButton text={message.content} />
      </div>
    );
  }

  // Hide spawn_background_agent tool_call — it's replaced by the bg_agent block.
  // Keep get_background_status/result/kill visible so users can see what the foreground
  // agent is doing (e.g. waiting for bg results vs actually stuck).
  const blocks = (message.blocks ?? []).filter(
    (b) => !(b.type === "tool_call" && b.name === "spawn_background_agent"),
  );
  const lastIdx = blocks.length - 1;

  // Show dots while streaming — always visible at the bottom until response completes.
  // This ensures there's always a visible loading indicator during any streaming gap.
  const showDots = streaming;

  return (
    <div class="message assistant-message">
      <div class="assistant-blocks">
        {blocks.map((block, i) => {
          switch (block.type) {
            case "thinking":
              return <ThinkingBlock key={block.id} block={block} />;
            case "tool_call":
              return (
                <ToolCallBlock
                  key={block.id}
                  toolCall={block}
                  onOpenFile={onOpenFile}
                />
              );
            case "text": {
              const isActiveStream = streaming && i === lastIdx;
              return (
                <TextBlock
                  key={`text-${i}`}
                  text={block.text}
                  streaming={isActiveStream}
                  showCopy={!isActiveStream}
                  onOpenFile={onOpenFile}
                  onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
                  onRevealStart={
                    isActiveStream ? () => setTextRevealed(true) : undefined
                  }
                />
              );
            }
            case "bg_agent":
              return (
                <BgAgentBlock
                  key={`bg-${block.sessionId}`}
                  sessionId={block.sessionId}
                  task={block.task}
                  message={block.message}
                  resolvedModel={block.resolvedModel}
                  resolvedProvider={block.resolvedProvider}
                  resolvedMode={block.resolvedMode}
                  taskClass={block.taskClass}
                  routingReason={block.routingReason}
                  bgSession={bgSessions?.find((s) => s.id === block.sessionId)}
                  onStop={onStopBackground}
                />
              );
            case "bg_agent_result":
              return (
                <BgAgentResultBlock
                  key={`bgr-${block.sessionId}`}
                  sessionId={block.sessionId}
                  task={block.task}
                  status={block.status}
                  resultText={block.resultText}
                  onOpenTranscript={onOpenTranscript}
                />
              );
            case "bg_question":
              return (
                <BgQuestionBlock
                  key={`bgq-${block.bgTask}-${i}`}
                  bgTask={block.bgTask}
                  questions={block.questions}
                  answer={block.answer}
                />
              );
            case "question_answer":
              return <QuestionAnswerBlock key={`qa-${i}`} block={block} />;
          }
        })}

        {/* Streaming indicator with activity label */}
        {showDots && (
          <div class="streaming-indicator">
            <span class="dot" />
            <span class="dot" />
            <span class="dot" />
            <span class="streaming-activity-label">
              {getStreamingActivity(blocks)}
            </span>
          </div>
        )}

        {/* Empty response fallback — shown when streaming ended with no visible content */}
        {!streaming && blocks.length === 0 && !message.error && (
          <div class="message-content assistant-content empty-response">
            (No response)
          </div>
        )}
      </div>

      {/* API request inspector */}
      {message.apiRequest && (
        <ApiRequestBlock
          requestId={message.apiRequest.requestId}
          model={message.apiRequest.model}
          inputTokens={message.apiRequest.inputTokens}
          outputTokens={message.apiRequest.outputTokens}
          durationMs={message.apiRequest.durationMs}
          timeToFirstToken={message.apiRequest.timeToFirstToken}
        />
      )}

      {/* Error block */}
      {message.error && (
        <ErrorBlock
          error={message.error.message}
          retryable={message.error.retryable}
          onRetry={onRetry}
          onSignIn={onSignIn}
        />
      )}
    </div>
  );
}

// Regex to extract [Attached: path] markers from user message content
const ATTACHED_FILE_RE = /\[Attached: ([^\]]+)\]\n*/g;
// Regex to extract [N image(s), N PDF(s) attached] media indicator
const MEDIA_INDICATOR_RE = /\[([^\]]*attached)\]\n*/;

/** Parse attachment markers out of user message text, returning chips + clean text */
function parseAttachments(content: string): {
  files: string[];
  mediaLabel: string | null;
  cleanText: string;
} {
  const files: string[] = [];
  let text = content;

  // Extract file attachments
  let match: RegExpExecArray | null;
  ATTACHED_FILE_RE.lastIndex = 0;
  while ((match = ATTACHED_FILE_RE.exec(content)) !== null) {
    files.push(match[1]);
  }
  text = text.replace(ATTACHED_FILE_RE, "");

  // Extract media indicator (images/PDFs)
  let mediaLabel: string | null = null;
  const mediaMatch = MEDIA_INDICATOR_RE.exec(text);
  if (mediaMatch) {
    mediaLabel = mediaMatch[1];
    text = text.replace(MEDIA_INDICATOR_RE, "");
  }

  return { files, mediaLabel, cleanText: text.trim() };
}

/** Renders attachment chips above user message text */
function UserAttachments({
  files,
  mediaLabel,
  onOpenFile,
}: {
  files: string[];
  mediaLabel: string | null;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  if (files.length === 0 && !mediaLabel) return null;

  return (
    <div class="user-attachments">
      {files.map((filePath) => {
        const name = filePath.split("/").pop() ?? filePath;
        return (
          <span
            key={filePath}
            class="user-attachment-chip"
            title={filePath}
            onClick={
              onOpenFile
                ? (e: MouseEvent) => {
                    e.preventDefault();
                    onOpenFile(filePath);
                  }
                : undefined
            }
            style={onOpenFile ? { cursor: "pointer" } : undefined}
          >
            <i class="codicon codicon-file" />
            <span class="user-attachment-chip-name">{name}</span>
          </span>
        );
      })}
      {mediaLabel && (
        <span class="user-attachment-chip user-attachment-media">
          <i class="codicon codicon-file-media" />
          <span class="user-attachment-chip-name">{mediaLabel}</span>
        </span>
      )}
    </div>
  );
}

// FILE_PATH_RE for plain text (user messages) — same pattern as StreamingText
const FILE_PATH_RE =
  /(?<![:/])\b((?:(?:\/[\w.-]+)+|[\w][\w-]*(?:\/[\w.-]+)+)\.\w{1,8})(?::(\d+)(?:-\d+)?)?/g;

function UserText({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  if (!onOpenFile) return <>{text}</>;

  const parts: ComponentChild[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  FILE_PATH_RE.lastIndex = 0;

  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const filePath = match[1];
    const line = match[2] ? parseInt(match[2], 10) : undefined;
    const idx = match.index;
    parts.push(
      <a
        key={idx}
        class="file-path-link"
        href="#"
        title={`Open ${filePath}${line !== undefined ? `:${line}` : ""}`}
        onClick={(e: MouseEvent) => {
          e.preventDefault();
          onOpenFile(filePath, line);
        }}
      >
        {match[0]}
      </a>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (parts.length === 0) return <>{text}</>;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

function TextBlock({
  text,
  streaming,
  showCopy,
  onOpenFile,
  onOpenSpecialBlockPanel,
  onRevealStart: onRevealStartProp,
}: {
  text: string;
  streaming: boolean;
  showCopy: boolean;
  onOpenFile?: (path: string, line?: number) => void;
  onOpenSpecialBlockPanel?: (block: {
    kind: "mermaid" | "vega" | "vega-lite";
    source: string;
  }) => void;
  onRevealStart?: () => void;
}) {
  const [revealed, setRevealed] = useState(false);

  const handleRevealStart = useCallback(() => {
    setRevealed(true);
    onRevealStartProp?.();
  }, [onRevealStartProp]);

  return (
    <div
      class="message-content assistant-content"
      style={streaming && !revealed ? { display: "none" } : undefined}
    >
      <StreamingText
        text={text}
        streaming={streaming}
        onRevealStart={handleRevealStart}
        onOpenFile={onOpenFile}
        onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
      />
      {showCopy && <CopyButton text={text} />}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      class={`copy-button ${copied ? "copied" : ""}`}
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy as Markdown"}
    >
      <i class={`codicon codicon-${copied ? "check" : "copy"}`} />
    </button>
  );
}
