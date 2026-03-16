import * as vscode from "vscode";

const LEGACY_THRESHOLD_KEY = "autoCondenseThreshold";
export const MODEL_THRESHOLD_KEY = "modelCondenseThresholds";

const SONNET_OPUS_DEFAULT_THRESHOLD = 0.6;
const OTHER_MODELS_DEFAULT_THRESHOLD = 0.9;
const MIN_THRESHOLD = 0.1;
const MAX_THRESHOLD = 1;

export type ModelCondenseThresholdMap = Record<string, number>;

export function clampCondenseThreshold(value: number): number {
  if (!Number.isFinite(value)) return OTHER_MODELS_DEFAULT_THRESHOLD;
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, value));
}

export function isAnthropicSonnetOrOpusModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.startsWith("claude-") &&
    (lower.includes("sonnet") || lower.includes("opus"))
  );
}

export function getDefaultAutoCondenseThreshold(modelId: string): number {
  return isAnthropicSonnetOrOpusModel(modelId)
    ? SONNET_OPUS_DEFAULT_THRESHOLD
    : OTHER_MODELS_DEFAULT_THRESHOLD;
}

export function normalizeModelThresholdMap(
  value: unknown,
): ModelCondenseThresholdMap {
  if (!value || typeof value !== "object") return {};
  const out: ModelCondenseThresholdMap = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "number") continue;
    out[key] = clampCondenseThreshold(raw);
  }
  return out;
}

export function getEffectiveAutoCondenseThreshold(
  modelId: string,
  overrides?: ModelCondenseThresholdMap,
): number {
  const explicit = overrides?.[modelId];
  if (typeof explicit === "number") return clampCondenseThreshold(explicit);
  return getDefaultAutoCondenseThreshold(modelId);
}

export function getConfiguredBaseThresholdForModel(
  config: vscode.WorkspaceConfiguration,
  modelId: string,
): number {
  const overrides = getMigratedModelCondenseThresholdMap(config, modelId);
  return getEffectiveAutoCondenseThreshold(modelId, overrides);
}

export function getModelCondenseThresholdMap(
  config: vscode.WorkspaceConfiguration,
): ModelCondenseThresholdMap {
  return normalizeModelThresholdMap(config.get(MODEL_THRESHOLD_KEY));
}

export function getMigratedModelCondenseThresholdMap(
  config: vscode.WorkspaceConfiguration,
  selectedModel: string,
): ModelCondenseThresholdMap {
  const explicit = getModelCondenseThresholdMap(config);
  if (Object.keys(explicit).length > 0) return explicit;

  const inspected = config.inspect<number>(LEGACY_THRESHOLD_KEY);
  const legacy =
    inspected?.globalValue ??
    inspected?.workspaceValue ??
    inspected?.workspaceFolderValue;
  if (typeof legacy !== "number") return explicit;

  return { [selectedModel]: clampCondenseThreshold(legacy) };
}
