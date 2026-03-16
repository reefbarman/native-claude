import { beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAiCodexAuthManager } from "./OpenAiCodexAuthManager.js";

describe("OpenAiCodexAuthManager", () => {
  const oauthManager = {
    onAuthStateChanged: undefined as (() => void) | undefined,
    initialize: vi.fn(),
    isAuthenticated: vi.fn(),
    getAccessToken: vi.fn(),
    getAccountId: vi.fn(),
    getEmail: vi.fn(),
    forceRefreshAccessToken: vi.fn(),
    clearCredentials: vi.fn(),
    startAuthorizationFlow: vi.fn(),
    waitForCallback: vi.fn(),
  };

  const context = {
    secrets: {
      get: vi.fn(),
      store: vi.fn(),
      delete: vi.fn(),
    },
  } as any;

  let manager: OpenAiCodexAuthManager;

  beforeEach(() => {
    vi.clearAllMocks();
    oauthManager.getAccessToken.mockResolvedValue(null);
    oauthManager.getAccountId.mockResolvedValue(null);
    oauthManager.forceRefreshAccessToken.mockResolvedValue(null);
    context.secrets.get.mockResolvedValue(undefined);
    manager = new OpenAiCodexAuthManager(oauthManager as any);
    manager.initialize(context);
  });

  it("prefers OAuth over API key when both are available", async () => {
    oauthManager.isAuthenticated.mockResolvedValue(true);
    oauthManager.getAccessToken.mockResolvedValue("oauth-token");
    oauthManager.getAccountId.mockResolvedValue("acct-123");
    context.secrets.get.mockResolvedValue("api-key");

    const auth = await manager.resolveModelAuth();

    expect(auth).toEqual({
      method: "oauth",
      bearerToken: "oauth-token",
      accountId: "acct-123",
      canRefresh: true,
    });
  });

  it("falls back to API key when no OAuth session is configured", async () => {
    oauthManager.isAuthenticated.mockResolvedValue(false);
    context.secrets.get.mockResolvedValue("api-key");

    const auth = await manager.resolveEmbeddingAuth();

    expect(auth).toEqual({
      method: "apiKey",
      bearerToken: "api-key",
      canRefresh: false,
    });
  });

  it("does not silently fall back to API key when OAuth is configured but unavailable", async () => {
    oauthManager.isAuthenticated.mockResolvedValue(true);
    context.secrets.get.mockResolvedValue("api-key");

    const auth = await manager.resolveEmbeddingAuth();

    expect(auth).toBeNull();
  });

  it("refreshes OAuth auth when forced for oauth method", async () => {
    oauthManager.forceRefreshAccessToken.mockResolvedValue("refreshed-token");
    oauthManager.getAccountId.mockResolvedValue("acct-456");

    const auth = await manager.forceRefreshModelAuth("oauth");

    expect(auth).toEqual({
      method: "oauth",
      bearerToken: "refreshed-token",
      accountId: "acct-456",
      canRefresh: true,
    });
  });
});
