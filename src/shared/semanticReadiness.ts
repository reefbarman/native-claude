export type SemanticReadinessReason =
  | "missing_embeddings_auth"
  | "missing_index"
  | "qdrant_unavailable"
  | "no_workspace"
  | "disabled"
  | "generic_error";

export interface SemanticReadinessSnapshot {
  semanticEnabled: boolean;
  hasEmbeddingAuth: boolean;
  hasWorkspace: boolean;
  qdrantReachable?: boolean;
  hasIndex?: boolean;
}

export function classifySemanticReadiness(
  snapshot: SemanticReadinessSnapshot,
): SemanticReadinessReason | "ready" {
  if (!snapshot.semanticEnabled) return "disabled";
  if (!snapshot.hasWorkspace) return "no_workspace";
  if (!snapshot.hasEmbeddingAuth) return "missing_embeddings_auth";
  if (snapshot.qdrantReachable === false) return "qdrant_unavailable";
  if (snapshot.hasIndex === false) return "missing_index";
  return "ready";
}

export function getSemanticReadinessMessage(
  reason: SemanticReadinessReason,
  opts?: { qdrantUrl?: string },
): string {
  switch (reason) {
    case "disabled":
      return "Semantic search is not enabled. Set agentlink.semanticSearchEnabled to true.";
    case "missing_embeddings_auth":
      return "OpenAI API key not configured for embeddings. Semantic search and indexing require an API key (set OPENAI_API_KEY or run 'AgentLink: Set OpenAI API Key for Embeddings'). Model chat can still use OpenAI/Codex OAuth.";
    case "no_workspace":
      return "No workspace folder open.";
    case "qdrant_unavailable":
      return `Qdrant not reachable at ${opts?.qdrantUrl ?? "configured URL"}. Make sure Qdrant is running (e.g. docker run -p 6333:6333 qdrant/qdrant).`;
    case "missing_index":
      return "No codebase index found for this workspace. Run 'AgentLink: Rebuild Codebase Index' or click 'Index Codebase' in the AgentLink sidebar.";
    case "generic_error":
      return "Semantic search is not ready.";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
