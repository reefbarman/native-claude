import * as vscode from "vscode";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  ElicitRequestSchema,
  CreateMessageRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition, JsonSchema } from "./providers/types.js";
import type { McpServerConfig } from "./mcpConfig.js";
import type { ToolResult } from "../shared/types.js";
import { McpOAuthProvider } from "./McpOAuthProvider.js";
import {
  buildAgentExecutionEnv,
  inheritProcessEnv,
} from "../process/agentExecutionPolicy.js";

export type McpServerStatus =
  | "connecting"
  | "connected"
  | "error"
  | "disconnected";

export interface McpServerInfo {
  name: string;
  status: McpServerStatus;
  error?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** Elicitation form field schema (subset of JSON Schema) */
export interface ElicitField {
  type: "string" | "number" | "boolean";
  title?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface ElicitRequest {
  serverName: string;
  message: string;
  fields: Record<string, ElicitField>;
  required: string[];
}

interface ConnectedServer {
  name: string;
  config: McpServerConfig;
  client: Client;
  tools: ToolDefinition[];
  resources: McpResource[];
  prompts: McpPrompt[];
  status: McpServerStatus;
  error?: string;
  retryCount: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

/**
 * McpClientHub manages connections to external MCP servers.
 *
 * Tool names are prefixed with the server name to avoid collisions: `servername__toolname`
 */
export class McpClientHub {
  private servers = new Map<string, ConnectedServer>();
  private oauthProviders = new Map<string, McpOAuthProvider>();
  private globalState?: vscode.Memento;

  constructor(globalState?: vscode.Memento) {
    this.globalState = globalState;
  }

  onStatusChange?: (servers: McpServerInfo[]) => void;

  /**
   * Called when an MCP server requests elicitation (a form for user input).
   * Resolve with the filled values, or reject/cancel to abort.
   */
  onElicitation?: (
    request: ElicitRequest,
    resolve: (values: Record<string, unknown>) => void,
    cancel: () => void,
  ) => void;

  /**
   * Called when an MCP server requests sampling (AI inference).
   * Should call Claude and return the result.
   */
  onSampling?: (params: {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    systemPrompt?: string;
    maxTokens: number;
    model?: string;
  }) => Promise<{ role: "assistant"; content: string }>;

  /** Connect to all configured servers, replacing existing connections. */
  async connect(configs: McpServerConfig[]): Promise<void> {
    const newNames = new Set(configs.map((c) => c.name));
    for (const name of this.servers.keys()) {
      if (!newNames.has(name)) await this.disconnectServer(name);
    }
    await Promise.all(configs.map((cfg) => this.connectServer(cfg)));
    this.onStatusChange?.(this.getServerInfos());
  }

  private async connectServer(
    cfg: McpServerConfig,
    retryCount = 0,
    afterAuth = false,
  ): Promise<void> {
    const existing = this.servers.get(cfg.name);
    if (existing?.status === "connected") return;

    // Cancel any pending retry
    if (existing?.retryTimer) clearTimeout(existing.retryTimer);

    // Get or create OAuth provider for HTTP servers
    let oauthProvider: McpOAuthProvider | undefined;
    const isHttpServer =
      cfg.type === "sse" ||
      cfg.type === "streamable-http" ||
      cfg.type === "http";
    if (isHttpServer && cfg.url && this.globalState) {
      oauthProvider = this.oauthProviders.get(cfg.name);
      if (!oauthProvider) {
        oauthProvider = new McpOAuthProvider(
          cfg.name,
          cfg.url,
          this.globalState,
        );
        this.oauthProviders.set(cfg.name, oauthProvider);
      }
      await oauthProvider.start();
    }

    const entry: ConnectedServer = {
      name: cfg.name,
      config: cfg,
      client: new Client(
        { name: "agentlink", version: "1.0.0" },
        {
          capabilities: {
            sampling: {},
            elicitation: {},
            roots: { listChanged: false },
          },
        },
      ),
      tools: [],
      resources: [],
      prompts: [],
      status: "connecting",
      retryCount,
    };
    this.servers.set(cfg.name, entry);
    this.onStatusChange?.(this.getServerInfos());

    try {
      const transport = this.createTransport(cfg, oauthProvider);

      // Reconnect on unexpected close
      transport.onclose = () => {
        const current = this.servers.get(cfg.name);
        if (!current || current.status === "disconnected") return;
        current.status = "disconnected";
        this.onStatusChange?.(this.getServerInfos());
        this.scheduleReconnect(cfg, (current.retryCount ?? 0) + 1);
      };

      // Register elicitation handler
      entry.client.setRequestHandler(ElicitRequestSchema, async (req) => {
        if (!this.onElicitation) {
          return { action: "cancel" as const };
        }
        const params = (req as { params: unknown }).params as {
          message?: string;
          requestedSchema?: {
            type: string;
            properties?: Record<string, unknown>;
            required?: string[];
          };
        };
        const properties = (params.requestedSchema?.properties ?? {}) as Record<
          string,
          ElicitField
        >;
        const required = params.requestedSchema?.required ?? [];
        return new Promise((resolve) => {
          this.onElicitation!(
            {
              serverName: cfg.name,
              message: params.message ?? "Please provide the required input.",
              fields: properties,
              required,
            },
            (values) => resolve({ action: "accept" as const, content: values }),
            () => resolve({ action: "cancel" as const }),
          );
        });
      });

      // Register sampling handler
      entry.client.setRequestHandler(
        CreateMessageRequestSchema,
        async (req) => {
          const params = (req as { params: unknown }).params as {
            messages?: Array<{
              role: string;
              content: { type: string; text?: string };
            }>;
            systemPrompt?: string;
            maxTokens?: number;
            modelPreferences?: { hints?: Array<{ name?: string }> };
          };

          if (!this.onSampling) {
            return {
              role: "assistant" as const,
              content: {
                type: "text" as const,
                text: "Sampling not available.",
              },
              model: "unavailable",
              stopReason: "end_turn" as const,
            };
          }

          const messages = (params.messages ?? [])
            .filter(
              (
                m,
              ): m is {
                role: "user" | "assistant";
                content: typeof m.content;
              } => m.role === "user" || m.role === "assistant",
            )
            .map((m) => ({
              role: m.role,
              content: m.content.text ?? "",
            }));

          const modelHint = params.modelPreferences?.hints?.[0]?.name;
          const result = await this.onSampling({
            messages,
            systemPrompt: params.systemPrompt,
            maxTokens: params.maxTokens ?? 1024,
            model: modelHint,
          });

          return {
            role: "assistant" as const,
            content: { type: "text" as const, text: result.content },
            model: modelHint ?? "claude",
            stopReason: "end_turn" as const,
          };
        },
      );

      await entry.client.connect(transport);
      entry.retryCount = 0;

      // Fetch tools, resources, prompts in parallel
      const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
        entry.client.listTools().catch(() => ({ tools: [] })),
        entry.client.listResources().catch(() => ({ resources: [] })),
        entry.client.listPrompts().catch(() => ({ prompts: [] })),
      ]);

      entry.tools = toolsResult.tools.map((t) => ({
        name: `${cfg.name}__${t.name}`,
        description: t.description ?? t.name,
        input_schema: (t.inputSchema ?? {
          type: "object",
          properties: {},
        }) as JsonSchema,
      }));

      entry.resources = resourcesResult.resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));

      entry.prompts = promptsResult.prompts.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      }));

      entry.status = "connected";
    } catch (err) {
      // After a 401, the SDK opens the browser via redirectToAuthorization (which
      // we await fully — it completes the token exchange before returning).
      // Tokens are now saved; retry once immediately without re-triggering auth.
      if (err instanceof UnauthorizedError && !afterAuth) {
        try {
          await entry.client.close();
        } catch {
          // best effort
        }
        this.servers.delete(cfg.name);
        this.onStatusChange?.(this.getServerInfos());
        await this.connectServer(cfg, 0, true /* afterAuth */);
        return;
      }

      entry.status = "error";
      entry.error = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect(cfg, retryCount + 1);
    }

    this.onStatusChange?.(this.getServerInfos());
  }

  private scheduleReconnect(cfg: McpServerConfig, attempt: number): void {
    const MAX_RETRIES = 5;
    if (attempt > MAX_RETRIES) return;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 30000); // 1s, 2s, 4s, 8s, 16s, cap 30s
    const entry = this.servers.get(cfg.name);
    if (!entry) return;
    entry.retryTimer = setTimeout(() => {
      this.connectServer(cfg, attempt);
    }, delay);
  }

  private createTransport(
    cfg: McpServerConfig,
    authProvider?: McpOAuthProvider,
  ) {
    const type = cfg.type ?? "stdio";

    if (type === "stdio") {
      if (!cfg.command)
        throw new Error(`Server '${cfg.name}' is stdio but missing 'command'`);
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: {
          ...inheritProcessEnv(),
          ...buildAgentExecutionEnv(),
          ...cfg.env,
        },
      });
    }

    if (type === "sse") {
      if (!cfg.url)
        throw new Error(`Server '${cfg.name}' is sse but missing 'url'`);
      const headers: Record<string, string> = {};
      if (cfg.headers) Object.assign(headers, cfg.headers);
      return new SSEClientTransport(new URL(cfg.url), {
        authProvider,
        requestInit: Object.keys(headers).length ? { headers } : undefined,
      });
    }

    if (type === "streamable-http" || type === "http") {
      if (!cfg.url)
        throw new Error(
          `Server '${cfg.name}' is streamable-http but missing 'url'`,
        );
      const headers: Record<string, string> = {};
      if (cfg.headers) Object.assign(headers, cfg.headers);
      return new StreamableHTTPClientTransport(new URL(cfg.url), {
        authProvider,
        requestInit: Object.keys(headers).length ? { headers } : undefined,
      });
    }

    throw new Error(
      `Unknown transport type '${type}' for server '${cfg.name}'`,
    );
  }

  private async disconnectServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) return;
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.status = "disconnected";
    try {
      await entry.client.close();
    } catch {
      // best effort
    }
    this.servers.delete(name);
    this.oauthProviders.get(name)?.stop();
    this.oauthProviders.delete(name);
  }

  /** Return the stored config for a server, or undefined if not connected. */
  getServerConfig(
    serverName: string,
  ): import("./mcpConfig.js").McpServerConfig | undefined {
    return this.servers.get(serverName)?.config;
  }

  /**
   * Clear stored OAuth tokens for a server (e.g. before /mcp-refresh when
   * auth is suspected to be broken).
   */
  async clearServerTokens(name: string): Promise<void> {
    await this.oauthProviders.get(name)?.clearTokens();
  }

  /** Disable (permanently disconnect) a server by name. Does not reconnect. */
  async disableServer(name: string): Promise<void> {
    await this.disconnectServer(name);
    this.onStatusChange?.(this.getServerInfos());
  }

  /** Reconnect a server by name using its stored config. */
  async reconnectServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    const cfg = entry?.config;
    if (!cfg) return;
    await this.disconnectServer(name);
    await this.connectServer(cfg, 0);
    this.onStatusChange?.(this.getServerInfos());
  }

  /** Force a fresh OAuth browser flow then reconnect. */
  async reauthenticateServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    const cfg = entry?.config;
    if (!cfg) return;

    await this.disconnectServer(name);

    const isHttpServer =
      cfg.type === "sse" ||
      cfg.type === "streamable-http" ||
      cfg.type === "http";
    if (isHttpServer && cfg.url && this.globalState) {
      // Create a fresh provider with a clean slate, run the full browser flow
      const provider = new McpOAuthProvider(
        cfg.name,
        cfg.url,
        this.globalState,
      );
      await provider.start();
      try {
        await provider.forceReauth();
      } finally {
        provider.stop();
      }
      // Store it so connectServer reuses it (and skips creating another)
      this.oauthProviders.set(cfg.name, provider);
    }

    await this.connectServer(cfg, 0);
    this.onStatusChange?.(this.getServerInfos());
  }

  /** Disconnect all servers. */
  async disconnectAll(): Promise<void> {
    await Promise.all(
      Array.from(this.servers.keys()).map((n) => this.disconnectServer(n)),
    );
    this.onStatusChange?.(this.getServerInfos());
  }

  /** All tool definitions from connected servers (prefixed). */
  getToolDefs(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const server of this.servers.values()) {
      if (server.status === "connected") tools.push(...server.tools);
    }
    return tools;
  }

  /** Get tool names only (for mode filtering). */
  getToolNames(): string[] {
    return this.getToolDefs().map((t) => t.name);
  }

  /** All resources from connected servers, keyed as `servername__uri`. */
  getAllResources(): Array<McpResource & { serverName: string }> {
    const resources: Array<McpResource & { serverName: string }> = [];
    for (const server of this.servers.values()) {
      if (server.status === "connected") {
        for (const r of server.resources) {
          resources.push({ ...r, serverName: server.name });
        }
      }
    }
    return resources;
  }

  /** All prompts from connected servers. */
  getAllPrompts(): Array<McpPrompt & { serverName: string }> {
    const prompts: Array<McpPrompt & { serverName: string }> = [];
    for (const server of this.servers.values()) {
      if (server.status === "connected") {
        for (const p of server.prompts) {
          prompts.push({ ...p, serverName: server.name });
        }
      }
    }
    return prompts;
  }

  getServerInfos(): McpServerInfo[] {
    return Array.from(this.servers.values()).map((s) => ({
      name: s.name,
      status: s.status,
      error: s.error,
      toolCount: s.tools.length,
      resourceCount: s.resources.length,
      promptCount: s.prompts.length,
    }));
  }

  /**
   * Dispatch a tool call to the appropriate MCP server.
   * Returns full ToolResult including image content where applicable.
   */
  async callTool(
    prefixedName: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const sep = prefixedName.indexOf("__");
    if (sep === -1) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Invalid MCP tool name: ${prefixedName}`,
            }),
          },
        ],
      };
    }

    const serverName = prefixedName.slice(0, sep);
    const toolName = prefixedName.slice(sep + 2);
    const server = this.servers.get(serverName);

    if (!server || server.status !== "connected") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `MCP server '${serverName}' is not connected`,
            }),
          },
        ],
      };
    }

    try {
      const result = await server.client.callTool({
        name: toolName,
        arguments: input,
      });
      const contentItems = result.content as Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
        resource?: {
          uri: string;
          text?: string;
          blob?: string;
          mimeType?: string;
        };
      }>;

      const mapped: ToolResult["content"] = [];
      for (const item of contentItems) {
        if (item.type === "text") {
          mapped.push({ type: "text", text: item.text ?? "" });
        } else if (item.type === "image" && item.data) {
          mapped.push({
            type: "image",
            data: item.data,
            mimeType: item.mimeType ?? "image/png",
          });
        } else if (item.type === "audio") {
          mapped.push({
            type: "text",
            text: `[Audio: ${item.mimeType ?? "audio"}]`,
          });
        } else if (item.type === "resource" && item.resource) {
          const r = item.resource;
          if (r.text !== undefined) {
            mapped.push({ type: "text", text: r.text });
          } else if (r.blob) {
            const mime = r.mimeType ?? "";
            if (mime.startsWith("image/")) {
              mapped.push({ type: "image", data: r.blob, mimeType: mime });
            } else {
              mapped.push({
                type: "text",
                text: `[Binary resource: ${r.uri}]`,
              });
            }
          }
        } else {
          mapped.push({ type: "text", text: `[${item.type}]` });
        }
      }

      if (mapped.length === 0) {
        mapped.push({ type: "text", text: "" });
      }

      return { content: mapped };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
      };
    }
  }

  /**
   * Read a specific resource from an MCP server.
   * Pass `servername__uri` or just `uri` if serverName is provided separately.
   */
  async readResource(serverName: string, uri: string): Promise<ToolResult> {
    const server = this.servers.get(serverName);
    if (!server || server.status !== "connected") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Server '${serverName}' not connected`,
            }),
          },
        ],
      };
    }
    try {
      const result = await server.client.readResource({ uri });
      const parts: ToolResult["content"] = [];
      for (const c of result.contents) {
        if ("text" in c && c.text !== undefined) {
          parts.push({ type: "text", text: c.text });
        } else if ("blob" in c && c.blob) {
          const mime = c.mimeType ?? "";
          if (mime.startsWith("image/")) {
            parts.push({ type: "image", data: c.blob, mimeType: mime });
          } else {
            parts.push({ type: "text", text: `[Binary: ${uri}]` });
          }
        }
      }
      return { content: parts.length ? parts : [{ type: "text", text: "" }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
      };
    }
  }

  /**
   * Get a prompt from an MCP server and return its messages as text.
   */
  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string>,
  ): Promise<ToolResult> {
    const server = this.servers.get(serverName);
    if (!server || server.status !== "connected") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Server '${serverName}' not connected`,
            }),
          },
        ],
      };
    }
    try {
      const result = await server.client.getPrompt({
        name: promptName,
        arguments: args,
      });
      const text = result.messages
        .map((m) => {
          const content =
            m.content.type === "text" ? m.content.text : `[${m.content.type}]`;
          return `${m.role}: ${content}`;
        })
        .join("\n\n");
      return { content: [{ type: "text", text: text || "" }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
      };
    }
  }

  /** True if a tool name belongs to an MCP server (contains '__'). */
  static isMcpTool(name: string): boolean {
    return name.includes("__");
  }
}
