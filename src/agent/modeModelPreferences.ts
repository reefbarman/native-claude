import * as vscode from "vscode";

export const FALLBACK_AGENT_MODEL = "claude-sonnet-4-6";

export type ModeModelPreferences = Record<string, string>;

export function getModeModelPreferences(
  config: vscode.WorkspaceConfiguration,
): ModeModelPreferences {
  const raw = config.get<unknown>("modeModelPreferences");
  if (!raw || typeof raw !== "object") return {};

  const prefs: ModeModelPreferences = {};
  for (const [mode, model] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof model !== "string") continue;
    const trimmedMode = mode.trim();
    const trimmedModel = model.trim();
    if (!trimmedMode || !trimmedModel) continue;
    prefs[trimmedMode] = trimmedModel;
  }

  return prefs;
}

export function resolveModelForMode(
  config: vscode.WorkspaceConfiguration,
  mode: string,
  fallbackModel: string = FALLBACK_AGENT_MODEL,
): string {
  const prefs = getModeModelPreferences(config);
  const preferredModel = prefs[mode]?.trim();
  if (preferredModel) return preferredModel;

  const legacyModel = config.get<string>("agentModel")?.trim();
  if (legacyModel) return legacyModel;

  return fallbackModel;
}
