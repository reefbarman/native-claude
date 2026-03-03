import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import type * as http from "http";

import type * as vscode from "vscode";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolCallTracker } from "./ToolCallTracker.js";
import { registerTools } from "./registerTools.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
  clientInfo?: { name: string; version: string };
  /** Whether this session has completed the workspace handshake. */
  trusted: boolean;
  /** Number of consecutive failed trust attempts (handshake failures + gated tool rejections). */
  trustAttempts: number;
}

const SESSION_IDLE_TTL = 30 * 60_000; // 30 minutes
const CLEANUP_INTERVAL = 5 * 60_000; // 5 minutes

// ── In-memory event store for SSE resumability ──────────────────────────────
// When a client disconnects mid-tool-call (e.g. during a long apply_diff review),
// the tool response would normally be lost. With an event store, responses are
// persisted and can be replayed when the client reconnects with Last-Event-ID.
const EVENT_STORE_MAX_AGE = 60 * 60_000; // 1 hour

interface StoredEvent {
  streamId: string;
  message: JSONRPCMessage;
  timestamp: number;
}

class InMemoryEventStore implements EventStore {
  private events = new Map<string, StoredEvent>();

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = `${streamId}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    this.events.set(eventId, { streamId, message, timestamp: Date.now() });
    this.prune();
    return eventId;
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return this.events.get(eventId)?.streamId;
  }

  async replayEventsAfter(
    lastEventId: string,
    {
      send,
    }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    const entry = this.events.get(lastEventId);
    if (!entry) return "";

    const { streamId } = entry;
    let found = false;
    const sorted = [...this.events.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [eventId, ev] of sorted) {
      if (ev.streamId !== streamId) continue;
      if (eventId === lastEventId) {
        found = true;
        continue;
      }
      if (found) await send(eventId, ev.message);
    }
    return streamId;
  }

  private prune(): void {
    const cutoff = Date.now() - EVENT_STORE_MAX_AGE;
    for (const [id, ev] of this.events) {
      if (ev.timestamp < cutoff) this.events.delete(id);
    }
  }
}

export class McpServerHost {
  private sessions = new Map<string, Session>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private authToken: string | undefined;
  private approvalManager: ApprovalManager;
  private approvalPanel: ApprovalPanelProvider;

  private tracker: ToolCallTracker;
  private extensionUri: vscode.Uri;

  /** Fired when sessions are created, initialized with clientInfo, closed, or pruned. */
  onSessionChanged?: () => void;

  constructor(
    authToken: string | undefined,
    approvalManager: ApprovalManager,
    approvalPanel: ApprovalPanelProvider,
    tracker: ToolCallTracker,
    extensionUri: vscode.Uri,
  ) {
    this.authToken = authToken;
    this.approvalManager = approvalManager;
    this.approvalPanel = approvalPanel;
    this.tracker = tracker;
    this.extensionUri = extensionUri;
    this.cleanupInterval = setInterval(
      () => this.pruneIdleSessions(),
      CLEANUP_INTERVAL,
    );
  }

  async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    // Auth check
    if (this.authToken && !this.validateAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Existing session → route to its transport
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, parsedBody);
      return;
    }

    // Unknown session ID → create a new session reusing the old ID.
    // This allows clients to recover transparently after server restart/reload
    // instead of getting stuck on 404 errors.

    // No session ID → new client connecting
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId ?? randomUUID(),
      eventStore: new InMemoryEventStore(),
      retryInterval: 5_000, // suggest 5s reconnect to clients
    });

    const server = new McpServer({
      name: "agentlink",
      version: "0.1.0",
    });

    // Trust closures — passed to registerTools so the handshake tool and
    // requireTrust gate can read/write per-session trust state.
    const getSid = () => transport.sessionId ?? "";
    const isSessionTrusted = (): boolean =>
      this.sessions.get(getSid())?.trusted ?? false;
    const markSessionTrusted = (): void => {
      const s = this.sessions.get(getSid());
      if (s) {
        s.trusted = true;
        s.trustAttempts = 0;
      }
    };
    const getTrustAttempts = (): number =>
      this.sessions.get(getSid())?.trustAttempts ?? 0;
    const incrementTrustAttempts = (): void => {
      const s = this.sessions.get(getSid());
      if (s) s.trustAttempts++;
    };

    registerTools(
      server,
      this.approvalManager,
      this.approvalPanel,
      () => transport.sessionId,
      this.tracker,
      this.extensionUri,
      {
        isSessionTrusted,
        markSessionTrusted,
        getTrustAttempts,
        incrementTrustAttempts,
      },
    );
    await server.connect(transport);

    // Capture client identity after MCP initialization completes
    server.server.oninitialized = () => {
      const clientVersion = server.server.getClientVersion();
      if (clientVersion && transport.sessionId) {
        const session = this.sessions.get(transport.sessionId);
        if (session) {
          session.clientInfo = {
            name: clientVersion.name,
            version: clientVersion.version,
          };
          this.onSessionChanged?.();
        }
      }
    };

    // Handle the initialization request
    await transport.handleRequest(req, res, parsedBody);

    // Store session for future requests
    if (transport.sessionId) {
      this.sessions.set(transport.sessionId, {
        transport,
        server,
        lastActivity: Date.now(),
        trusted: false,
        trustAttempts: 0,
      });
      this.onSessionChanged?.();
    }

    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
        this.onSessionChanged?.();
      }
    };
  }

  private validateAuth(req: http.IncomingMessage): boolean {
    if (!this.authToken) {
      return true;
    }
    const header = req.headers.authorization;
    if (!header) {
      return false;
    }
    const [scheme, token] = header.split(" ", 2);
    return scheme === "Bearer" && token === this.authToken;
  }

  private pruneIdleSessions(): void {
    const now = Date.now();
    let pruned = false;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_IDLE_TTL) {
        session.transport.close().catch(() => {});
        session.server.close().catch(() => {});
        this.sessions.delete(id);
        pruned = true;
      }
    }
    if (pruned) {
      this.onSessionChanged?.();
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  getSessionInfos(): Array<{
    id: string;
    clientName?: string;
    clientVersion?: string;
    lastActivity: number;
    trusted: boolean;
  }> {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      clientName: s.clientInfo?.name,
      clientVersion: s.clientInfo?.version,
      lastActivity: s.lastActivity,
      trusted: s.trusted,
    }));
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupInterval);
    for (const [, session] of this.sessions) {
      await session.transport.close().catch(() => {});
      await session.server.close().catch(() => {});
    }
    this.sessions.clear();
  }
}
