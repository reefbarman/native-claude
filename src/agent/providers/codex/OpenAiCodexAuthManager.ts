import * as vscode from "vscode";

import {
  CodexOAuthManager,
  type CodexCredentials,
} from "./CodexOAuthManager.js";

const OPENAI_API_KEY_SECRET = "openaiApiKey";

export type OpenAiCodexAuthMethod = "oauth" | "apiKey";

export interface OpenAiApiKeyCredential {
  apiKey: string;
  source: "secret" | "env";
}

export interface OpenAiCodexResolvedAuth {
  method: OpenAiCodexAuthMethod;
  bearerToken: string;
  accountId?: string;
  canRefresh: boolean;
}

export class OpenAiCodexAuthManager {
  private context: vscode.ExtensionContext | null = null;
  private oauthManager: CodexOAuthManager;

  onAuthStateChanged?: () => void;

  constructor(oauthManager?: CodexOAuthManager) {
    this.oauthManager = oauthManager ?? new CodexOAuthManager();
    this.oauthManager.onAuthStateChanged = () => {
      this.onAuthStateChanged?.();
    };
  }

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.oauthManager.initialize(context);
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.getPreferredAuthMethod()) !== null;
  }

  async hasOAuth(): Promise<boolean> {
    return this.oauthManager.isAuthenticated();
  }

  async hasApiKey(): Promise<boolean> {
    const key = await this.getApiKeyCredential();
    return Boolean(key?.apiKey);
  }

  async getPreferredAuthMethod(): Promise<OpenAiCodexAuthMethod | null> {
    if (await this.hasOAuth()) return "oauth";
    if (await this.hasApiKey()) return "apiKey";
    return null;
  }

  async resolveModelAuth(): Promise<OpenAiCodexResolvedAuth | null> {
    const preferredMethod = await this.getPreferredAuthMethod();
    if (preferredMethod === "oauth") {
      const accessToken = await this.oauthManager.getAccessToken();
      if (!accessToken) {
        return null;
      }
      const accountId = await this.oauthManager.getAccountId();
      return {
        method: "oauth",
        bearerToken: accessToken,
        accountId: accountId ?? undefined,
        canRefresh: true,
      };
    }

    const apiKeyCred = await this.getApiKeyCredential();
    if (apiKeyCred) {
      return {
        method: "apiKey",
        bearerToken: apiKeyCred.apiKey,
        canRefresh: false,
      };
    }

    return null;
  }

  async resolveEmbeddingAuth(): Promise<OpenAiCodexResolvedAuth | null> {
    return this.resolveModelAuth();
  }

  async forceRefreshModelAuth(
    previousMethod: OpenAiCodexAuthMethod,
  ): Promise<OpenAiCodexResolvedAuth | null> {
    if (previousMethod === "oauth") {
      const refreshed = await this.oauthManager.forceRefreshAccessToken();
      if (!refreshed) {
        return null;
      }
      const accountId = await this.oauthManager.getAccountId();
      return {
        method: "oauth",
        bearerToken: refreshed,
        accountId: accountId ?? undefined,
        canRefresh: true,
      };
    }

    const apiKeyCred = await this.getApiKeyCredential();
    if (!apiKeyCred) {
      return null;
    }
    return {
      method: "apiKey",
      bearerToken: apiKeyCred.apiKey,
      canRefresh: false,
    };
  }

  async getApiKeyCredential(): Promise<OpenAiApiKeyCredential | null> {
    const secretKey = await this.context?.secrets.get(OPENAI_API_KEY_SECRET);
    if (secretKey?.trim()) {
      return { apiKey: secretKey.trim(), source: "secret" };
    }

    const envKey = process.env.OPENAI_API_KEY?.trim();
    if (envKey) {
      return { apiKey: envKey, source: "env" };
    }

    return null;
  }

  async storeApiKey(apiKey: string): Promise<void> {
    if (!this.context) {
      throw new Error("OpenAiCodexAuthManager not initialized");
    }
    await this.context.secrets.store(OPENAI_API_KEY_SECRET, apiKey.trim());
    this.onAuthStateChanged?.();
  }

  async clearApiKey(): Promise<void> {
    if (!this.context) return;
    await this.context.secrets.delete(OPENAI_API_KEY_SECRET);
    this.onAuthStateChanged?.();
  }

  async clearOAuth(): Promise<void> {
    await this.oauthManager.clearCredentials();
  }

  async clearAll(): Promise<void> {
    await Promise.all([this.clearOAuth(), this.clearApiKey()]);
  }

  async getOAuthEmail(): Promise<string | null> {
    return this.oauthManager.getEmail();
  }

  startAuthorizationFlow(): string {
    return this.oauthManager.startAuthorizationFlow();
  }

  waitForCallback(): Promise<CodexCredentials> {
    return this.oauthManager.waitForCallback();
  }
}

export const openAiCodexAuthManager = new OpenAiCodexAuthManager();
