import * as vscode from "vscode";
import * as http from "http";
import * as net from "net";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export class McpOAuthError extends Error {
  constructor(
    public readonly kind:
      | "callback_timeout"
      | "callback_missing_code"
      | "authorization_error"
      | "stale_client_redirect",
    message: string,
  ) {
    super(message);
    this.name = "McpOAuthError";
  }
}

function storageKey(serverName: string, suffix: string): string {
  return `mcp_oauth_${serverName}_${suffix}`;
}

/**
 * OAuthClientProvider implementation for MCP HTTP servers.
 *
 * Flow:
 * 1. `start()` binds a local HTTP server for the redirect URI, preferring the
 *    previously registered localhost callback port when available and falling back
 *    to an OS-assigned ephemeral port otherwise.
 * 2. When the MCP transport gets a 401, the SDK calls `auth()` which in turn calls
 *    `redirectToAuthorization()`.  Our async implementation opens a browser and
 *    awaits the OAuth callback before returning, so by the time it resolves the
 *    tokens are already saved and the SDK can retry the connection.
 */
interface OAuthCallbackResult {
  url: URL;
  oauthError?: string;
  oauthErrorDescription?: string;
  hasCode: boolean;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private _port = 0;
  private _server: http.Server | null = null;
  private _codeVerifier = "";
  onLog?: (message: string) => void;
  onBeforeAuthorizationOpen?: () => boolean | Promise<boolean>;

  private tokenSummary(tokens: OAuthTokens | undefined): string {
    if (!tokens) return "none";
    return JSON.stringify({
      hasAccessToken: Boolean(tokens.access_token),
      hasRefreshToken: Boolean(tokens.refresh_token),
      tokenType: tokens.token_type ?? null,
      expiresIn: tokens.expires_in ?? null,
      scope: tokens.scope ?? null,
    });
  }

  private clientSummary(info: OAuthClientInformationMixed | undefined): string {
    if (!info) return "none";
    return JSON.stringify({
      clientId:
        "client_id" in info && typeof info.client_id === "string"
          ? info.client_id
          : null,
      hasClientSecret: "client_secret" in info && Boolean(info.client_secret),
      redirectUris:
        "redirect_uris" in info && Array.isArray(info.redirect_uris)
          ? info.redirect_uris
          : null,
    });
  }

  async debugStateSnapshot(label: string): Promise<void> {
    const [clientInfo, tokens] = await Promise.all([
      this.storage.get<OAuthClientInformationMixed>(
        storageKey(this.serverName, "client"),
      ),
      this.storage.get<OAuthTokens>(storageKey(this.serverName, "tokens")),
    ]);
    this.onLog?.(
      `[mcp:${this.serverName}] oauth state ${label} redirectUrl=${this.redirectUrl} codeVerifierSet=${Boolean(this._codeVerifier)} client=${this.clientSummary(clientInfo)} tokens=${this.tokenSummary(tokens)}`,
    );
  }

  constructor(
    private readonly serverName: string,
    private readonly serverUrl: string,
    private readonly storage: vscode.Memento,
  ) {}

  private preferredCallbackPort(
    info: OAuthClientInformationMixed | undefined,
  ): number | undefined {
    const redirectUris = this.redirectUrisForClient(info);
    if (!redirectUris) return undefined;

    for (const redirectUri of redirectUris) {
      try {
        const parsed = new URL(redirectUri);
        if (parsed.protocol !== "http:") continue;
        if (
          parsed.hostname !== "localhost" &&
          parsed.hostname !== "127.0.0.1" &&
          parsed.hostname !== "::1"
        ) {
          continue;
        }

        const port = Number(parsed.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
        return port;
      } catch {
        // ignore malformed cached URIs
      }
    }

    return undefined;
  }

  private async listenOnPort(port: number): Promise<void> {
    if (!this._server) return;

    await new Promise<void>((resolve, reject) => {
      const server = this._server!;
      const onError = (err: Error): void => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off("error", onError);
        this._port = (server.address() as net.AddressInfo).port;
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "localhost");
    });
  }

  /** Start the local callback HTTP server and capture the assigned port. */
  async start(): Promise<void> {
    if (this._server) return;

    const clientInfo = this.storage.get<OAuthClientInformationMixed>(
      storageKey(this.serverName, "client"),
    );
    const preferredPort = this.preferredCallbackPort(clientInfo);

    this._server = http.createServer();

    try {
      if (preferredPort) {
        try {
          await this.listenOnPort(preferredPort);
          this.onLog?.(
            `[mcp:${this.serverName}] callback server bound to preferred cached redirect port ${preferredPort}`,
          );
          return;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          this.onLog?.(
            `[mcp:${this.serverName}] preferred cached redirect port ${preferredPort} unavailable (${code ?? "unknown"}); falling back to ephemeral callback port`,
          );
        }
      }

      await this.listenOnPort(0);
      this.onLog?.(
        `[mcp:${this.serverName}] callback server bound to port ${this._port}${preferredPort ? ` (fallback from preferred ${preferredPort})` : ""}`,
      );
    } catch (err) {
      this._server?.close();
      this._server = null;
      this._port = 0;
      throw err;
    }
  }

  /** Stop the callback server. */
  stop(): void {
    this._server?.close();
    this._server = null;
    this._port = 0;
  }

  // ── OAuthClientProvider interface ──────────────────────────────────────

  get redirectUrl(): string {
    return `http://localhost:${this._port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "AgentLink",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  private redirectUrisForClient(
    info: OAuthClientInformationMixed | undefined,
  ): string[] | undefined {
    return info && "redirect_uris" in info && Array.isArray(info.redirect_uris)
      ? info.redirect_uris
      : undefined;
  }

  private hasRedirectUriMismatch(
    info: OAuthClientInformationMixed | undefined,
  ): boolean {
    const redirectUris = this.redirectUrisForClient(info);
    return Boolean(redirectUris && !redirectUris.includes(this.redirectUrl));
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const info = this.storage.get<OAuthClientInformationMixed>(
      storageKey(this.serverName, "client"),
    );

    const redirectUris = this.redirectUrisForClient(info);
    if (redirectUris && !redirectUris.includes(this.redirectUrl)) {
      this.onLog?.(
        `[mcp:${this.serverName}] cached client redirect URIs do not include current redirectUrl; keeping cached client to allow refresh-token flow first current=${this.redirectUrl} cached=${JSON.stringify(redirectUris)}`,
      );
    }

    return info;
  }

  async saveClientInformation(
    info: OAuthClientInformationMixed,
  ): Promise<void> {
    this.onLog?.(
      `[mcp:${this.serverName}] saveClientInformation() ${this.clientSummary(info)}`,
    );
    await this.storage.update(storageKey(this.serverName, "client"), info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.storage.get<OAuthTokens>(storageKey(this.serverName, "tokens"));
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.onLog?.(
      `[mcp:${this.serverName}] saveTokens() ${this.tokenSummary(tokens)}`,
    );
    await this.storage.update(storageKey(this.serverName, "tokens"), tokens);
  }

  saveCodeVerifier(verifier: string): void {
    this._codeVerifier = verifier;
  }

  codeVerifier(): string {
    return this._codeVerifier;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "tokens") {
      await this.storage.update(
        storageKey(this.serverName, "tokens"),
        undefined,
      );
    }
    if (scope === "all" || scope === "client") {
      await this.storage.update(
        storageKey(this.serverName, "client"),
        undefined,
      );
    }
  }

  /**
   * Full async browser-based OAuth flow.
   * The SDK awaits this Promise, so tokens are saved before it returns.
   * After this resolves the SDK throws UnauthorizedError — the caller
   * (McpClientHub) retries the connection immediately with the new token.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const authRedirectUri = authorizationUrl.searchParams.get("redirect_uri");
    const [clientInfo, existingTokens] = await Promise.all([
      this.storage.get<OAuthClientInformationMixed>(
        storageKey(this.serverName, "client"),
      ),
      this.storage.get<OAuthTokens>(storageKey(this.serverName, "tokens")),
    ]);
    const hasSavedTokens = Boolean(existingTokens);
    const hasRefreshToken = Boolean(existingTokens?.refresh_token);

    this.onLog?.(
      `[mcp:${this.serverName}] oauth authorization request redirect_uri=${authRedirectUri ?? "none"} local_redirect=${this.redirectUrl} hasSavedTokens=${hasSavedTokens} hasRefreshToken=${hasRefreshToken}`,
    );

    if (this.onBeforeAuthorizationOpen) {
      const allowed = await this.onBeforeAuthorizationOpen();
      if (!allowed) {
        throw new McpOAuthError(
          "authorization_error",
          `OAuth authorization blocked for "${this.serverName}": manual reauthentication required`,
        );
      }
    }

    if (hasRefreshToken) {
      this.onLog?.(
        `[mcp:${this.serverName}] falling back to interactive OAuth despite saved refresh token; likely refresh-token grant failed or was rejected by provider. client=${this.clientSummary(clientInfo)} tokens=${this.tokenSummary(existingTokens)}`,
      );
      const reauthAction = "Reauthenticate now";
      const selection = await vscode.window.showWarningMessage(
        `AgentLink: Automatic token refresh failed for "${this.serverName}". Reauthenticate to continue.`,
        reauthAction,
      );
      if (selection !== reauthAction) {
        this.onLog?.(
          `[mcp:${this.serverName}] user deferred interactive reauthentication after refresh-token fallback; entering manual reauthenticate required state`,
        );
        throw new McpOAuthError(
          "authorization_error",
          `OAuth authorization blocked for "${this.serverName}": manual reauthentication required after refresh token failure`,
        );
      }
      this.onLog?.(
        `[mcp:${this.serverName}] user accepted interactive reauthentication after refresh-token fallback`,
      );
    } else if (hasSavedTokens) {
      this.onLog?.(
        `[mcp:${this.serverName}] falling back to interactive OAuth with saved tokens but no refresh token available. client=${this.clientSummary(clientInfo)} tokens=${this.tokenSummary(existingTokens)}`,
      );
    }

    const hasClientRedirectMismatch = this.hasRedirectUriMismatch(clientInfo);
    if (hasClientRedirectMismatch) {
      this.onLog?.(
        `[mcp:${this.serverName}] stale oauth client registration detected before interactive auth; cached redirect URIs do not include active redirect. request retry with fresh client registration. current=${this.redirectUrl} client=${this.clientSummary(clientInfo)}`,
      );
      throw new McpOAuthError(
        "stale_client_redirect",
        `OAuth client registration for "${this.serverName}" does not match the active redirect URI`,
      );
    }

    this.onLog?.(
      `[mcp:${this.serverName}] opening browser for oauth authorization`,
    );
    void vscode.window.showInformationMessage(
      `AgentLink: Opening browser to authorize "${this.serverName}"…`,
    );

    const browserOpened = await vscode.env.openExternal(
      vscode.Uri.parse(authorizationUrl.toString()),
    );

    if (!browserOpened) {
      this.onLog?.(
        `[mcp:${this.serverName}] oauth browser launch cancelled or denied`,
      );
      throw new McpOAuthError(
        "authorization_error",
        `OAuth authorization failed for "${this.serverName}": browser launch cancelled by user`,
      );
    }

    // Wait for the browser to redirect back to our local server
    const callback = await this.waitForCallback();

    this.onLog?.(
      `[mcp:${this.serverName}] oauth callback received hasCode=${callback.hasCode} error=${callback.oauthError ?? "none"}${callback.oauthErrorDescription ? ` errorDescription=${callback.oauthErrorDescription}` : ""}`,
    );

    if (callback.oauthError) {
      throw new McpOAuthError(
        "authorization_error",
        `OAuth authorization failed for "${this.serverName}": ${callback.oauthError}${callback.oauthErrorDescription ? ` (${callback.oauthErrorDescription})` : ""}`,
      );
    }

    const code = callback.url.searchParams.get("code");
    if (!code) {
      throw new McpOAuthError(
        "callback_missing_code",
        `OAuth callback for "${this.serverName}" did not include an authorization code`,
      );
    }

    await this.debugStateSnapshot("before authorizationCode exchange");
    this.onLog?.(
      `[mcp:${this.serverName}] exchanging authorization code for tokens`,
    );

    try {
      // Exchange the code for tokens (saves them via saveTokens)
      await auth(this, { serverUrl: this.serverUrl, authorizationCode: code });
    } catch (err) {
      const detail =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.onLog?.(
        `[mcp:${this.serverName}] authorizationCode exchange failed ${detail}`,
      );
      await this.debugStateSnapshot("after failed authorizationCode exchange");
      throw err;
    }

    await this.debugStateSnapshot("after authorizationCode exchange");
    void vscode.window.showInformationMessage(
      `AgentLink: "${this.serverName}" authorized successfully`,
    );
  }

  /** Clear saved tokens (e.g. on /mcp-refresh for a broken server). */
  async clearTokens(): Promise<void> {
    await this.storage.update(storageKey(this.serverName, "tokens"), undefined);
  }

  /**
   * Force a completely fresh OAuth browser flow.
   * Clears all stored credentials, then proactively calls auth() which
   * triggers redirectToAuthorization (opens browser) since nothing is cached.
   * Call this before reconnecting so the new tokens are ready.
   */
  async forceReauth(): Promise<void> {
    await this.invalidateCredentials("all");
    // auth() with no authorizationCode will discover the server and call
    // redirectToAuthorization() since we have no tokens or client info.
    await auth(this, { serverUrl: this.serverUrl });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private waitForCallback(): Promise<OAuthCallbackResult> {
    return new Promise<OAuthCallbackResult>((resolve, reject) => {
      const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      const timer = setTimeout(() => {
        this._server?.removeListener("request", handler);
        reject(
          new McpOAuthError(
            "callback_timeout",
            `OAuth timeout waiting for callback for "${this.serverName}"`,
          ),
        );
      }, TIMEOUT_MS);

      const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = new URL(req.url ?? "/", `http://localhost:${this._port}`);

        if (url.pathname !== "/callback") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }

        clearTimeout(timer);
        this._server?.removeListener("request", handler);

        const oauthError = url.searchParams.get("error") ?? undefined;
        const oauthErrorDescription =
          url.searchParams.get("error_description") ?? undefined;
        const hasCode = Boolean(url.searchParams.get("code"));

        const esc = (value: string): string =>
          value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");

        const isError = Boolean(oauthError);
        const heading = isError
          ? "Authorization failed"
          : "Authorization response received";
        const body = isError
          ? `Return to VS Code. Error: ${esc(oauthError ?? "unknown")}${oauthErrorDescription ? ` (${esc(oauthErrorDescription)})` : ""}`
          : "Return to VS Code to finish the authentication check.";

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<!DOCTYPE html><html><body>` +
            `<h2 style="font-family:sans-serif">${heading}</h2>` +
            `<p style="font-family:sans-serif">${body}</p>` +
            `<script>window.close();</script>` +
            `</body></html>`,
        );

        resolve({
          url,
          oauthError,
          oauthErrorDescription,
          hasCode,
        });
      };

      this._server?.on("request", handler);
    });
  }
}
