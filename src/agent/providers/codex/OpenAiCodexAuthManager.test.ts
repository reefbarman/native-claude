import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexCredentials } from "./CodexOAuthManager.js";

import {
  OpenAiCodexAuthManager,
  type OpenAiApiKeyCredential,
} from "./OpenAiCodexAuthManager.js";

describe("OpenAiCodexAuthManager", () => {
  const oauthManager = {
    onAuthStateChanged: undefined as (() => void) | undefined,
    initialize: vi.fn(),
    isAuthenticated: vi.fn(),
    hasAccounts: vi.fn(),
    getAccessToken: vi.fn(),
    getAccessTokenByAccountId: vi.fn(),
    getAccountId: vi.fn(),
    getEmail: vi.fn(),
    getActiveAccount: vi.fn(),
    getAccountById: vi.fn(),
    resolveModelAuthForOAuthAccount: vi.fn(),
    forceRefreshAccessToken: vi.fn(),
    forceRefreshAccessTokenByAccountId: vi.fn(),
    clearCredentials: vi.fn(),
    startAuthorizationFlow: vi.fn(),
    waitForCallback: vi.fn(),
    listAccounts: vi.fn(),
    setActiveAccount: vi.fn(),
    removeAccount: vi.fn(),
    updateAccountLabel: vi.fn(),
    saveOAuthAccount: vi.fn(),
    markUsageLimit: vi.fn(),
    getRoundRobinAccountIds: vi.fn(),
  };

  const context = {
    secrets: {
      get: vi.fn(),
      store: vi.fn(),
      delete: vi.fn(),
    },
    globalState: {
      get: vi.fn(),
      update: vi.fn(),
    },
  } as any;

  let manager: OpenAiCodexAuthManager;

  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    oauthManager.hasAccounts.mockResolvedValue(false);
    oauthManager.getActiveAccount.mockResolvedValue(null);
    oauthManager.getAccessToken.mockResolvedValue(null);
    oauthManager.getAccessTokenByAccountId.mockResolvedValue(null);
    oauthManager.getAccountId.mockResolvedValue(null);
    oauthManager.getAccountById.mockResolvedValue(null);
    oauthManager.forceRefreshAccessToken.mockResolvedValue(null);
    oauthManager.forceRefreshAccessTokenByAccountId.mockResolvedValue(null);
    oauthManager.getRoundRobinAccountIds.mockResolvedValue([]);
    oauthManager.listAccounts.mockResolvedValue([]);
    oauthManager.setActiveAccount.mockResolvedValue(null);
    oauthManager.removeAccount.mockResolvedValue(false);
    oauthManager.updateAccountLabel.mockResolvedValue(null);
    oauthManager.saveOAuthAccount.mockResolvedValue(null);
    oauthManager.removeAccount.mockResolvedValue(false);
    context.secrets.get.mockResolvedValue(undefined);
    context.globalState.get.mockReturnValue(undefined);
    context.globalState.update.mockResolvedValue(undefined);
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
    manager = new OpenAiCodexAuthManager(oauthManager as any);
    manager.initialize(context);
  });

  it("prefers OAuth over API key when both are available", async () => {
    oauthManager.hasAccounts.mockResolvedValue(true);
    oauthManager.getActiveAccount.mockResolvedValue({
      id: "oauth-1",
      label: "acct@example.com",
      email: "acct@example.com",
      chatgptAccountId: "acct-123",
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    oauthManager.getAccessTokenByAccountId.mockResolvedValue("oauth-token");
    oauthManager.getAccountById.mockResolvedValue({
      id: "oauth-1",
      label: "acct@example.com",
      email: "acct@example.com",
      chatgptAccountId: "acct-123",
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    context.secrets.get.mockResolvedValue("api-key");

    const auth = await manager.resolveModelAuth();

    expect(auth).toEqual({
      method: "oauth",
      bearerToken: "oauth-token",
      accountId: "acct-123",
      oauthAccountPoolId: "oauth-1",
      oauthAccountLabel: "acct@example.com",
      oauthAccountEmail: "acct@example.com",
      canRefresh: true,
    });
  });

  it("uses API key for embeddings when no OAuth session is configured", async () => {
    oauthManager.hasAccounts.mockResolvedValue(false);
    context.secrets.get.mockResolvedValue("api-key");

    const auth = await manager.resolveEmbeddingAuth();

    expect(auth).toEqual({
      method: "apiKey",
      bearerToken: "api-key",
      canRefresh: false,
    });
  });

  it("does not use embeddings-only API key for model auth", async () => {
    oauthManager.hasAccounts.mockResolvedValue(false);
    context.secrets.get.mockResolvedValue("api-key");
    context.globalState.get.mockReturnValue("embeddings-only");

    const auth = await manager.resolveModelAuth();

    expect(auth).toBeNull();
  });

  it("uses legacy stored API key for model auth when scope is missing", async () => {
    oauthManager.hasAccounts.mockResolvedValue(false);
    context.secrets.get.mockResolvedValue("api-key");
    context.globalState.get.mockReturnValue(undefined);

    const auth = await manager.resolveModelAuth();

    expect(auth).toEqual({
      method: "apiKey",
      bearerToken: "api-key",
      canRefresh: false,
    });
  });

  it("returns null embedding auth when no API key is configured", async () => {
    context.secrets.get.mockResolvedValue(undefined);

    const auth = await manager.resolveEmbeddingAuth();

    expect(auth).toBeNull();
  });

  it("uses API key for embeddings even when OAuth is configured", async () => {
    oauthManager.hasAccounts.mockResolvedValue(true);
    context.secrets.get.mockResolvedValue("api-key");

    const auth = await manager.resolveEmbeddingAuth();

    expect(auth).toEqual({
      method: "apiKey",
      bearerToken: "api-key",
      canRefresh: false,
    });
  });

  it("stores API key with explicit scope", async () => {
    await manager.storeApiKey("api-key", "embeddings-only");

    expect(context.secrets.store).toHaveBeenCalledWith(
      "openaiApiKey",
      "api-key",
    );
    expect(context.globalState.update).toHaveBeenCalledWith(
      "openaiApiKeyScope",
      "embeddings-only",
    );
  });

  it("keeps models+embeddings scope when re-saving the same key as embeddings-only", async () => {
    context.secrets.get.mockResolvedValue("api-key");
    context.globalState.get.mockReturnValue("models+embeddings");

    await manager.storeApiKey("api-key", "embeddings-only");

    expect(context.globalState.update).toHaveBeenCalledWith(
      "openaiApiKeyScope",
      "models+embeddings",
    );
  });

  it("allows switching to embeddings-only when saving a different key", async () => {
    context.secrets.get.mockResolvedValue("old-key");
    context.globalState.get.mockReturnValue("models+embeddings");

    await manager.storeApiKey("new-key", "embeddings-only");

    expect(context.globalState.update).toHaveBeenCalledWith(
      "openaiApiKeyScope",
      "embeddings-only",
    );

    context.secrets.get.mockResolvedValue("new-key");
    context.globalState.get.mockReturnValue("embeddings-only");
    oauthManager.hasAccounts.mockResolvedValue(false);

    const modelAuth = await manager.resolveModelAuth();
    expect(modelAuth).toBeNull();

    const embeddingAuth = await manager.resolveEmbeddingAuth();
    expect(embeddingAuth).toEqual({
      method: "apiKey",
      bearerToken: "new-key",
      canRefresh: false,
    });
  });

  it("returns null when force-refreshing apiKey model auth with embeddings-only scope", async () => {
    context.secrets.get.mockResolvedValue("api-key");
    context.globalState.get.mockReturnValue("embeddings-only");

    const auth = await manager.forceRefreshModelAuth("apiKey");

    expect(auth).toBeNull();
  });

  it("reads OPENAI_API_KEY env key with models+embeddings scope", async () => {
    context.secrets.get.mockResolvedValue(undefined);
    process.env.OPENAI_API_KEY = "env-key";

    const cred =
      (await manager.getApiKeyCredential()) as OpenAiApiKeyCredential | null;

    expect(cred).toEqual({
      apiKey: "env-key",
      source: "env",
      scope: "models+embeddings",
    });
  });

  it("refreshes OAuth auth when forced for oauth method", async () => {
    oauthManager.getActiveAccount.mockResolvedValue({
      id: "oauth-1",
      label: "acct@example.com",
      email: "acct@example.com",
      chatgptAccountId: "acct-456",
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    oauthManager.forceRefreshAccessTokenByAccountId.mockResolvedValue(
      "refreshed-token",
    );
    oauthManager.getAccountById.mockResolvedValue({
      id: "oauth-1",
      label: "acct@example.com",
      email: "acct@example.com",
      chatgptAccountId: "acct-456",
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const auth = await manager.forceRefreshModelAuth("oauth");

    expect(auth).toEqual({
      method: "oauth",
      bearerToken: "refreshed-token",
      accountId: "acct-456",
      oauthAccountPoolId: "oauth-1",
      oauthAccountLabel: "acct@example.com",
      oauthAccountEmail: "acct@example.com",
      canRefresh: true,
    });
  });

  it("delegates saveOAuthCredentials to oauth manager", async () => {
    const creds: CodexCredentials = {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 60_000,
      accountId: "acct-1",
      email: "acct@example.com",
    };
    oauthManager.saveOAuthAccount.mockResolvedValue({
      action: "added",
      account: {
        id: "oauth-1",
        label: "acct@example.com",
        email: "acct@example.com",
        chatgptAccountId: "acct-1",
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    const result = await manager.saveOAuthCredentials(creds, {
      replaceAccountId: "oauth-1",
      makeActive: true,
      label: "Account",
    });

    expect(oauthManager.saveOAuthAccount).toHaveBeenCalledWith(creds, {
      replaceAccountId: "oauth-1",
      makeActive: true,
      label: "Account",
    });
    expect(result?.action).toBe("added");
  });

  it("delegates removeOAuthAccount to oauth manager", async () => {
    oauthManager.removeAccount.mockResolvedValue(true);

    const removed = await manager.removeOAuthAccount("oauth-1");

    expect(oauthManager.removeAccount).toHaveBeenCalledWith("oauth-1");
    expect(removed).toBe(true);
  });
});
