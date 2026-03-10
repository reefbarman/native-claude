/**
 * CodexOAuthManager — OAuth2 Authorization Code + PKCE flow for OpenAI Codex.
 *
 * Authenticates via ChatGPT Plus/Pro subscription. Uses the same public PKCE
 * client and endpoints as other Codex-enabled tools.
 *
 * Flow: Generate PKCE verifier+challenge → open browser → local HTTP server
 * on port 1455 → exchange code for tokens → parse JWT for chatgpt_account_id
 * → store in VS Code SecretStorage.
 */

import * as crypto from "crypto";
import * as http from "http";
import { URL } from "url";
import type { ExtensionContext } from "vscode";

// ── OAuth Configuration ──

const OAUTH_CONFIG = {
  authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
  tokenEndpoint: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectUri: "http://localhost:1455/auth/callback",
  scopes: "openid profile email offline_access",
  callbackPort: 1455,
} as const;

const CREDENTIALS_STORAGE_KEY = "codex-oauth-credentials";

/** 5-minute buffer before expiry to trigger proactive refresh. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// ── Types ──

export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  /** Expiry time in ms since epoch. */
  expiresAt: number;
  email?: string;
  /** ChatGPT account ID — required for the `ChatGPT-Account-Id` header. */
  accountId?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  email?: string;
}

interface JwtClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

// ── PKCE Helpers ──

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return crypto.randomBytes(16).toString("hex");
}

// ── JWT Parsing ──

function parseJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload) as JwtClaims;
  } catch {
    return undefined;
  }
}

function extractAccountId(tokens: {
  idToken?: string;
  accessToken: string;
}): string | undefined {
  for (const token of [tokens.idToken, tokens.accessToken]) {
    if (!token) continue;
    const claims = parseJwtClaims(token);
    if (!claims) continue;
    const id =
      claims.chatgpt_account_id ??
      claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
      claims.organizations?.[0]?.id;
    if (id) return id;
  }
  return undefined;
}

// ── Token Exchange ──

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<CodexCredentials> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OAUTH_CONFIG.clientId,
    code,
    redirect_uri: OAUTH_CONFIG.redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Token exchange failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const data = (await response.json()) as TokenResponse;
  if (!data.access_token)
    throw new Error("Token response missing access_token");
  if (!data.refresh_token)
    throw new Error("Token response missing refresh_token");

  const accountId = extractAccountId({
    idToken: data.id_token,
    accessToken: data.access_token,
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    email: data.email,
    accountId,
  };
}

async function refreshAccessToken(
  credentials: CodexCredentials,
): Promise<CodexCredentials> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OAUTH_CONFIG.clientId,
    refresh_token: credentials.refreshToken,
  });

  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const isInvalidGrant =
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403
        ? /invalid_grant|revoked|expired|invalid refresh/i.test(errorText)
        : false;
    const err = new Error(
      `Token refresh failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
    (err as Error & { isInvalidGrant: boolean }).isInvalidGrant =
      isInvalidGrant;
    throw err;
  }

  const data = (await response.json()) as TokenResponse;

  const accountId = extractAccountId({
    idToken: data.id_token,
    accessToken: data.access_token,
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? credentials.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    email: data.email ?? credentials.email,
    accountId: accountId ?? credentials.accountId,
  };
}

function isTokenExpired(credentials: CodexCredentials): boolean {
  return Date.now() >= credentials.expiresAt - EXPIRY_BUFFER_MS;
}

// ── OAuth Manager ──

export class CodexOAuthManager {
  private context: ExtensionContext | null = null;
  private credentials: CodexCredentials | null = null;
  private refreshPromise: Promise<CodexCredentials> | null = null;
  private log: (msg: string) => void;
  private pendingAuth: {
    codeVerifier: string;
    state: string;
    server?: http.Server;
  } | null = null;

  /** Fired after sign-in, sign-out, or credential clear so the extension can re-send model updates. */
  onAuthStateChanged?: () => void;

  constructor(log?: (msg: string) => void) {
    this.log = log ?? console.log;
  }

  /** Must be called during extension activation to enable credential storage. */
  initialize(context: ExtensionContext): void {
    this.context = context;
  }

  // ── Credential Storage ──

  private async loadCredentials(): Promise<CodexCredentials | null> {
    if (!this.context) return null;
    try {
      const json = await this.context.secrets.get(CREDENTIALS_STORAGE_KEY);
      if (!json) return null;
      this.credentials = JSON.parse(json) as CodexCredentials;
      return this.credentials;
    } catch (err) {
      this.log(
        `[codex-oauth] Failed to load credentials: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  private async saveCredentials(creds: CodexCredentials): Promise<void> {
    if (!this.context) throw new Error("CodexOAuthManager not initialized");
    await this.context.secrets.store(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify(creds),
    );
    this.credentials = creds;
  }

  async clearCredentials(): Promise<void> {
    if (!this.context) return;
    await this.context.secrets.delete(CREDENTIALS_STORAGE_KEY);
    this.credentials = null;
    this.onAuthStateChanged?.();
  }

  // ── Token Access ──

  /**
   * Get a valid access token, refreshing automatically if expired.
   * Returns null if not authenticated.
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.credentials) {
      await this.loadCredentials();
    }
    if (!this.credentials) return null;

    if (isTokenExpired(this.credentials)) {
      try {
        if (!this.refreshPromise) {
          this.log(
            `[codex-oauth] Token expired (expiresAt=${this.credentials.expiresAt}), refreshing...`,
          );
          this.refreshPromise = refreshAccessToken(this.credentials);
        }
        const newCreds = await this.refreshPromise;
        this.refreshPromise = null;
        await this.saveCredentials(newCreds);
        this.log(
          `[codex-oauth] Token refreshed (expiresIn≈${Math.round((newCreds.expiresAt - Date.now()) / 1000)}s)`,
        );
      } catch (err) {
        this.refreshPromise = null;
        this.log(
          `[codex-oauth] Token refresh failed: ${err instanceof Error ? err.message : err}`,
        );
        if (
          err &&
          typeof err === "object" &&
          "isInvalidGrant" in err &&
          (err as { isInvalidGrant: boolean }).isInvalidGrant
        ) {
          this.log("[codex-oauth] Refresh token invalid, clearing credentials");
          await this.clearCredentials();
        }
        return null;
      }
    }

    return this.credentials.accessToken;
  }

  /**
   * Force-refresh even if token hasn't expired (e.g. after a 401).
   * Returns new access token or null.
   */
  async forceRefreshAccessToken(): Promise<string | null> {
    if (!this.credentials) await this.loadCredentials();
    if (!this.credentials) return null;

    try {
      if (!this.refreshPromise) {
        this.log("[codex-oauth] Force-refreshing token...");
        this.refreshPromise = refreshAccessToken(this.credentials);
      }
      const newCreds = await this.refreshPromise;
      this.refreshPromise = null;
      await this.saveCredentials(newCreds);
      this.log("[codex-oauth] Force refresh succeeded");
      return newCreds.accessToken;
    } catch (err) {
      this.refreshPromise = null;
      this.log(
        `[codex-oauth] Force refresh failed: ${err instanceof Error ? err.message : err}`,
      );
      if (
        err &&
        typeof err === "object" &&
        "isInvalidGrant" in err &&
        (err as { isInvalidGrant: boolean }).isInvalidGrant
      ) {
        await this.clearCredentials();
      }
      return null;
    }
  }

  /** Get the ChatGPT account ID (for the `ChatGPT-Account-Id` header). */
  async getAccountId(): Promise<string | null> {
    if (!this.credentials) await this.loadCredentials();
    return this.credentials?.accountId ?? null;
  }

  /** Get the authenticated user's email. */
  async getEmail(): Promise<string | null> {
    if (!this.credentials) await this.loadCredentials();
    return this.credentials?.email ?? null;
  }

  async isAuthenticated(): Promise<boolean> {
    const token = await this.getAccessToken();
    return token !== null;
  }

  // ── OAuth Authorization Flow ──

  /**
   * Start the OAuth flow. Returns the authorization URL to open in the browser.
   * After calling this, call `waitForCallback()` to await the redirect.
   */
  startAuthorizationFlow(): string {
    this.cancelAuthorizationFlow();

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    this.pendingAuth = { codeVerifier, state };

    const params = new URLSearchParams({
      client_id: OAUTH_CONFIG.clientId,
      redirect_uri: OAUTH_CONFIG.redirectUri,
      scope: OAUTH_CONFIG.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      response_type: "code",
      state,
      codex_cli_simplified_flow: "true",
      originator: "agentlink",
    });

    return `${OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`;
  }

  /**
   * Start a local HTTP server to receive the OAuth callback.
   * Resolves when authentication completes successfully.
   */
  async waitForCallback(): Promise<CodexCredentials> {
    if (!this.pendingAuth) {
      throw new Error(
        "No pending authorization flow — call startAuthorizationFlow() first",
      );
    }

    // Close any leftover server
    if (this.pendingAuth.server) {
      try {
        this.pendingAuth.server.close();
      } catch {
        /* ignore */
      }
      this.pendingAuth.server = undefined;
    }

    return new Promise<CodexCredentials>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(
            req.url ?? "",
            `http://localhost:${OAUTH_CONFIG.callbackPort}`,
          );

          if (url.pathname !== "/auth/callback") {
            res.writeHead(404);
            res.end("Not Found");
            return;
          }

          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");

          if (error) {
            res.writeHead(400);
            res.end(`Authentication failed: ${error}`);
            reject(new Error(`OAuth error: ${error}`));
            server.close();
            return;
          }

          if (!code || !state) {
            res.writeHead(400);
            res.end("Missing code or state parameter");
            reject(new Error("Missing code or state parameter"));
            server.close();
            return;
          }

          if (state !== this.pendingAuth?.state) {
            res.writeHead(400);
            res.end("State mismatch — possible CSRF attack");
            reject(new Error("State mismatch"));
            server.close();
            return;
          }

          try {
            const credentials = await exchangeCodeForTokens(
              code,
              this.pendingAuth.codeVerifier,
            );
            await this.saveCredentials(credentials);

            res.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
            });
            res.end(successHtml());

            this.pendingAuth = null;
            server.close();
            this.onAuthStateChanged?.();
            resolve(credentials);
          } catch (exchangeErr) {
            res.writeHead(500);
            res.end(`Token exchange failed: ${exchangeErr}`);
            reject(exchangeErr);
            server.close();
          }
        } catch (err) {
          res.writeHead(500);
          res.end("Internal server error");
          reject(err);
          server.close();
        }
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        this.pendingAuth = null;
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `Port ${OAUTH_CONFIG.callbackPort} is already in use. ` +
                `Please close any other applications using this port (e.g. Roo Code, Codex CLI) and try again.`,
            ),
          );
        } else {
          reject(err);
        }
      });

      // 5-minute timeout for the user to complete the browser flow
      const timeout = setTimeout(
        () => {
          server.close();
          reject(new Error("Authentication timed out after 5 minutes"));
        },
        5 * 60 * 1000,
      );

      server.listen(OAUTH_CONFIG.callbackPort, () => {
        if (this.pendingAuth) {
          this.pendingAuth.server = server;
        }
      });

      server.on("close", () => clearTimeout(timeout));
    });
  }

  /** Cancel any in-progress authorization flow. */
  cancelAuthorizationFlow(): void {
    if (this.pendingAuth?.server) {
      this.pendingAuth.server.close();
    }
    this.pendingAuth = null;
  }
}

function successHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Authentication Successful</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    margin: 0;
    background: linear-gradient(135deg, #4EC9B0 0%, #3ba892 100%);
    color: white;
  }
  .container { text-align: center; padding: 2rem; }
  h1 { font-size: 2rem; margin-bottom: 1rem; }
  p { opacity: 0.9; }
</style>
</head>
<body>
<div class="container">
<h1>&#10003; Authentication Successful</h1>
<p>You can close this window and return to VS Code.</p>
</div>
<script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`;
}

/** Singleton instance. */
export const codexOAuthManager = new CodexOAuthManager();
