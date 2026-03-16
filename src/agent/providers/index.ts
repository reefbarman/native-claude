/**
 * Provider registry — routes model IDs to their owning ModelProvider.
 *
 * Each provider declares its models via listModels(). The registry builds
 * a model→provider lookup. Unknown model IDs are rejected with a helpful error.
 */

export {
  type ModelProvider,
  type StreamRequest,
  type CompleteRequest,
  type CompleteResult,
  type ProviderStreamEvent,
  type ModelCapabilities,
  type ModelInfo,
  type ContentBlock,
  type TextBlock,
  type ThinkingBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type ImageBlock,
  type MessageParam,
  type ToolDefinition,
  type JsonSchema,
} from "./types.js";

export {
  AnthropicProvider,
  ANTHROPIC_CONDENSE_MODEL,
} from "./anthropic/index.js";

export {
  CodexProvider,
  CODEX_CONDENSE_MODEL,
  CODEX_CONDENSE_MODEL_FALLBACKS,
  CodexOAuthManager,
  codexOAuthManager,
  OpenAiCodexAuthManager,
  openAiCodexAuthManager,
  type CodexCredentials,
  type OpenAiCodexAuthMethod,
  type OpenAiCodexResolvedAuth,
  type OpenAiApiKeyCredential,
} from "./codex/index.js";

import type { ModelProvider, ModelInfo } from "./types.js";

export class ProviderRegistry {
  private providers = new Map<string, ModelProvider>();
  private modelIndex = new Map<string, string>(); // modelId → providerId

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.modelIndex.clear();
    for (const provider of this.providers.values()) {
      for (const model of provider.listModels()) {
        this.modelIndex.set(model.id, provider.id);
      }
    }
  }

  /**
   * Resolve provider for a model. Uses provider.listModels() as source of truth —
   * each provider owns its model list. No prefix-based guessing.
   */
  resolveProvider(model: string): ModelProvider {
    const providerId = this.modelIndex.get(model);
    if (providerId) {
      return this.providers.get(providerId)!;
    }

    // Unknown model — list available models for a helpful error
    const available = this.listAllModels()
      .map((m) => m.id)
      .join(", ");
    throw new Error(
      `Unknown model "${model}". Available models: ${available || "(none)"}`,
    );
  }

  /**
   * Try to resolve a provider, returning undefined if not found.
   * Useful when the caller wants to handle unknown models gracefully.
   */
  tryResolveProvider(model: string): ModelProvider | undefined {
    const providerId = this.modelIndex.get(model);
    if (providerId) {
      return this.providers.get(providerId);
    }
    return undefined;
  }

  /**
   * Aggregate models from all registered providers.
   */
  listAllModels(): ModelInfo[] {
    const models: ModelInfo[] = [];
    for (const provider of this.providers.values()) {
      models.push(...provider.listModels());
    }
    return models;
  }

  /**
   * Async — calls provider.isAuthenticated() for each registered provider.
   */
  async getAuthStatus(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      Array.from(this.providers.entries()).map(async ([id, p]) => {
        const authed = await p.isAuthenticated();
        return [id, authed] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  getProvider(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  getAllProviders(): ModelProvider[] {
    return Array.from(this.providers.values());
  }
}

/** Singleton registry. Providers are registered during extension activation. */
export const providerRegistry = new ProviderRegistry();
