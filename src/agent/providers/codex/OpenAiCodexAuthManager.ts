import * as vscode from "vscode";

import {
  CodexOAuthManager,
  type CodexCredentials,
  type CodexOAuthAccountInfo,
  type SaveOAuthAccountOptions,
} from "./CodexOAuthManager.js";

const OPENAI_API_KEY_SECRET = "openaiApiKey";
const OPENAI_API_KEY_SCOPE = "openaiApiKeyScope";

export type OpenAiApiKeyScope = "models+embeddings" | "embeddings-only";

export type OpenAiCodexAuthMethod = "oauth" | "apiKey";

export interface OpenAiApiKeyCredential {
  apiKey: string;
  source: "secret" | "env";
  scope: OpenAiApiKeyScope;
}

export interface OpenAiCodexResolvedAuth {
  method: OpenAiCodexAuthMethod;
  bearerToken: string;
  /** ChatGPT account header value for Codex OAuth endpoint. */
  accountId?: string;
  /** Local OAuth pool account identity. */
  oauthAccountPoolId?: string;
  oauthAccountLabel?: string;
  oauthAccountEmail?: string;
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
    return this.oauthManager.hasAccounts();
  }

  async hasApiKey(scope: "any" | OpenAiApiKeyScope = "any"): Promise<boolean> {
    const key = await this.getApiKeyCredential();
    if (!key?.apiKey) return false;
    if (scope === "any") return true;
    return key.scope === scope || key.scope === "models+embeddings";
  }

  async getPreferredAuthMethod(): Promise<OpenAiCodexAuthMethod | null> {
    if (await this.hasOAuth()) return "oauth";
    if (await this.hasApiKey("models+embeddings")) return "apiKey";
    return null;
  }

  private buildOAuthResolvedAuth(
    account: CodexOAuthAccountInfo,
    bearerToken: string,
  ): OpenAiCodexResolvedAuth {
    return {
      method: "oauth",
      bearerToken,
      accountId: account.chatgptAccountId ?? undefined,
      oauthAccountPoolId: account.id,
      oauthAccountLabel: account.label,
      oauthAccountEmail: account.email,
      canRefresh: true,
    };
  }

  async resolveModelAuth(): Promise<OpenAiCodexResolvedAuth | null> {
    const active = await this.oauthManager.getActiveAccount();
    if (active) {
      const accessToken = await this.oauthManager.getAccessTokenByAccountId(
        active.id,
      );
      if (accessToken) {
        const refreshedActive =
          (await this.oauthManager.getAccountById(active.id)) ?? active;
        return this.buildOAuthResolvedAuth(refreshedActive, accessToken);
      }
    }

    const apiKeyCred = await this.getApiKeyCredential();
    if (apiKeyCred?.scope === "models+embeddings") {
      return {
        method: "apiKey",
        bearerToken: apiKeyCred.apiKey,
        canRefresh: false,
      };
    }

    return null;
  }

  async resolveEmbeddingAuth(): Promise<OpenAiCodexResolvedAuth | null> {
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

  async forceRefreshModelAuth(
    previousMethod: OpenAiCodexAuthMethod,
    options?: { oauthAccountPoolId?: string },
  ): Promise<OpenAiCodexResolvedAuth | null> {
    if (previousMethod === "oauth") {
      const accountId = options?.oauthAccountPoolId;
      let refreshedToken: string | null = null;
      let account: CodexOAuthAccountInfo | null = null;

      if (accountId) {
        refreshedToken =
          await this.oauthManager.forceRefreshAccessTokenByAccountId(accountId);
        account = refreshedToken
          ? await this.oauthManager.getAccountById(accountId)
          : null;
      } else {
        const active = await this.oauthManager.getActiveAccount();
        if (!active) {
          return null;
        }
        refreshedToken =
          await this.oauthManager.forceRefreshAccessTokenByAccountId(active.id);
        account = refreshedToken
          ? ((await this.oauthManager.getAccountById(active.id)) ?? active)
          : null;
      }

      if (!refreshedToken || !account) {
        return null;
      }

      return this.buildOAuthResolvedAuth(account, refreshedToken);
    }

    const apiKeyCred = await this.getApiKeyCredential();
    if (apiKeyCred?.scope !== "models+embeddings") {
      return null;
    }
    return {
      method: "apiKey",
      bearerToken: apiKeyCred.apiKey,
      canRefresh: false,
    };
  }

  async resolveModelAuthForOAuthAccount(
    accountId: string,
  ): Promise<OpenAiCodexResolvedAuth | null> {
    const account = await this.oauthManager.getAccountById(accountId);
    if (!account) return null;
    const accessToken =
      await this.oauthManager.getAccessTokenByAccountId(accountId);
    if (!accessToken) return null;
    const refreshedAccount =
      (await this.oauthManager.getAccountById(accountId)) ?? account;
    return this.buildOAuthResolvedAuth(refreshedAccount, accessToken);
  }

  async listOAuthAccounts(): Promise<CodexOAuthAccountInfo[]> {
    return this.oauthManager.listAccounts();
  }

  async getActiveOAuthAccount(): Promise<CodexOAuthAccountInfo | null> {
    return this.oauthManager.getActiveAccount();
  }

  async setActiveOAuthAccount(
    accountId: string,
  ): Promise<CodexOAuthAccountInfo | null> {
    return this.oauthManager.setActiveAccount(accountId, { notify: true });
  }

  async removeOAuthAccount(accountId: string): Promise<boolean> {
    return this.oauthManager.removeAccount(accountId);
  }

  async updateOAuthAccountLabel(
    accountId: string,
    label: string,
  ): Promise<CodexOAuthAccountInfo | null> {
    return this.oauthManager.updateAccountLabel(accountId, label);
  }

  async saveOAuthCredentials(
    credentials: CodexCredentials,
    options?: SaveOAuthAccountOptions,
  ): Promise<{
    account: CodexOAuthAccountInfo;
    action: "added" | "updated" | "replaced";
  }> {
    return this.oauthManager.saveOAuthAccount(credentials, options);
  }

  async markOAuthUsageLimit(accountId: string): Promise<void> {
    await this.oauthManager.markUsageLimit(accountId);
  }

  async getOAuthRoundRobinAccountIds(
    startAfterAccountId?: string,
  ): Promise<string[]> {
    return this.oauthManager.getRoundRobinAccountIds(startAfterAccountId);
  }

  async getApiKeyCredential(): Promise<OpenAiApiKeyCredential | null> {
    const secretKey = await this.context?.secrets.get(OPENAI_API_KEY_SECRET);
    if (secretKey?.trim()) {
      const storedScope =
        this.context?.globalState.get<OpenAiApiKeyScope>(
          OPENAI_API_KEY_SCOPE,
        ) ?? "models+embeddings";
      return {
        apiKey: secretKey.trim(),
        source: "secret",
        scope: storedScope,
      };
    }

    const envKey = process.env.OPENAI_API_KEY?.trim();
    if (envKey) {
      return {
        apiKey: envKey,
        source: "env",
        scope: "models+embeddings",
      };
    }

    return null;
  }

  async storeApiKey(
    apiKey: string,
    scope: OpenAiApiKeyScope = "models+embeddings",
  ): Promise<void> {
    if (!this.context) {
      throw new Error("OpenAiCodexAuthManager not initialized");
    }

    const normalizedApiKey = apiKey.trim();
    const existingSecretKey = await this.context.secrets.get(
      OPENAI_API_KEY_SECRET,
    );
    const existingScope =
      this.context.globalState.get<OpenAiApiKeyScope>(OPENAI_API_KEY_SCOPE);

    const sameStoredKey = existingSecretKey?.trim() === normalizedApiKey;
    const resolvedScope: OpenAiApiKeyScope =
      sameStoredKey && existingScope === "models+embeddings"
        ? "models+embeddings"
        : scope;

    await this.context.secrets.store(OPENAI_API_KEY_SECRET, normalizedApiKey);
    await this.context.globalState.update(OPENAI_API_KEY_SCOPE, resolvedScope);
    this.onAuthStateChanged?.();
  }

  async clearApiKey(): Promise<void> {
    if (!this.context) return;
    await this.context.secrets.delete(OPENAI_API_KEY_SECRET);
    await this.context.globalState.update(OPENAI_API_KEY_SCOPE, undefined);
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
