#!/usr/bin/env node

import { randomUUID, createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";

import OpenAI from "openai";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface OAuthConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  callbackPort: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  email?: string;
}

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
}

interface BenchmarkConfig {
  models: string[];
  runsPerModel: number;
  outputPath: string;
  openBrowser: boolean;
  timeoutMs: number;
  prompt: string;
  sampleText: string;
}

interface ErrorInfo {
  name: string;
  message: string;
  status?: number;
  code?: string;
  type?: string;
}

interface SummaryEvaluation {
  validJson: boolean;
  schemaValid: boolean;
  issues: string[];
  warnings: string[];
  preferredStatusWordCountValid: boolean;
  statusWordCount?: number;
}

interface BenchmarkRunResult {
  runIndex: number;
  ok: boolean;
  durationMs: number;
  summaryText?: string;
  responseId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  evaluation?: SummaryEvaluation;
  error?: ErrorInfo;
}

interface ModelBenchmarkResult {
  model: string;
  runs: BenchmarkRunResult[];
  aggregate: {
    successCount: number;
    failureCount: number;
    avgDurationMs?: number;
    medianDurationMs?: number;
    minDurationMs?: number;
    maxDurationMs?: number;
    schemaValidCount: number;
    validJsonCount: number;
    preferredStatusWordCountValidCount: number;
  };
}

interface BenchmarkArtifact {
  generatedAt: string;
  oauth: {
    accountIdHash?: string;
    emailHash?: string;
    expiresAt: number;
  };
  config: Omit<BenchmarkConfig, "prompt" | "sampleText"> & {
    promptHash: string;
    sampleTextHash: string;
    sampleTextLength: number;
  };
  prompt: string;
  sampleText: string;
  results: ModelBenchmarkResult[];
}

const OAUTH_CONFIG: OAuthConfig = {
  authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
  tokenEndpoint: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectUri: "http://localhost:1455/auth/callback",
  scopes: "openid profile email offline_access",
  callbackPort: 1455,
};

const DEFAULT_MODELS = [
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
  "gpt-4o-mini",
];

const DEFAULT_PROMPT = [
  "You are summarizing the current state of a background coding agent for a compact UI card.",
  "Return JSON only (no markdown, no prose) with this exact shape:",
  '{"status":"string","recent_actions":["string"],"blockers":["string"],"next_steps":["string"],"confidence":0.0}',
  "Rules:",
  "- Keep each list to at most 3 items.",
  "- status must be 1-3 words (hard max 5 words).",
  "- If needed, you may invent concise logical coined/process words to preserve meaning.",
  "- Confidence must be a number between 0 and 1.",
].join("\n");

const DEFAULT_SAMPLE_TEXT = [
  "[background-agent] Task: review implementation of background status summarization.",
  "[12:14:03] Read file src/agent/background/runner.ts and found status events are stored as free-form strings.",
  "[12:14:06] Read file src/agent/background/uiStatus.ts and found UI only shows currentTool and partialOutput snippet.",
  "[12:14:09] Ran test: npm test -- background-status; failed in 2 tests due to stale snapshot text.",
  "[12:14:15] Proposed patch: add structured state summary object with status, recentActions, blockers, nextSteps.",
  "[12:14:20] Applied patch in src/agent/background/stateSummary.ts and updated mapper in src/agent/background/uiStatus.ts.",
  "[12:14:25] Re-ran tests: 17 passed, 2 failed (snapshot mismatch).",
  "[12:14:31] Updated snapshots for background status rendering.",
  "[12:14:38] Re-ran tests: all 19 passed.",
  "[12:14:42] Outstanding concern: summary quality may vary by model; no benchmark data yet.",
  "[12:14:47] Next action planned: benchmark candidate models on latency and JSON adherence.",
].join("\n");

function printUsage(): void {
  console.log(`
Codex OAuth Model Benchmark

Runs an OAuth login flow, then benchmarks multiple models on a fixed summarization task.

Usage:
  node --experimental-strip-types scripts/benchmark-codex-oauth-models.mts [options]

Options:
  --models <comma-separated>    Override model list
  --runs <number>               Runs per model (default: 1)
  --output <path>               Output JSON path
  --prompt-file <path>          Read summarization prompt from file
  --sample-file <path>          Read sample text from file
  --timeout-ms <number>         OAuth callback timeout (default: 300000)
  --no-open-browser             Do not auto-open browser, just print URL
  --help                        Show this help

Examples:
  node --experimental-strip-types scripts/benchmark-codex-oauth-models.mts
  node --experimental-strip-types scripts/benchmark-codex-oauth-models.mts --runs 3
  node --experimental-strip-types scripts/benchmark-codex-oauth-models.mts --models gpt-5.4-mini,gpt-4o-mini
`);
}

function parseArgs(argv: string[]): {
  runsPerModel: number;
  models: string[];
  outputPath?: string;
  promptFile?: string;
  sampleFile?: string;
  timeoutMs: number;
  openBrowser: boolean;
  help: boolean;
} {
  const args = {
    runsPerModel: 1,
    models: DEFAULT_MODELS,
    outputPath: undefined as string | undefined,
    promptFile: undefined as string | undefined,
    sampleFile: undefined as string | undefined,
    timeoutMs: 5 * 60 * 1000,
    openBrowser: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    if (arg === "--no-open-browser") {
      args.openBrowser = false;
      continue;
    }

    if (arg === "--runs") {
      if (!next) throw new Error("Missing value for --runs");
      i++;
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --runs value: ${next}`);
      }
      args.runsPerModel = parsed;
      continue;
    }

    if (arg === "--models") {
      if (!next) throw new Error("Missing value for --models");
      i++;
      const models = next
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      if (models.length === 0) {
        throw new Error("--models cannot be empty");
      }
      args.models = models;
      continue;
    }

    if (arg === "--output") {
      if (!next) throw new Error("Missing value for --output");
      i++;
      args.outputPath = next;
      continue;
    }

    if (arg === "--prompt-file") {
      if (!next) throw new Error("Missing value for --prompt-file");
      i++;
      args.promptFile = next;
      continue;
    }

    if (arg === "--sample-file") {
      if (!next) throw new Error("Missing value for --sample-file");
      i++;
      args.sampleFile = next;
      continue;
    }

    if (arg === "--timeout-ms") {
      if (!next) throw new Error("Missing value for --timeout-ms");
      i++;
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1_000) {
        throw new Error(`Invalid --timeout-ms value: ${next}`);
      }
      args.timeoutMs = parsed;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function nowIsoCompact(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function makeDefaultOutputPath(): string {
  return path.join(
    process.cwd(),
    "artifacts",
    `codex-oauth-model-benchmark-${nowIsoCompact()}.json`,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

function parseJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractAccountId(tokens: {
  idToken?: string;
  accessToken: string;
}): string | undefined {
  const idClaims = tokens.idToken ? parseJwtClaims(tokens.idToken) : null;
  const accessClaims = parseJwtClaims(tokens.accessToken);

  const fromAuthObject = (
    claims: Record<string, unknown> | null,
  ): string | undefined => {
    const authObj = claims?.["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    const value = authObj?.chatgpt_account_id;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };

  const fromTopLevel = (
    claims: Record<string, unknown> | null,
  ): string | undefined => {
    const value = claims?.chatgpt_account_id;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };

  const fromOrganizations = (
    claims: Record<string, unknown> | null,
  ): string | undefined => {
    const organizations = claims?.organizations;
    if (!Array.isArray(organizations) || organizations.length === 0) {
      return undefined;
    }
    const first = organizations[0];
    if (!first || typeof first !== "object") return undefined;
    const id = (first as Record<string, unknown>).id;
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  };

  return (
    fromAuthObject(idClaims) ??
    fromTopLevel(idClaims) ??
    fromOrganizations(idClaims) ??
    fromAuthObject(accessClaims) ??
    fromTopLevel(accessClaims) ??
    fromOrganizations(accessClaims)
  );
}

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<OAuthCredentials> {
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
    const text = await response.text();
    throw new Error(
      `Token exchange failed: ${response.status} ${response.statusText} - ${text}`,
    );
  }

  const data = (await response.json()) as TokenResponse;
  if (!data.access_token) {
    throw new Error("Token response missing access_token");
  }
  if (!data.refresh_token) {
    throw new Error("Token response missing refresh_token");
  }
  if (!data.expires_in) {
    throw new Error("Token response missing expires_in");
  }

  const accountId = extractAccountId({
    idToken: data.id_token,
    accessToken: data.access_token,
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1_000,
    email: data.email?.trim() || undefined,
    accountId,
  };
}

function openBrowser(url: string): boolean {
  const platform = process.platform;
  const candidates: Array<{ cmd: string; args: string[] }> =
    platform === "darwin"
      ? [{ cmd: "open", args: [url] }]
      : platform === "win32"
        ? [{ cmd: "cmd", args: ["/c", "start", "", url] }]
        : [
            { cmd: "xdg-open", args: [url] },
            { cmd: "gio", args: ["open", url] },
          ];

  for (const candidate of candidates) {
    try {
      const child = spawn(candidate.cmd, candidate.args, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return true;
    } catch {
      // Try next candidate.
    }
  }

  return false;
}

async function runOAuthFlow(options: {
  openBrowser: boolean;
  timeoutMs: number;
}): Promise<OAuthCredentials> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

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

  const authUrl = `${OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`;

  console.log("Starting OAuth flow...");
  if (options.openBrowser) {
    const opened = openBrowser(authUrl);
    if (opened) {
      console.log("Opened browser for OAuth sign-in.");
    } else {
      console.log("Failed to auto-open browser. Open this URL manually:");
      console.log(authUrl);
    }
  } else {
    console.log("Open this URL to sign in:");
    console.log(authUrl);
  }

  return new Promise<OAuthCredentials>((resolve, reject) => {
    let settled = false;

    const finish = (value: {
      credentials?: OAuthCredentials;
      error?: unknown;
    }) => {
      if (settled) return;
      settled = true;
      server.close();
      if (timeoutHandle) clearTimeout(timeoutHandle);

      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }

      if (value.credentials) {
        resolve(value.credentials);
      } else {
        reject(value.error);
      }
    };

    const server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(
          req.url ?? "",
          `http://localhost:${OAUTH_CONFIG.callbackPort}`,
        );

        if (requestUrl.pathname !== "/auth/callback") {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }

        const code = requestUrl.searchParams.get("code");
        const returnedState = requestUrl.searchParams.get("state");
        const error = requestUrl.searchParams.get("error");

        if (error) {
          res.writeHead(400);
          res.end(`OAuth failed: ${error}`);
          finish({ error: new Error(`OAuth error: ${error}`) });
          return;
        }

        if (!code || !returnedState) {
          res.writeHead(400);
          res.end("Missing code or state");
          finish({ error: new Error("Missing code or state in callback") });
          return;
        }

        if (returnedState !== state) {
          res.writeHead(400);
          res.end("State mismatch");
          finish({ error: new Error("OAuth state mismatch") });
          return;
        }

        try {
          const credentials = await exchangeCodeForTokens(code, codeVerifier);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<h1>Authentication successful</h1><p>You can close this tab.</p>",
          );
          finish({ credentials });
        } catch (err) {
          res.writeHead(500);
          res.end("Token exchange failed");
          finish({ error: err });
        }
      } catch (err) {
        res.writeHead(500);
        res.end("Internal error");
        finish({ error: err });
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        finish({
          error: new Error(
            `Port ${OAUTH_CONFIG.callbackPort} is already in use. Close the process using it and retry.`,
          ),
        });
        return;
      }
      finish({ error: err });
    });

    server.listen(OAUTH_CONFIG.callbackPort);

    const timeoutHandle = setTimeout(() => {
      finish({
        error: new Error(
          `OAuth callback timed out after ${options.timeoutMs}ms.`,
        ),
      });
    }, options.timeoutMs);
  });
}

interface StreamParseResult {
  summaryText: string;
  responseId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

async function parseResponseStream(
  stream: AsyncIterable<Record<string, unknown>>,
): Promise<StreamParseResult> {
  let summaryText = "";
  let responseId: string | undefined;
  let usage: StreamParseResult["usage"];

  for await (const event of stream) {
    const eventType = event.type as string | undefined;
    if (!eventType) continue;

    if (
      eventType === "response.output_text.delta" ||
      eventType === "response.text.delta"
    ) {
      const delta = event.delta as string | undefined;
      if (delta) {
        summaryText += delta;
      }
      continue;
    }

    if (eventType === "response.done" || eventType === "response.completed") {
      const response = event.response as Record<string, unknown> | undefined;
      const eventUsage = (response?.usage ?? event.usage) as
        | Record<string, unknown>
        | undefined;

      responseId =
        (response?.id as string | undefined) ??
        (event.response_id as string | undefined) ??
        responseId;

      if (eventUsage) {
        usage = {
          inputTokens:
            (eventUsage.input_tokens as number | undefined) ??
            (eventUsage.prompt_tokens as number | undefined),
          outputTokens:
            (eventUsage.output_tokens as number | undefined) ??
            (eventUsage.completion_tokens as number | undefined),
          totalTokens: eventUsage.total_tokens as number | undefined,
        };
      }

      if (!summaryText && Array.isArray(response?.output)) {
        for (const item of response.output as Array<Record<string, unknown>>) {
          if (item.type !== "message" || !Array.isArray(item.content)) continue;
          for (const contentItem of item.content as Array<
            Record<string, unknown>
          >) {
            if (
              contentItem.type === "output_text" &&
              typeof contentItem.text === "string"
            ) {
              summaryText += contentItem.text;
            }
          }
        }
      }
    }
  }

  return {
    summaryText: summaryText.trim(),
    responseId,
    usage,
  };
}

function maybeUnfenceJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function extractJsonObjectText(text: string): string {
  const input = maybeUnfenceJson(text);
  if (input.startsWith("{") && input.endsWith("}")) return input;

  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return input.slice(start, end + 1);
  }

  return input;
}

function evaluateSummary(summaryText: string): SummaryEvaluation {
  const issues: string[] = [];
  const warnings: string[] = [];
  const candidate = extractJsonObjectText(summaryText);

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(candidate) as JsonValue;
  } catch {
    return {
      validJson: false,
      schemaValid: false,
      issues: ["Output is not valid JSON."],
      warnings,
      preferredStatusWordCountValid: false,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      validJson: true,
      schemaValid: false,
      issues: ["Output JSON is not an object."],
      warnings,
      preferredStatusWordCountValid: false,
    };
  }

  const obj = parsed as Record<string, JsonValue>;

  let statusWordCount: number | undefined;
  let preferredStatusWordCountValid = false;

  const status = obj.status;
  if (typeof status !== "string" || !status.trim()) {
    issues.push("status must be a non-empty string.");
  } else {
    statusWordCount = status.trim().split(/\s+/).filter(Boolean).length;
    if (statusWordCount < 1 || statusWordCount > 5) {
      issues.push("status must be 1-5 words.");
    }
    preferredStatusWordCountValid =
      statusWordCount >= 1 && statusWordCount <= 3;
    if (statusWordCount > 3 && statusWordCount <= 5) {
      warnings.push("status exceeds preferred 1-3 word target.");
    }
  }

  const checkStringList = (
    key: "recent_actions" | "blockers" | "next_steps",
  ) => {
    const value = obj[key];
    if (!Array.isArray(value)) {
      issues.push(`${key} must be an array.`);
      return;
    }
    if (value.length > 3) {
      issues.push(`${key} must have at most 3 items.`);
    }
    if (value.some((item) => typeof item !== "string" || !item.trim())) {
      issues.push(`${key} items must be non-empty strings.`);
    }
  };

  checkStringList("recent_actions");
  checkStringList("blockers");
  checkStringList("next_steps");

  const confidence = obj.confidence;
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    issues.push("confidence must be a number between 0 and 1.");
  }

  return {
    validJson: true,
    schemaValid: issues.length === 0,
    issues,
    warnings,
    preferredStatusWordCountValid,
    statusWordCount,
  };
}

function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    const typed = error as Error & {
      status?: number;
      code?: string;
      type?: string;
    };

    return {
      name: typed.name,
      message: typed.message,
      status: typed.status,
      code: typed.code,
      type: typed.type,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

async function runBenchmarks(
  credentials: OAuthCredentials,
  config: BenchmarkConfig,
): Promise<ModelBenchmarkResult[]> {
  const defaultHeaders: Record<string, string> = {
    originator: "agentlink",
    session_id: randomUUID(),
    "User-Agent": `agentlink-benchmark/1.0 (${process.platform}; ${process.arch}) node/${process.version.slice(1)}`,
  };

  if (credentials.accountId) {
    defaultHeaders["ChatGPT-Account-Id"] = credentials.accountId;
  }

  const client = new OpenAI({
    apiKey: credentials.accessToken,
    baseURL: "https://chatgpt.com/backend-api/codex",
    defaultHeaders,
    maxRetries: 0,
  });

  const results: ModelBenchmarkResult[] = [];

  for (const model of config.models) {
    console.log(`\nBenchmarking model: ${model}`);
    const runs: BenchmarkRunResult[] = [];

    for (let runIndex = 1; runIndex <= config.runsPerModel; runIndex++) {
      const started = performance.now();

      try {
        const stream = (await client.responses.create(
          {
            model,
            instructions: config.prompt,
            input: [
              {
                role: "user",
                content: [{ type: "input_text", text: config.sampleText }],
              },
            ],
            stream: true,
            store: false,
          },
          {
            maxRetries: 0,
          },
        )) as AsyncIterable<Record<string, unknown>>;

        const parsed = await parseResponseStream(stream);
        const ended = performance.now();
        const evaluation = evaluateSummary(parsed.summaryText);

        const result: BenchmarkRunResult = {
          runIndex,
          ok: true,
          durationMs: ended - started,
          summaryText: parsed.summaryText,
          responseId: parsed.responseId,
          usage: parsed.usage,
          evaluation,
        };

        runs.push(result);
        const schemaBadge = evaluation.schemaValid ? "schema:ok" : "schema:bad";
        console.log(
          `  run ${runIndex}/${config.runsPerModel}: ok (${result.durationMs.toFixed(0)}ms, ${schemaBadge})`,
        );
      } catch (error) {
        const ended = performance.now();
        const err = toErrorInfo(error);

        if (error && typeof error === "object") {
          const maybeBody = (error as { body?: unknown; error?: unknown }).body;
          const maybeErrPayload = (error as { body?: unknown; error?: unknown })
            .error;
          if (!err.type && (maybeBody || maybeErrPayload)) {
            err.type = "api_error_payload";
          }
        }

        runs.push({
          runIndex,
          ok: false,
          durationMs: ended - started,
          error: err,
        });

        console.log(
          `  run ${runIndex}/${config.runsPerModel}: failed (${(ended - started).toFixed(0)}ms) - ${err.message}`,
        );
      }
    }

    const successRuns = runs.filter((run) => run.ok);
    const durations = successRuns.map((run) => run.durationMs);

    results.push({
      model,
      runs,
      aggregate: {
        successCount: successRuns.length,
        failureCount: runs.length - successRuns.length,
        avgDurationMs: average(durations),
        medianDurationMs: median(durations),
        minDurationMs: durations.length ? Math.min(...durations) : undefined,
        maxDurationMs: durations.length ? Math.max(...durations) : undefined,
        schemaValidCount: successRuns.filter(
          (run) => run.evaluation?.schemaValid,
        ).length,
        validJsonCount: successRuns.filter((run) => run.evaluation?.validJson)
          .length,
        preferredStatusWordCountValidCount: successRuns.filter(
          (run) => run.evaluation?.preferredStatusWordCountValid,
        ).length,
      },
    });
  }

  return results;
}

async function loadFileOrDefault(
  filePath: string | undefined,
  fallback: string,
): Promise<string> {
  if (!filePath) return fallback;
  const absolutePath = path.resolve(process.cwd(), filePath);
  return fs.readFile(absolutePath, "utf8");
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printUsage();
    return;
  }

  const prompt = await loadFileOrDefault(parsed.promptFile, DEFAULT_PROMPT);
  const sampleText = await loadFileOrDefault(
    parsed.sampleFile,
    DEFAULT_SAMPLE_TEXT,
  );

  const outputPath = path.resolve(
    process.cwd(),
    parsed.outputPath ?? makeDefaultOutputPath(),
  );

  const config: BenchmarkConfig = {
    models: parsed.models,
    runsPerModel: parsed.runsPerModel,
    outputPath,
    openBrowser: parsed.openBrowser,
    timeoutMs: parsed.timeoutMs,
    prompt,
    sampleText,
  };

  console.log("Configuration:");
  console.log(`  models: ${config.models.join(", ")}`);
  console.log(`  runs/model: ${config.runsPerModel}`);
  console.log(`  output: ${config.outputPath}`);

  const credentials = await runOAuthFlow({
    openBrowser: config.openBrowser,
    timeoutMs: config.timeoutMs,
  });

  console.log("OAuth success.");
  console.log(
    `  accountId: ${credentials.accountId ?? "(not present in token)"}`,
  );
  console.log(`  email: ${credentials.email ?? "(not present in token)"}`);

  const results = await runBenchmarks(credentials, config);

  const artifact: BenchmarkArtifact = {
    generatedAt: new Date().toISOString(),
    oauth: {
      accountIdHash: credentials.accountId
        ? sha256(credentials.accountId)
        : undefined,
      emailHash: credentials.email ? sha256(credentials.email) : undefined,
      expiresAt: credentials.expiresAt,
    },
    config: {
      models: config.models,
      runsPerModel: config.runsPerModel,
      outputPath: config.outputPath,
      openBrowser: config.openBrowser,
      timeoutMs: config.timeoutMs,
      promptHash: sha256(config.prompt),
      sampleTextHash: sha256(config.sampleText),
      sampleTextLength: config.sampleText.length,
    },
    prompt: config.prompt,
    sampleText: config.sampleText,
    results,
  };

  await fs.mkdir(path.dirname(config.outputPath), { recursive: true });
  await fs.writeFile(
    config.outputPath,
    JSON.stringify(artifact, null, 2),
    "utf8",
  );

  console.log("\nBenchmark complete.");
  for (const result of results) {
    const avg =
      result.aggregate.avgDurationMs !== undefined
        ? `${result.aggregate.avgDurationMs.toFixed(0)}ms`
        : "n/a";
    console.log(
      `  ${result.model}: success=${result.aggregate.successCount}/${result.runs.length}, avg=${avg}, schemaValid=${result.aggregate.schemaValidCount}, status1to3=${result.aggregate.preferredStatusWordCountValidCount}`,
    );
  }
  console.log(`\nSaved results to: ${config.outputPath}`);
}

main().catch((error) => {
  const err = toErrorInfo(error);
  console.error(`Fatal error: ${err.message}`);
  process.exitCode = 1;
});
