import type { SidebarState, PostCommand } from "../types.js";
import { CollapsibleSection } from "./common/CollapsibleSection.js";

interface Props {
  state: SidebarState;
  postCommand: PostCommand;
}

export function IndexStatus({ state, postCommand }: Props) {
  const status = state.indexStatus;
  const isIndexing =
    status?.state === "indexing" || status?.state === "discovering";
  const isError = status?.state === "error";
  const wasCancelled = status?.lastCompleted?.cancelled === true;

  const dotClass = isError
    ? "dot error"
    : isIndexing
      ? "dot indexing"
      : wasCancelled
        ? "dot stopped"
        : status?.lastCompleted
          ? "dot running"
          : "dot stopped";

  let completedText = "Not indexed";
  if (status?.lastCompleted) {
    const { filesIndexed, totalFilesInIndex, totalChunksInIndex } =
      status.lastCompleted;
    if (wasCancelled) {
      completedText = `Cancelled \u2014 ${totalFilesInIndex} files indexed so far`;
    } else if (filesIndexed > 0 && totalFilesInIndex > filesIndexed) {
      completedText = `Indexed \u2014 ${totalFilesInIndex} files (${filesIndexed} updated), ${totalChunksInIndex} chunks`;
    } else {
      completedText = `Indexed \u2014 ${totalFilesInIndex} files, ${totalChunksInIndex} chunks`;
    }
  }

  const statusText = isError
    ? `Error: ${status?.error ?? "Unknown error"}`
    : isIndexing
      ? status?.phase
        ? `${capitalize(status.phase)}${status.current != null && status.total ? ` ${status.current}/${status.total}` : ""}`
        : "Discovering files..."
      : completedText;

  const progress =
    isIndexing && status?.current != null && status?.total
      ? Math.round((status.current / status.total) * 100)
      : null;

  return (
    <CollapsibleSection title="Codebase Index">
      <div class="index-status">
        <div class="status-header">
          <span class={dotClass} />
          <span class="status-text">{statusText}</span>
        </div>

        {progress !== null && (
          <div class="progress-bar">
            <div class="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}

        {status?.lastCompleted && !isIndexing && (
          <div class="index-stats">
            Completed in {(status.lastCompleted.durationMs / 1000).toFixed(1)}s
            {status.lastCompleted.errorCount != null &&
              status.lastCompleted.errorCount > 0 && (
                <span class="index-errors">
                  {" \u2014 "}{status.lastCompleted.errorCount} error
                  {status.lastCompleted.errorCount > 1 ? "s" : ""} (check Output
                  panel)
                </span>
              )}
          </div>
        )}

        <div class="button-group">
          {!isIndexing && wasCancelled && (
            <button
              class="btn btn-secondary"
              onClick={() => postCommand("resumeIndex")}
            >
              Resume
            </button>
          )}
          {!isIndexing && (
            <button
              class="btn btn-secondary"
              onClick={() => postCommand("rebuildIndex")}
            >
              {isError ? "Retry" : status?.lastCompleted && !wasCancelled ? "Rebuild Index" : "Index Codebase"}
            </button>
          )}
          {isIndexing && (
            <button
              class="btn btn-secondary"
              onClick={() => postCommand("cancelIndex")}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
