import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Which credential source the client was created from. */
export type AuthSource =
  | "explicit"
  | "env-api-key"
  | "env-oauth-token"
  | "cli-credentials"
  | "none";

/**
 * In-memory cache of an Anthropic API key loaded from VS Code secret storage.
 * Set at extension activation and updated whenever the user stores a new key.
 */
let storedAnthropicApiKey: string | undefined;

export function setStoredAnthropicApiKey(key: string | undefined): void {
  storedAnthropicApiKey = key;
}

/** Returns true if any Anthropic API key source is available. */
export function hasAnthropicApiKey(): boolean {
  return !!(
    storedAnthropicApiKey ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN
  );
}

export function readClaudeCliCredentials(): string | undefined {
  try {
    const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
    const raw = fs.readFileSync(credPath, "utf-8");
    const parsed = JSON.parse(raw);
    const o = parsed.claudeAiOauth;
    if (typeof o === "string") return o;
    if (o && typeof o === "object")
      return o.token ?? o.accessToken ?? o.access_token;
  } catch {
    // not found or malformed
  }
  return undefined;
}

/**
 * Force the Claude CLI to refresh its OAuth token by running a trivial
 * print-mode query (`claude -p "hi"`), which boots the SDK and triggers
 * the refresh flow.  Then verify via `claude auth status`.
 * Returns true if the credentials were successfully refreshed.
 * Pass an AbortSignal to cancel the subprocess if the user stops the session.
 */
export async function refreshClaudeCredentials(
  log?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const logLine = log ?? console.log;
  const tokenBefore = readClaudeCliCredentials();

  // Step 1: Run a trivial print-mode query to force the Claude CLI SDK
  // to boot and refresh the OAuth access token using the stored refresh token.
  // `claude auth status` does NOT trigger a refresh — it only reads state.
  try {
    logLine("[auth] running `claude -p` to trigger OAuth token refresh...");
    await execFileAsync("claude", ["-p", "hi", "--max-turns", "1"], {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, FORCE_COLOR: "0" },
      signal,
    });
    logLine("[auth] claude -p completed successfully");
  } catch (err) {
    if (signal?.aborted) return false;
    // The -p call itself may fail (e.g. expired token couldn't be refreshed,
    // network error, or --max-turns not supported on older CLI versions).
    // The token might still have been refreshed before the failure, so
    // continue to the verification step.
    logLine(`[auth] claude -p failed (may still have refreshed): ${err}`);
  }

  if (signal?.aborted) return false;

  // Step 2: Verify via `claude auth status` that we're logged in.
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status"], {
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, FORCE_COLOR: "0" },
      signal,
    });
    logLine(`[auth] auth status: ${stdout.trim()}`);
    const parsed = JSON.parse(stdout.trim());
    if (parsed.loggedIn !== true) {
      logLine("[auth] credential refresh failed — not logged in");
      return false;
    }
  } catch (err) {
    if (signal?.aborted) return false;
    logLine(`[auth] auth status check failed: ${err}`);
    return false;
  }

  // Step 3: Confirm the token actually changed (informational).
  const tokenAfter = readClaudeCliCredentials();
  if (tokenBefore && tokenAfter && tokenBefore === tokenAfter) {
    logLine("[auth] warning: token unchanged after refresh attempt");
  } else if (tokenAfter) {
    logLine("[auth] token refreshed successfully");
  }

  return true;
}

/**
 * Create an Anthropic client with correct auth for the resolved credential.
 *
 * Resolution order:
 *   1. explicitApiKey parameter → x-api-key, api.anthropic.com
 *   2. storedAnthropicApiKey (VS Code secret storage) → x-api-key, api.anthropic.com
 *   3. ANTHROPIC_API_KEY env var → x-api-key, api.anthropic.com
 *   4. CLAUDE_CODE_OAUTH_TOKEN env var → Bearer, api.anthropic.com
 *
 * Throws if no credential is found.
 */
export function createAnthropicClient(
  explicitApiKey?: string,
  log?: (msg: string) => void,
): { client: Anthropic; authSource: AuthSource } {
  const logLine = log ?? console.log;

  if (explicitApiKey) {
    logLine("[auth] using explicit API key");
    return {
      client: new Anthropic({ apiKey: explicitApiKey }),
      authSource: "explicit",
    };
  }

  if (storedAnthropicApiKey) {
    logLine("[auth] using stored API key from secret storage");
    return {
      client: new Anthropic({ apiKey: storedAnthropicApiKey }),
      authSource: "env-api-key",
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    logLine("[auth] using ANTHROPIC_API_KEY env var");
    return {
      client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
      authSource: "env-api-key",
    };
  }

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    logLine("[auth] using CLAUDE_CODE_OAUTH_TOKEN env var (Bearer)");
    return {
      client: new Anthropic({
        authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      }),
      authSource: "env-oauth-token",
    };
  }

  // NOTE: Claude CLI credentials (~/.claude/.credentials.json) were previously
  // used here as a fallback. Left commented out in case direct OAuth support is
  // re-enabled in a future Claude update.
  //
  // const credToken = readClaudeCliCredentials();
  // if (credToken) {
  //   logLine("[auth] using ~/.claude/.credentials.json (apiKey)");
  //   return {
  //     client: new Anthropic({ apiKey: credToken }),
  //     authSource: "cli-credentials",
  //   };
  // }

  throw new Error(
    "No Anthropic API key found. Set ANTHROPIC_API_KEY, or enter a key via the model picker.",
  );
}
