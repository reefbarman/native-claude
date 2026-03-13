export interface SpawnBackgroundRequest {
  task: string;
  message: string;
  mode?: string;
  model?: string;
  provider?: string;
  taskClass?: string;
  modelTier?: ModelTier;
}

export interface SpawnBackgroundResult {
  sessionId: string;
  resolvedMode: string;
  resolvedModel: string;
  resolvedProvider: string;
  taskClass: string;
  routingReason: string;
  fallbackUsed: boolean;
}

export type ProviderStrategy = "same" | "opposite" | "specific";
export type ModelTier = "cheap" | "balanced" | "deep_reasoning";

export interface BackgroundRouteResolution {
  resolvedMode: string;
  resolvedModel: string;
  resolvedProvider: string;
  taskClass: string;
  routingReason: string;
  fallbackUsed: boolean;
  /** Override thinking budget for this task class (undefined = inherit foreground). */
  thinkingBudget?: number;
  /** Soft max tool calls before the agent is told to wrap up. */
  maxToolCalls?: number;
  /** Soft max API turns before the agent is told to wrap up. */
  maxApiTurns?: number;
  /** Tool profile name restricting available tools (e.g. "review"). */
  toolProfile?: string;
}
