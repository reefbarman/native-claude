/**
 * CodexOAuthManager — OAuth2 Authorization Code + PKCE flow for OpenAI Codex.
 *
 * Supports multiple signed-in OAuth accounts persisted in VS Code SecretStorage.
 */

import { randomUUID } from "crypto";
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
const OAUTH_STATE_VERSION = 2;

/** 5-minute buffer before expiry to trigger proactive refresh. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// ── Types ──

export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  /** Expiry time in ms since epoch. */
  expiresAt: number;
  email?: string;
  /** ChatGPT account ID — used for the `ChatGPT-Account-Id` header. */
  accountId?: string;
  /** Stable user identity across organizations/plan contexts. */
  chatgptUserId?: string;
  /** OIDC subject claim for fallback identity matching. */
  subject?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  email?: string;
}

interface JwtClaims {
  sub?: string;
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_user_id?: string;
    user_id?: string;
  };
}

interface CodexOAuthAccountRecord {
  id: string;
  label: string;
  email?: string;
  chatgptAccountId?: string;
  chatgptUserId?: string;
  subject?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  lastUsageLimitAt?: number;
}

interface CodexOAuthState {
  version: number;
  activeAccountId: string | null;
  accounts: CodexOAuthAccountRecord[];
}

export interface CodexOAuthAccountInfo {
  id: string;
  label: string;
  email?: string;
  chatgptAccountId?: string;
  chatgptUserId?: string;
  subject?: string;
  createdAt: number;
  updatedAt: number;
  lastUsageLimitAt?: number;
  isActive: boolean;
}

export interface SaveOAuthAccountOptions {
  label?: string;
  makeActive?: boolean;
  replaceAccountId?: string;
}

export interface SaveOAuthAccountResult {
  account: CodexOAuthAccountInfo;
  action: "added" | "updated" | "replaced";
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
      claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (id) return id;
  }
  return undefined;
}

function extractEmail(tokens: {
  idToken?: string;
  accessToken: string;
}): string | undefined {
  for (const token of [tokens.idToken, tokens.accessToken]) {
    if (!token) continue;
    const claims = parseJwtClaims(token);
    const email = claims?.email?.trim();
    if (email) return email;
  }
  return undefined;
}

function extractChatgptUserId(tokens: {
  idToken?: string;
  accessToken: string;
}): string | undefined {
  for (const token of [tokens.idToken, tokens.accessToken]) {
    if (!token) continue;
    const claims = parseJwtClaims(token);
    const userId =
      claims?.["https://api.openai.com/auth"]?.chatgpt_user_id ??
      claims?.["https://api.openai.com/auth"]?.user_id;
    if (typeof userId === "string" && userId.trim()) {
      return userId.trim();
    }
  }
  return undefined;
}

function extractSubject(tokens: {
  idToken?: string;
  accessToken: string;
}): string | undefined {
  for (const token of [tokens.idToken, tokens.accessToken]) {
    if (!token) continue;
    const claims = parseJwtClaims(token);
    if (typeof claims?.sub === "string" && claims.sub.trim()) {
      return claims.sub.trim();
    }
  }
  return undefined;
}

function toCredentials(record: CodexOAuthAccountRecord): CodexCredentials {
  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    expiresAt: record.expiresAt,
    email: record.email,
    accountId: record.chatgptAccountId,
    chatgptUserId: record.chatgptUserId,
    subject: record.subject,
  };
}

function isLegacyCredentials(value: unknown): value is CodexCredentials {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === "string" &&
    typeof v.refreshToken === "string" &&
    typeof v.expiresAt === "number"
  );
}

function isStateShape(value: unknown): value is CodexOAuthState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === "number" &&
    (typeof v.activeAccountId === "string" || v.activeAccountId === null) &&
    Array.isArray(v.accounts)
  );
}

function isTokenExpired(credentials: CodexCredentials): boolean {
  return Date.now() >= credentials.expiresAt - EXPIRY_BUFFER_MS;
}

function isInvalidGrantError(error: unknown): boolean {
  return !!(
    error &&
    typeof error === "object" &&
    "isInvalidGrant" in error &&
    (error as { isInvalidGrant: boolean }).isInvalidGrant
  );
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
  const parsedEmail = extractEmail({
    idToken: data.id_token,
    accessToken: data.access_token,
  });
  const chatgptUserId = extractChatgptUserId({
    idToken: data.id_token,
    accessToken: data.access_token,
  });
  const subject = extractSubject({
    idToken: data.id_token,
    accessToken: data.access_token,
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    email: data.email?.trim() || parsedEmail,
    accountId,
    chatgptUserId,
    subject,
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
  const parsedEmail = extractEmail({
    idToken: data.id_token,
    accessToken: data.access_token,
  });
  const chatgptUserId = extractChatgptUserId({
    idToken: data.id_token,
    accessToken: data.access_token,
  });
  const subject = extractSubject({
    idToken: data.id_token,
    accessToken: data.access_token,
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? credentials.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    email: data.email?.trim() || parsedEmail || credentials.email,
    accountId: accountId ?? credentials.accountId,
    chatgptUserId: chatgptUserId ?? credentials.chatgptUserId,
    subject: subject ?? credentials.subject,
  };
}

// ── OAuth Manager ──

export class CodexOAuthFlowError extends Error {
  constructor(
    message: string,
    readonly code:
      | "oauth_error"
      | "missing_code"
      | "state_mismatch"
      | "port_in_use"
      | "timeout",
  ) {
    super(message);
    this.name = "CodexOAuthFlowError";
  }
}

export class CodexOAuthManager {
  private context: ExtensionContext | null = null;
  private state: CodexOAuthState = {
    version: OAUTH_STATE_VERSION,
    activeAccountId: null,
    accounts: [],
  };
  private stateLoaded = false;
  private loadedStateRaw: string | null = null;
  private refreshPromises = new Map<string, Promise<CodexOAuthAccountRecord>>();
  private log: (msg: string) => void;
  private pendingAuth: {
    codeVerifier: string;
    state: string;
    server?: http.Server;
  } | null = null;

  /** Fired after sign-in, sign-out, account switch, or account mutation. */
  onAuthStateChanged?: () => void;

  constructor(log?: (msg: string) => void) {
    this.log = log ?? console.log;
  }

  /** Must be called during extension activation to enable credential storage. */
  initialize(context: ExtensionContext): void {
    this.context = context;
  }

  // ── Storage ──

  private accountToInfo(
    account: CodexOAuthAccountRecord,
    activeAccountId = this.state.activeAccountId,
  ): CodexOAuthAccountInfo {
    return {
      id: account.id,
      label: account.label,
      email: account.email,
      chatgptAccountId: account.chatgptAccountId,
      chatgptUserId: account.chatgptUserId,
      subject: account.subject,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastUsageLimitAt: account.lastUsageLimitAt,
      isActive: account.id === activeAccountId,
    };
  }

  private deriveLabel(options: {
    explicitLabel?: string;
    existingLabel?: string;
    email?: string;
  }): string {
    const explicit = options.explicitLabel?.trim();
    if (explicit) return explicit;
    const existing = options.existingLabel?.trim();
    if (existing) return existing;
    const email = options.email?.trim();
    if (email) return email;
    return `Codex Account ${this.state.accounts.length + 1}`;
  }

  private parseStoredState(
    raw: string,
  ):
    | { state: CodexOAuthState; shouldPersist: false }
    | { state: CodexOAuthState; shouldPersist: true }
    | null {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isStateShape(parsed) && parsed.version >= OAUTH_STATE_VERSION) {
        return {
          state: {
            version: OAUTH_STATE_VERSION,
            activeAccountId:
              typeof parsed.activeAccountId === "string"
                ? parsed.activeAccountId
                : null,
            accounts: (parsed.accounts as unknown[])
              .filter(
                (a): a is CodexOAuthAccountRecord =>
                  !!a &&
                  typeof a === "object" &&
                  typeof (a as Record<string, unknown>).id === "string" &&
                  typeof (a as Record<string, unknown>).accessToken ===
                    "string" &&
                  typeof (a as Record<string, unknown>).refreshToken ===
                    "string" &&
                  typeof (a as Record<string, unknown>).expiresAt ===
                    "number" &&
                  typeof (a as Record<string, unknown>).label === "string" &&
                  typeof (a as Record<string, unknown>).createdAt ===
                    "number" &&
                  typeof (a as Record<string, unknown>).updatedAt === "number",
              )
              .map((a) => ({
                ...a,
                chatgptUserId:
                  typeof a.chatgptUserId === "string"
                    ? a.chatgptUserId
                    : undefined,
                subject: typeof a.subject === "string" ? a.subject : undefined,
              })),
          },
          shouldPersist: false,
        };
      }

      if (isLegacyCredentials(parsed)) {
        const now = Date.now();
        const legacyAccount: CodexOAuthAccountRecord = {
          id: randomUUID(),
          label: parsed.email?.trim() || "Codex Account 1",
          email: parsed.email,
          chatgptAccountId: parsed.accountId,
          chatgptUserId: parsed.chatgptUserId,
          subject: parsed.subject,
          accessToken: parsed.accessToken,
          refreshToken: parsed.refreshToken,
          expiresAt: parsed.expiresAt,
          createdAt: now,
          updatedAt: now,
        };
        return {
          state: {
            version: OAUTH_STATE_VERSION,
            activeAccountId: legacyAccount.id,
            accounts: [legacyAccount],
          },
          shouldPersist: true,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  private normalizeLoadedState(): boolean {
    let changed = false;
    if (this.state.accounts.length === 0) {
      if (this.state.activeAccountId !== null) {
        this.state.activeAccountId = null;
        changed = true;
      }
      return changed;
    }

    if (
      !this.state.activeAccountId ||
      !this.state.accounts.some((a) => a.id === this.state.activeAccountId)
    ) {
      this.state.activeAccountId = this.state.accounts[0].id;
      changed = true;
    }

    return changed;
  }

  private async loadStateFromStorage(options?: {
    persistNormalization?: boolean;
  }): Promise<void> {
    if (!this.context) return;

    const raw = await this.context.secrets.get(CREDENTIALS_STORAGE_KEY);
    if (!raw) {
      this.state = {
        version: OAUTH_STATE_VERSION,
        activeAccountId: null,
        accounts: [],
      };
      this.loadedStateRaw = null;
      return;
    }

    const parsed = this.parseStoredState(raw);
    if (!parsed) {
      this.log(
        "[codex-oauth] Unknown credential payload shape, clearing state",
      );
      await this.context.secrets.delete(CREDENTIALS_STORAGE_KEY);
      this.state = {
        version: OAUTH_STATE_VERSION,
        activeAccountId: null,
        accounts: [],
      };
      this.loadedStateRaw = null;
      return;
    }

    this.state = parsed.state;
    const normalized = this.normalizeLoadedState();

    const shouldPersist =
      parsed.shouldPersist ||
      ((options?.persistNormalization ?? false) ? normalized : false);
    if (shouldPersist) {
      await this.saveState(false, { checkForExternalChanges: false });
      return;
    }

    this.loadedStateRaw = raw;
  }

  private async ensureStateLoaded(options?: {
    forceReload?: boolean;
    persistNormalization?: boolean;
  }): Promise<void> {
    if (!this.context) return;
    if (!options?.forceReload && this.stateLoaded) return;

    try {
      await this.loadStateFromStorage({
        persistNormalization: options?.persistNormalization,
      });
    } catch (err) {
      this.log(
        `[codex-oauth] Failed to load OAuth state: ${err instanceof Error ? err.message : err}`,
      );
      if (this.context) {
        await this.context.secrets.delete(CREDENTIALS_STORAGE_KEY);
      }
      this.state = {
        version: OAUTH_STATE_VERSION,
        activeAccountId: null,
        accounts: [],
      };
      this.loadedStateRaw = null;
    } finally {
      this.stateLoaded = true;
    }
  }

  private async saveState(
    notify = false,
    options?: { checkForExternalChanges?: boolean },
  ): Promise<void> {
    if (!this.context) throw new Error("CodexOAuthManager not initialized");

    if (options?.checkForExternalChanges ?? true) {
      const latestRaw =
        (await this.context.secrets.get(CREDENTIALS_STORAGE_KEY)) ?? null;
      if (latestRaw !== this.loadedStateRaw) {
        this.log(
          "[codex-oauth] Detected external credential update; reloading before save",
        );
        await this.ensureStateLoaded({
          forceReload: true,
          persistNormalization: true,
        });
      }
    }

    const raw = JSON.stringify(this.state);
    await this.context.secrets.store(CREDENTIALS_STORAGE_KEY, raw);
    this.loadedStateRaw = raw;
    if (notify) {
      this.onAuthStateChanged?.();
    }
  }

  private async withFreshStateWrite<T>(options: {
    notify?: boolean;
    mutate: () => T;
  }): Promise<T> {
    await this.ensureStateLoaded({
      forceReload: true,
      persistNormalization: true,
    });
    const result = options.mutate();
    await this.saveState(options.notify ?? false, {
      checkForExternalChanges: false,
    });
    return result;
  }

  private findAccountById(
    accountId: string,
  ): CodexOAuthAccountRecord | undefined {
    return this.state.accounts.find((a) => a.id === accountId);
  }

  private findActiveAccount(): CodexOAuthAccountRecord | undefined {
    if (!this.state.activeAccountId) return undefined;
    return this.findAccountById(this.state.activeAccountId);
  }

  private async ensureActiveAccount(): Promise<CodexOAuthAccountRecord | null> {
    await this.ensureStateLoaded({
      forceReload: true,
      persistNormalization: true,
    });
    const active = this.findActiveAccount();
    if (active) return active;
    if (this.state.accounts.length === 0) {
      this.state.activeAccountId = null;
      return null;
    }
    this.state.activeAccountId = this.state.accounts[0].id;
    await this.saveState(false);
    return this.state.accounts[0];
  }

  private async updateAccountRecord(
    updated: CodexOAuthAccountRecord,
    notify = false,
  ): Promise<void> {
    await this.withFreshStateWrite({
      notify,
      mutate: () => {
        const idx = this.state.accounts.findIndex((a) => a.id === updated.id);
        if (idx === -1) return;
        this.state.accounts[idx] = updated;
      },
    });
  }

  private async removeAccountInternal(
    accountId: string,
    notify = true,
  ): Promise<boolean> {
    return this.withFreshStateWrite({
      notify,
      mutate: () => {
        const idx = this.state.accounts.findIndex((a) => a.id === accountId);
        if (idx === -1) return false;

        this.state.accounts.splice(idx, 1);
        this.refreshPromises.delete(accountId);

        if (this.state.accounts.length === 0) {
          this.state.activeAccountId = null;
        } else if (this.state.activeAccountId === accountId) {
          this.state.activeAccountId = this.state.accounts[0].id;
        }

        return true;
      },
    });
  }

  private async refreshAccount(
    accountId: string,
    force: boolean,
  ): Promise<CodexOAuthAccountRecord | null> {
    await this.ensureStateLoaded({
      forceReload: true,
      persistNormalization: true,
    });
    const account = this.findAccountById(accountId);
    if (!account) return null;

    const creds = toCredentials(account);
    if (!force && !isTokenExpired(creds)) {
      return account;
    }

    try {
      let promise = this.refreshPromises.get(accountId);
      if (!promise) {
        this.log(
          `[codex-oauth] Refreshing token for account=${account.label} (${account.id})`,
        );
        promise = refreshAccessToken(creds).then((next) => ({
          ...account,
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          expiresAt: next.expiresAt,
          email: next.email ?? account.email,
          chatgptAccountId: next.accountId ?? account.chatgptAccountId,
          chatgptUserId: next.chatgptUserId ?? account.chatgptUserId,
          subject: next.subject ?? account.subject,
          updatedAt: Date.now(),
        }));
        this.refreshPromises.set(accountId, promise);
      }

      const refreshed = await promise;
      this.refreshPromises.delete(accountId);
      await this.updateAccountRecord(refreshed, false);
      return refreshed;
    } catch (err) {
      this.refreshPromises.delete(accountId);
      this.log(
        `[codex-oauth] Token refresh failed for account=${accountId}: ${err instanceof Error ? err.message : err}`,
      );
      if (isInvalidGrantError(err)) {
        this.log(
          `[codex-oauth] Invalid grant for account=${accountId}; removing`,
        );
        await this.removeAccountInternal(accountId, true);
      }
      return null;
    }
  }

  // ── Account management ──

  async listAccounts(): Promise<CodexOAuthAccountInfo[]> {
    await this.ensureStateLoaded();
    return this.state.accounts.map((a) => this.accountToInfo(a));
  }

  async hasAccounts(): Promise<boolean> {
    await this.ensureStateLoaded();
    return this.state.accounts.length > 0;
  }

  async getAccountById(
    accountId: string,
  ): Promise<CodexOAuthAccountInfo | null> {
    await this.ensureStateLoaded();
    const account = this.findAccountById(accountId);
    return account ? this.accountToInfo(account) : null;
  }

  async getActiveAccount(): Promise<CodexOAuthAccountInfo | null> {
    const account = await this.ensureActiveAccount();
    return account ? this.accountToInfo(account) : null;
  }

  async setActiveAccount(
    accountId: string,
    options?: { notify?: boolean },
  ): Promise<CodexOAuthAccountInfo | null> {
    return this.withFreshStateWrite({
      notify: options?.notify ?? true,
      mutate: () => {
        const account = this.findAccountById(accountId);
        if (!account) return null;

        if (this.state.activeAccountId === account.id) {
          return this.accountToInfo(account);
        }

        this.state.activeAccountId = account.id;
        return this.accountToInfo(account);
      },
    });
  }

  async updateAccountLabel(
    accountId: string,
    label: string,
  ): Promise<CodexOAuthAccountInfo | null> {
    return this.withFreshStateWrite({
      notify: true,
      mutate: () => {
        const account = this.findAccountById(accountId);
        if (!account) return null;

        const trimmed = label.trim();
        account.label = trimmed || account.label;
        account.updatedAt = Date.now();
        return this.accountToInfo(account);
      },
    });
  }

  async removeAccount(accountId: string): Promise<boolean> {
    return this.removeAccountInternal(accountId, true);
  }

  async clearCredentials(): Promise<void> {
    await this.ensureStateLoaded({
      forceReload: true,
      persistNormalization: true,
    });
    this.state = {
      version: OAUTH_STATE_VERSION,
      activeAccountId: null,
      accounts: [],
    };
    this.refreshPromises.clear();
    if (!this.context) return;
    await this.context.secrets.delete(CREDENTIALS_STORAGE_KEY);
    this.loadedStateRaw = null;
    this.onAuthStateChanged?.();
  }

  async saveOAuthAccount(
    credentials: CodexCredentials,
    options?: SaveOAuthAccountOptions,
  ): Promise<SaveOAuthAccountResult> {
    return this.withFreshStateWrite({
      notify: true,
      mutate: () => {
        const now = Date.now();
        const makeActive = options?.makeActive ?? true;

        if (options?.replaceAccountId) {
          const target = this.findAccountById(options.replaceAccountId);
          if (!target) {
            throw new Error("OAuth account to replace was not found");
          }

          const normalizedEmail = credentials.email?.trim().toLowerCase();
          const normalizedSubject = credentials.subject?.trim();
          const normalizedUserId = credentials.chatgptUserId?.trim();
          const duplicateByUserId = normalizedUserId
            ? this.state.accounts.find(
                (a) =>
                  a.id !== target.id &&
                  a.chatgptUserId?.trim() === normalizedUserId,
              )
            : undefined;
          const duplicateBySubject =
            !duplicateByUserId && normalizedSubject
              ? this.state.accounts.find(
                  (a) =>
                    a.id !== target.id &&
                    a.subject?.trim() === normalizedSubject,
                )
              : undefined;
          const duplicateByEmail =
            !duplicateByUserId && !duplicateBySubject && normalizedEmail
              ? this.state.accounts.find(
                  (a) =>
                    a.id !== target.id &&
                    a.email?.trim().toLowerCase() === normalizedEmail,
                )
              : undefined;
          const duplicate =
            duplicateByUserId ?? duplicateBySubject ?? duplicateByEmail;
          if (duplicate) {
            this.state.accounts = this.state.accounts.filter(
              (a) => a.id !== duplicate.id,
            );
            this.refreshPromises.delete(duplicate.id);
          }

          target.accessToken = credentials.accessToken;
          target.refreshToken = credentials.refreshToken;
          target.expiresAt = credentials.expiresAt;
          target.email = credentials.email ?? target.email;
          target.chatgptAccountId =
            credentials.accountId ?? target.chatgptAccountId;
          target.chatgptUserId =
            credentials.chatgptUserId ?? target.chatgptUserId;
          target.subject = credentials.subject ?? target.subject;
          target.label = this.deriveLabel({
            explicitLabel: options.label,
            existingLabel: target.label,
            email: target.email,
          });
          target.updatedAt = now;
          if (makeActive) {
            this.state.activeAccountId = target.id;
          }
          return { account: this.accountToInfo(target), action: "replaced" };
        }

        const normalizedEmail = credentials.email?.trim().toLowerCase();
        const normalizedSubject = credentials.subject?.trim();
        const normalizedUserId = credentials.chatgptUserId?.trim();
        const existingByUserId = normalizedUserId
          ? this.state.accounts.find(
              (a) => a.chatgptUserId?.trim() === normalizedUserId,
            )
          : undefined;
        const existingBySubject =
          !existingByUserId && normalizedSubject
            ? this.state.accounts.find(
                (a) => a.subject?.trim() === normalizedSubject,
              )
            : undefined;
        const existingByEmail =
          !existingByUserId && !existingBySubject && normalizedEmail
            ? this.state.accounts.find(
                (a) => a.email?.trim().toLowerCase() === normalizedEmail,
              )
            : undefined;
        const existing =
          existingByUserId ?? existingBySubject ?? existingByEmail;

        if (existing) {
          existing.accessToken = credentials.accessToken;
          existing.refreshToken = credentials.refreshToken;
          existing.expiresAt = credentials.expiresAt;
          existing.email = credentials.email ?? existing.email;
          existing.chatgptAccountId =
            credentials.accountId ?? existing.chatgptAccountId;
          existing.chatgptUserId =
            credentials.chatgptUserId ?? existing.chatgptUserId;
          existing.subject = credentials.subject ?? existing.subject;
          existing.label = this.deriveLabel({
            explicitLabel: options?.label,
            existingLabel: existing.label,
            email: existing.email,
          });
          existing.updatedAt = now;
          if (makeActive) {
            this.state.activeAccountId = existing.id;
          }
          return {
            account: this.accountToInfo(existing),
            action: "updated",
          };
        }

        const account: CodexOAuthAccountRecord = {
          id: randomUUID(),
          label: this.deriveLabel({
            explicitLabel: options?.label,
            email: credentials.email,
          }),
          email: credentials.email,
          chatgptAccountId: credentials.accountId,
          chatgptUserId: credentials.chatgptUserId,
          subject: credentials.subject,
          accessToken: credentials.accessToken,
          refreshToken: credentials.refreshToken,
          expiresAt: credentials.expiresAt,
          createdAt: now,
          updatedAt: now,
        };

        this.state.accounts.push(account);
        if (makeActive || !this.state.activeAccountId) {
          this.state.activeAccountId = account.id;
        }
        return { account: this.accountToInfo(account), action: "added" };
      },
    });
  }

  async markUsageLimit(accountId: string): Promise<void> {
    await this.withFreshStateWrite({
      notify: false,
      mutate: () => {
        const account = this.findAccountById(accountId);
        if (!account) return;
        account.lastUsageLimitAt = Date.now();
        account.updatedAt = Date.now();
      },
    });
  }

  async getRoundRobinAccountIds(
    startAfterAccountId?: string,
  ): Promise<string[]> {
    await this.ensureStateLoaded();
    if (this.state.accounts.length === 0) return [];

    const accounts = this.state.accounts;
    const pivotId = startAfterAccountId ?? this.state.activeAccountId;
    if (!pivotId) {
      return accounts.map((a) => a.id);
    }

    const startIdx = accounts.findIndex((a) => a.id === pivotId);
    if (startIdx === -1) {
      return accounts.map((a) => a.id);
    }

    const ids: string[] = [];
    for (let offset = 1; offset <= accounts.length; offset++) {
      const idx = (startIdx + offset) % accounts.length;
      ids.push(accounts[idx].id);
    }
    return ids;
  }

  // ── Token access ──

  async getAccessTokenByAccountId(accountId: string): Promise<string | null> {
    const account = await this.refreshAccount(accountId, false);
    return account?.accessToken ?? null;
  }

  async forceRefreshAccessTokenByAccountId(
    accountId: string,
  ): Promise<string | null> {
    const account = await this.refreshAccount(accountId, true);
    return account?.accessToken ?? null;
  }

  /**
   * Get a valid access token from the active account.
   * If active account is invalid/expired beyond refresh, attempts other accounts.
   */
  async getAccessToken(): Promise<string | null> {
    const active = await this.ensureActiveAccount();
    if (!active) return null;

    const activeToken = await this.getAccessTokenByAccountId(active.id);
    if (activeToken) return activeToken;

    const candidates = await this.getRoundRobinAccountIds(active.id);
    for (const candidateId of candidates) {
      const token = await this.getAccessTokenByAccountId(candidateId);
      if (!token) continue;
      await this.setActiveAccount(candidateId, { notify: true });
      return token;
    }

    return null;
  }

  /** Force-refresh active account token. */
  async forceRefreshAccessToken(): Promise<string | null> {
    const active = await this.ensureActiveAccount();
    if (!active) return null;
    return this.forceRefreshAccessTokenByAccountId(active.id);
  }

  async getAccountId(): Promise<string | null> {
    const active = await this.ensureActiveAccount();
    return active?.chatgptAccountId ?? null;
  }

  async getEmail(): Promise<string | null> {
    const active = await this.ensureActiveAccount();
    return active?.email ?? null;
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
   * Resolves exchanged credentials only; caller decides how to store them.
   */
  async waitForCallback(): Promise<CodexCredentials> {
    if (!this.pendingAuth) {
      throw new Error(
        "No pending authorization flow — call startAuthorizationFlow() first",
      );
    }

    this.closePendingServer();

    return new Promise<CodexCredentials>((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const finish = (result: {
        credentials?: CodexCredentials;
        error?: unknown;
      }) => {
        if (settled) return;
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        this.closePendingServer();
        this.pendingAuth = null;
        if (result.credentials) {
          resolve(result.credentials);
          return;
        }
        reject(result.error);
      };

      const server = http.createServer(async (req, res) => {
        try {
          if (settled) {
            res.writeHead(503);
            res.end("Authentication flow is no longer active");
            return;
          }

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
            finish({
              error: new CodexOAuthFlowError(
                `OAuth error: ${error}`,
                "oauth_error",
              ),
            });
            return;
          }

          if (!code || !state) {
            res.writeHead(400);
            res.end("Missing code or state parameter");
            finish({
              error: new CodexOAuthFlowError(
                "Missing code or state parameter",
                "missing_code",
              ),
            });
            return;
          }

          if (state !== this.pendingAuth?.state) {
            res.writeHead(400);
            res.end("State mismatch — possible CSRF attack");
            finish({
              error: new CodexOAuthFlowError(
                "State mismatch",
                "state_mismatch",
              ),
            });
            return;
          }

          try {
            const credentials = await exchangeCodeForTokens(
              code,
              this.pendingAuth.codeVerifier,
            );

            res.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
            });
            res.end(successHtml());
            finish({ credentials });
          } catch (exchangeErr) {
            res.writeHead(500);
            res.end("Token exchange failed");
            finish({ error: exchangeErr });
          }
        } catch (err) {
          res.writeHead(500);
          res.end("Internal server error");
          finish({ error: err });
        }
      });

      if (this.pendingAuth) {
        this.pendingAuth.server = server;
      }

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          finish({
            error: new CodexOAuthFlowError(
              `Port ${OAUTH_CONFIG.callbackPort} is already in use. Please close any other applications using this port (e.g. Roo Code, Codex CLI) and try again.`,
              "port_in_use",
            ),
          });
        } else {
          finish({ error: err });
        }
      });

      timeout = setTimeout(
        () => {
          finish({
            error: new CodexOAuthFlowError(
              "Authentication timed out after 5 minutes",
              "timeout",
            ),
          });
        },
        5 * 60 * 1000,
      );

      server.listen(OAUTH_CONFIG.callbackPort);
    });
  }

  /** Cancel any in-progress authorization flow. */
  cancelAuthorizationFlow(): void {
    this.closePendingServer();
    this.pendingAuth = null;
  }

  private closePendingServer(): void {
    if (!this.pendingAuth?.server) {
      return;
    }
    try {
      this.pendingAuth.server.close();
    } catch {
      /* ignore */
    }
    this.pendingAuth.server = undefined;
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
