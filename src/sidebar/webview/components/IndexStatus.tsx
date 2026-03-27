import type { SidebarState, PostCommand } from "../types.js";
import type { SemanticReadinessReason } from "../../../shared/semanticReadiness.js";
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

  const readinessReason = status?.readinessReason;
  const showRemediation = isError && Boolean(readinessReason);

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
                  {" \u2014 "}
                  {status.lastCompleted.errorCount} error
                  {status.lastCompleted.errorCount > 1 ? "s" : ""} (check Output
                  panel)
                </span>
              )}
          </div>
        )}

        {showRemediation && readinessReason ? (
          <ReadinessActions
            readinessReason={readinessReason}
            readinessMessage={status?.readinessMessage ?? status?.error}
            postCommand={postCommand}
          />
        ) : (
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
                {isError
                  ? "Retry"
                  : status?.lastCompleted && !wasCancelled
                    ? "Rebuild Index"
                    : "Index Codebase"}
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
        )}
      </div>
    </CollapsibleSection>
  );
}

interface ReadinessActionsProps {
  readinessReason: SemanticReadinessReason;
  readinessMessage?: string;
  postCommand: PostCommand;
}

function ReadinessActions({
  readinessReason,
  readinessMessage,
  postCommand,
}: ReadinessActionsProps) {
  const message =
    readinessMessage ??
    "Semantic search/indexing setup is required before this action can run.";

  if (readinessReason === "missing_embeddings_auth") {
    return (
      <div class="index-remediation">
        <p class="help-text index-remediation-text">{message}</p>
        <div class="button-group">
          <button
            class="btn btn-primary"
            onClick={() => postCommand("setOpenaiApiKey")}
          >
            Set Embeddings API Key
          </button>
          <button
            class="btn btn-secondary"
            onClick={() => postCommand("setOpenaiModelsAndEmbeddingsApiKey")}
          >
            Set Models + Embeddings API Key
          </button>
          <button
            class="btn btn-secondary"
            onClick={() =>
              postCommand("setupSemanticSearch", { reason: readinessReason })
            }
          >
            Guided Setup
          </button>
        </div>
      </div>
    );
  }

  if (readinessReason === "missing_index") {
    return (
      <div class="index-remediation">
        <p class="help-text index-remediation-text">{message}</p>
        <div class="button-group">
          <button
            class="btn btn-primary"
            onClick={() => postCommand("rebuildIndex")}
          >
            Index Codebase
          </button>
          <button
            class="btn btn-secondary"
            onClick={() =>
              postCommand("setupSemanticSearch", { reason: readinessReason })
            }
          >
            Guided Setup
          </button>
        </div>
      </div>
    );
  }

  if (readinessReason === "qdrant_unavailable") {
    return (
      <div class="index-remediation">
        <p class="help-text index-remediation-text">{message}</p>
        <div class="button-group">
          <button
            class="btn btn-primary"
            onClick={() => postCommand("rebuildIndex")}
          >
            Retry
          </button>
          <button
            class="btn btn-secondary"
            onClick={() => postCommand("openSettings")}
          >
            Open Settings
          </button>
          <button
            class="btn btn-secondary"
            onClick={() => postCommand("openOutput")}
          >
            Open Output
          </button>
        </div>
      </div>
    );
  }

  if (readinessReason === "disabled") {
    return (
      <div class="index-remediation">
        <p class="help-text index-remediation-text">{message}</p>
        <div class="button-group">
          <button
            class="btn btn-primary"
            onClick={() => postCommand("openSettings")}
          >
            Enable in Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="index-remediation">
      <p class="help-text index-remediation-text">{message}</p>
      <div class="button-group">
        <button
          class="btn btn-secondary"
          onClick={() => postCommand("rebuildIndex")}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
