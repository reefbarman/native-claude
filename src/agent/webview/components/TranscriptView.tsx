import type { ChatMessage } from "../types";
import { MessageBubble } from "./MessageBubble";

interface TranscriptViewProps {
  task: string;
  messages: ChatMessage[];
  onClose: () => void;
}

export function TranscriptView({
  task,
  messages,
  onClose,
}: TranscriptViewProps) {
  return (
    <div class="transcript-overlay">
      <div class="transcript-header">
        <i class="codicon codicon-server-process transcript-header-icon" />
        <span class="transcript-header-title" title={task}>
          {task}
        </span>
        <button
          class="icon-button transcript-close"
          onClick={onClose}
          title="Close"
        >
          <i class="codicon codicon-close" />
        </button>
      </div>
      <div class="transcript-messages">
        {messages.length === 0 ? (
          <div class="transcript-empty">No messages recorded.</div>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} streaming={false} />
          ))
        )}
      </div>
    </div>
  );
}
