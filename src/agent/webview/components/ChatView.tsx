import { useRef, useEffect, useCallback } from "preact/hooks";
import type { ChatMessage } from "../types";
import type { BgSessionInfoProps } from "./BackgroundSessionStrip";
import { MessageBubble } from "./MessageBubble";
import { CondenseRow } from "./CondenseRow";
import { WarningRow } from "./WarningRow";
import { CheckpointRow } from "./CheckpointRow";

interface ChatViewProps {
  messages: ChatMessage[];
  streaming: boolean;
  sessionId: string | null;
  onOpenFile?: (path: string, line?: number) => void;
  onOpenSpecialBlockPanel?: (block: {
    kind: "mermaid" | "vega" | "vega-lite";
    source: string;
  }) => void;
  onRevertCheckpoint?: (sessionId: string, checkpointId: string) => void;
  onViewCheckpointDiff?: (
    sessionId: string,
    checkpointId: string,
    scope: "turn" | "all",
  ) => void;
  onRetry?: () => void;
  onSignIn?: () => void;
  bgSessions?: BgSessionInfoProps[];
  onStopBackground?: (sessionId: string) => void;
  onOpenTranscript?: (sessionId: string) => void;
}

export function ChatView({
  messages,
  streaming,
  sessionId,
  onOpenFile,
  onOpenSpecialBlockPanel,
  onRevertCheckpoint,
  onViewCheckpointDiff,
  onRetry,
  onSignIn,
  bgSessions,
  onStopBackground,
  onOpenTranscript,
}: ChatViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
  const programmaticScroll = useRef(false);

  // Helper: scroll to bottom, flagging it as programmatic so handleScroll ignores it
  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    programmaticScroll.current = true;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Derive a scroll key that changes whenever content grows —
  // new messages, new blocks, text/input deltas, tool results
  const lastMsg = messages[messages.length - 1];
  const lastBlock = lastMsg?.blocks[lastMsg.blocks.length - 1];
  const scrollKey = lastMsg
    ? `${messages.length}:${lastMsg.blocks.length}:${
        lastBlock?.type === "text"
          ? lastBlock.text.length
          : lastBlock?.type === "tool_call"
            ? `${lastBlock.inputJson.length}:${lastBlock.result.length}`
            : lastBlock?.type === "thinking"
              ? lastBlock.text.length
              : 0
      }`
    : "empty";

  // Auto-scroll to bottom when content changes
  useEffect(() => {
    if (shouldAutoScroll.current) {
      scrollToBottom();
    }
  }, [scrollKey, streaming]);

  // Track scrollHeight changes (e.g. mermaid diagrams rendering async)
  // and auto-scroll when content grows
  const lastScrollHeight = useRef(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf: number;
    const check = () => {
      if (el.scrollHeight !== lastScrollHeight.current) {
        lastScrollHeight.current = el.scrollHeight;
        if (shouldAutoScroll.current) {
          scrollToBottom();
        }
      }
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleScroll = useCallback(() => {
    // Skip scroll events caused by our own programmatic scrolling
    if (programmaticScroll.current) {
      programmaticScroll.current = false;
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    // Only disable auto-scroll if user scrolled well away from bottom
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScroll.current = distFromBottom < 150;
  }, []);

  const firstUserMsg = messages.find((m) => m.role === "user");
  const firstPromptText = firstUserMsg?.content.trim() ?? "";
  const PREVIEW_MAX = 80;
  const previewLabel =
    firstPromptText.length > PREVIEW_MAX
      ? firstPromptText.slice(0, PREVIEW_MAX) + "…"
      : firstPromptText;

  const scrollToTop = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    programmaticScroll.current = true;
    el.scrollTop = 0;
  }, []);

  if (messages.length === 0) {
    return (
      <div class="chat-messages empty">
        <div class="empty-state">
          <i class="codicon codicon-comment-discussion empty-icon" />
          <p>Ask anything to get started</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {previewLabel && (
        <button
          class="prompt-preview"
          onClick={scrollToTop}
          title={firstPromptText}
        >
          <i class="codicon codicon-comment" />
          <span class="prompt-preview-text">{previewLabel}</span>
        </button>
      )}
      <div class="chat-messages" ref={containerRef} onScroll={handleScroll}>
        {messages.map((msg) =>
          msg.role === "condense" ? (
            <CondenseRow key={msg.id} message={msg} />
          ) : msg.role === "warning" ? (
            <WarningRow
              key={msg.id}
              message={msg}
              onRetry={
                msg === messages[messages.length - 1] && msg.error
                  ? onRetry
                  : undefined
              }
            />
          ) : (
            <>
              {msg.role === "user" &&
                msg.checkpointId &&
                onRevertCheckpoint && (
                  <CheckpointRow
                    key={`cp-${msg.id}`}
                    checkpointId={msg.checkpointId}
                    sessionId={sessionId}
                    onRevert={onRevertCheckpoint}
                    onViewDiff={onViewCheckpointDiff}
                  />
                )}
              <MessageBubble
                key={msg.id}
                message={msg}
                streaming={
                  streaming &&
                  msg === messages[messages.length - 1] &&
                  msg.role === "assistant"
                }
                onOpenFile={onOpenFile}
                onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
                onRetry={
                  msg === messages[messages.length - 1] && msg.error
                    ? onRetry
                    : undefined
                }
                onSignIn={
                  msg === messages[messages.length - 1] && msg.error
                    ? onSignIn
                    : undefined
                }
                bgSessions={bgSessions}
                onStopBackground={onStopBackground}
                onOpenTranscript={onOpenTranscript}
              />
            </>
          ),
        )}
      </div>
    </>
  );
}
