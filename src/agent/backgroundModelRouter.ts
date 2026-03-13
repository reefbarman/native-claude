import routingConfigRaw from "./backgroundModelRouting.config.json";
import type { ProviderRegistry } from "./providers/index.js";
import type { ModelInfo } from "./providers/types.js";
import type {
  BackgroundRouteResolution,
  ModelTier,
  ProviderStrategy,
  SpawnBackgroundRequest,
} from "./backgroundTypes.js";

interface TaskRouteRule {
  preferredMode?: string;
  providerStrategy?: ProviderStrategy;
  specificProvider?: string;
  modelTier?: ModelTier;
  useForegroundModelByDefault?: boolean;
  requireReviewCapableModel?: boolean;
  /** Override thinking budget for background agents of this task class. */
  thinkingBudget?: number;
  /** Soft maximum tool calls before the agent is asked to wrap up. */
  maxToolCalls?: number;
  /** Soft maximum API turns before the agent is asked to wrap up. */
  maxApiTurns?: number;
  /** Restrict the tool set for this task class (e.g. "review" for read-only review tools). */
  toolProfile?: string;
}

interface RoutingConfig {
  defaults: TaskRouteRule & { taskClass: string };
  taskClasses: Record<string, TaskRouteRule>;
  fallbackProviderOrder: string[];
}

const routingConfig = routingConfigRaw as RoutingConfig;

function getTaskRule(taskClass?: string): {
  taskClass: string;
  rule: TaskRouteRule;
} {
  const normalized = (
    taskClass ??
    routingConfig.defaults.taskClass ??
    "general"
  ).trim();
  const fromConfig = routingConfig.taskClasses[normalized];
  const resolvedClass = fromConfig
    ? normalized
    : (routingConfig.defaults.taskClass ?? "general");
  return {
    taskClass: resolvedClass,
    rule: {
      ...routingConfig.defaults,
      ...routingConfig.taskClasses[resolvedClass],
    },
  };
}

function pickMode(
  request: SpawnBackgroundRequest,
  foregroundMode: string,
  rule: TaskRouteRule,
): string {
  return request.mode?.trim() || rule.preferredMode || foregroundMode || "code";
}

function inferReviewTier(
  request: SpawnBackgroundRequest,
): ModelTier | undefined {
  const taskClass = request.taskClass?.trim().toLowerCase();
  if (!taskClass?.startsWith("review_")) return undefined;

  const text = `${request.task}\n${request.message}`.toLowerCase();
  const deepSignals = [
    /\bcomplex\b/,
    /\bcritical\b/,
    /\bsecurity\b/,
    /\brisky?\b/,
    /\bdeep\s+review\b/,
    /\bthorough\b/,
    /\barchitecture\b/,
    /\bprincipal[-\s]engineer\b/,
    /\bnon[- ]?obvious\b/,
    /\bedge cases?\b/,
    /\bmulti[- ]file\b/,
    /\bcross[- ](cutting|system|module)\b/,
    /\bcorrectness\b/,
    /\bdata integrity\b/,
    /\bproduction\b/,
  ];

  return deepSignals.some((pattern) => pattern.test(text))
    ? "deep_reasoning"
    : "balanced";
}

function scoreModel(model: ModelInfo, tier: ModelTier): number {
  const id = model.id.toLowerCase();
  const caps = model.capabilities;
  const base =
    (caps.contextWindow / 1000) * 2 +
    caps.maxOutputTokens / 1000 +
    (caps.supportsThinking ? 40 : 0) +
    (caps.supportsToolUse ? 20 : 0);

  const cheapHints = /haiku|spark|mini|lite/;
  const deepHints = /opus|max|5\.3|sonnet|pro/;
  const isOpus = /opus/.test(id);
  const isSonnet = /sonnet/.test(id);

  if (tier === "deep_reasoning") {
    return (
      base +
      (caps.supportsThinking ? 120 : -120) +
      (deepHints.test(id) ? 80 : 0) +
      (cheapHints.test(id) ? -100 : 0) +
      (isOpus ? 30 : 0) +
      (isSonnet ? 10 : 0)
    );
  }

  if (tier === "cheap") {
    return (
      base +
      (cheapHints.test(id) ? 180 : 0) +
      (deepHints.test(id) ? -80 : 0) -
      caps.contextWindow / 3000
    );
  }

  // balanced
  return (
    base +
    (caps.supportsThinking ? 30 : 0) +
    (cheapHints.test(id) ? 20 : 0) +
    (deepHints.test(id) ? 20 : 0) +
    (isSonnet ? 25 : 0) +
    (isOpus ? -10 : 0)
  );
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

export async function resolveBackgroundRoute(
  registry: ProviderRegistry,
  request: SpawnBackgroundRequest,
  foreground: { mode: string; model: string },
): Promise<BackgroundRouteResolution> {
  const allModels = registry.listAllModels();
  if (allModels.length === 0) {
    throw new Error("No models are registered. Cannot spawn background agent.");
  }

  const authStatus = await registry.getAuthStatus();
  const providersWithModels = unique(allModels.map((m) => m.provider));

  const foregroundProvider =
    registry.tryResolveProvider(foreground.model)?.id ??
    allModels.find((m) => m.id === foreground.model)?.provider;

  const { taskClass, rule } = getTaskRule(request.taskClass);
  const resolvedMode = pickMode(request, foreground.mode, rule);

  // Per-task-class overrides forwarded to the caller
  const ruleOverrides = {
    ...(rule.thinkingBudget !== undefined
      ? { thinkingBudget: rule.thinkingBudget }
      : {}),
    ...(rule.maxToolCalls !== undefined
      ? { maxToolCalls: rule.maxToolCalls }
      : {}),
    ...(rule.maxApiTurns !== undefined
      ? { maxApiTurns: rule.maxApiTurns }
      : {}),
    ...(rule.toolProfile ? { toolProfile: rule.toolProfile } : {}),
  };

  const requestedProvider = request.provider?.trim();
  const requestedModel = request.model?.trim();

  if (requestedModel) {
    const modelInfo = allModels.find((m) => m.id === requestedModel);
    if (!modelInfo) {
      throw new Error(`Requested model "${requestedModel}" is not available.`);
    }
    const providerMismatch = Boolean(
      requestedProvider && requestedProvider !== modelInfo.provider,
    );
    return {
      resolvedMode,
      resolvedModel: modelInfo.id,
      resolvedProvider: modelInfo.provider,
      taskClass,
      routingReason: providerMismatch
        ? `explicit model override (${modelInfo.id}) ignored requested provider (${requestedProvider})`
        : `explicit model override (${modelInfo.id})`,
      fallbackUsed: providerMismatch,
      ...ruleOverrides,
    };
  }

  const modelTier =
    request.modelTier ??
    inferReviewTier(request) ??
    rule.modelTier ??
    "balanced";
  const strategy = rule.providerStrategy ?? "same";
  const specificProvider = rule.specificProvider;

  // Keep general tasks on the same model unless route policy says otherwise.
  if (
    rule.useForegroundModelByDefault &&
    foreground.model &&
    allModels.some((m) => m.id === foreground.model) &&
    (!requestedProvider || requestedProvider === foregroundProvider)
  ) {
    const foregroundModelInfo = allModels.find(
      (m) => m.id === foreground.model,
    )!;
    return {
      resolvedMode,
      resolvedModel: foregroundModelInfo.id,
      resolvedProvider: foregroundModelInfo.provider,
      taskClass,
      routingReason: "defaulted to foreground model",
      fallbackUsed: false,
      ...ruleOverrides,
    };
  }

  const oppositeProviders = providersWithModels.filter(
    (p) => p !== foregroundProvider,
  );

  const preferredProviders = (() => {
    if (requestedProvider) return [requestedProvider];
    if (strategy === "specific" && specificProvider) return [specificProvider];
    if (strategy === "opposite") return oppositeProviders;
    if (strategy === "same" && foregroundProvider) return [foregroundProvider];
    return foregroundProvider ? [foregroundProvider] : [];
  })();

  const fallbackProviders = unique([
    ...routingConfig.fallbackProviderOrder,
    ...providersWithModels,
  ]);

  const preferredOrder = unique(preferredProviders).filter((provider) =>
    providersWithModels.includes(provider),
  );
  const fallbackOrder = unique(fallbackProviders).filter(
    (provider) =>
      providersWithModels.includes(provider) &&
      !preferredOrder.includes(provider),
  );

  const preferredAuthenticated = preferredOrder.filter((p) => authStatus[p]);
  const fallbackAuthenticated = fallbackOrder.filter((p) => authStatus[p]);
  const providerPasses = [preferredAuthenticated, fallbackAuthenticated].filter(
    (providers) => providers.length > 0,
  );

  const requireReviewCapable = rule.requireReviewCapableModel ?? false;

  for (const providers of providerPasses) {
    const candidates = allModels.filter((model) => {
      if (!providers.includes(model.provider)) return false;
      if (requireReviewCapable && !model.capabilities.supportsThinking)
        return false;
      return true;
    });

    if (candidates.length === 0) continue;

    const ranked = [...candidates].sort(
      (a, b) => scoreModel(b, modelTier) - scoreModel(a, modelTier),
    );
    const picked = ranked[0];

    const preferredHit = preferredAuthenticated.includes(picked.provider);
    const fallbackUsed = !preferredHit;
    const routingReason = fallbackUsed
      ? `fallback to ${picked.provider}/${picked.id} (strategy=${strategy}, tier=${modelTier})`
      : `routed by ${strategy} provider strategy (tier=${modelTier})`;

    return {
      resolvedMode,
      resolvedModel: picked.id,
      resolvedProvider: picked.provider,
      taskClass,
      routingReason,
      fallbackUsed,
      ...ruleOverrides,
    };
  }

  const authenticatedModels = allModels.filter((m) => authStatus[m.provider]);
  const fallbackModel = authenticatedModels[0] ?? allModels[0];
  return {
    resolvedMode,
    resolvedModel: fallbackModel.id,
    resolvedProvider: fallbackModel.provider,
    taskClass,
    routingReason:
      authenticatedModels.length > 0
        ? "no preferred/authenticated candidates available; using first authenticated model"
        : "no authenticated providers available; using first discovered model",
    fallbackUsed: true,
    ...ruleOverrides,
  };
}
