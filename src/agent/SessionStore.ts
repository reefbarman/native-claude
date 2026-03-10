import * as fs from "fs";
import * as path from "path";
import type { AgentMessage, SessionInfo } from "./types.js";

/**
 * Persisted session index entry — lightweight metadata kept in sessions.json.
 * Full message history lives in {sessionId}/messages.json.
 */
export interface SessionSummary {
  schemaVersion: number;
  id: string;
  mode: string;
  model: string;
  title: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: number;
  lastActiveAt: number;
}

interface MessagesFile {
  schemaVersion: number;
  messages: AgentMessage[];
}

interface MetadataFile {
  schemaVersion: number;
  mode: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  lastInputTokens?: number;
  lastCacheReadTokens?: number;
}

const SCHEMA_VERSION = 1;
const SESSIONS_FILE = "sessions.json";
const AGENTLINK_GITIGNORE_ENTRIES = [
  "history/",
  "transcripts/",
  "debug/",
  "checkpoints/",
] as const;

/**
 * Persists agent sessions to .agentlink/history/{sessionId}/.
 *
 * Layout:
 *   .agentlink/history/sessions.json          — session index
 *   .agentlink/history/{id}/messages.json     — full message history
 *   .agentlink/history/{id}/metadata.json     — mode, model, token totals
 */
export class SessionStore {
  private readonly historyDir: string;
  private readonly sessionsFile: string;
  /** In-memory index — updated on every save/delete/rename */
  private index: Map<string, SessionSummary> = new Map();

  constructor(workspaceDir: string) {
    this.historyDir = path.join(workspaceDir, ".agentlink", "history");
    this.sessionsFile = path.join(this.historyDir, SESSIONS_FILE);
    this.ensureGitignore(path.join(workspaceDir, ".agentlink"));
    this.loadIndex();
  }

  // ---------------------------------------------------------------------------
  // Index management
  // ---------------------------------------------------------------------------

  private loadIndex(): void {
    try {
      const raw = fs.readFileSync(this.sessionsFile, "utf-8");
      const parsed = JSON.parse(raw) as SessionSummary[];
      this.index = new Map(parsed.map((s) => [s.id, s]));
    } catch {
      // File doesn't exist yet or is corrupt — start fresh
      this.index = new Map();
    }
  }

  private flushIndex(): void {
    this.ensureDir(this.historyDir);
    const arr = Array.from(this.index.values()).sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt,
    );
    fs.writeFileSync(this.sessionsFile, JSON.stringify(arr, null, 2), "utf-8");
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Save/update a session to disk.
   * Called after each API response (on `done` event) and after condensing.
   */
  save(session: {
    id: string;
    mode: string;
    model: string;
    title: string;
    createdAt: number;
    lastActiveAt: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    lastInputTokens: number;
    lastCacheReadTokens: number;
    getAllMessages(): AgentMessage[];
  }): void {
    const sessionDir = path.join(this.historyDir, session.id);
    this.ensureDir(sessionDir);

    // Write messages
    const messagesFile: MessagesFile = {
      schemaVersion: SCHEMA_VERSION,
      messages: session.getAllMessages(),
    };
    fs.writeFileSync(
      path.join(sessionDir, "messages.json"),
      JSON.stringify(messagesFile, null, 2),
      "utf-8",
    );

    // Write metadata
    const metaFile: MetadataFile = {
      schemaVersion: SCHEMA_VERSION,
      mode: session.mode,
      model: session.model,
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      totalCacheReadTokens: session.totalCacheReadTokens,
      totalCacheCreationTokens: session.totalCacheCreationTokens,
      lastInputTokens: session.lastInputTokens,
      lastCacheReadTokens: session.lastCacheReadTokens,
    };
    fs.writeFileSync(
      path.join(sessionDir, "metadata.json"),
      JSON.stringify(metaFile, null, 2),
      "utf-8",
    );

    // Update index
    const messages = session.getAllMessages();
    const summary: SessionSummary = {
      schemaVersion: SCHEMA_VERSION,
      id: session.id,
      mode: session.mode,
      model: session.model,
      title: session.title,
      messageCount: messages.length,
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    };
    this.index.set(session.id, summary);
    this.flushIndex();
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * List all sessions, sorted by lastActiveAt descending.
   */
  list(): SessionSummary[] {
    return Array.from(this.index.values()).sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt,
    );
  }

  /**
   * Load full message history for a session.
   * Returns null if the session doesn't exist or files are corrupt.
   */
  loadMessages(sessionId: string): AgentMessage[] | null {
    const file = path.join(this.historyDir, sessionId, "messages.json");
    try {
      const raw = fs.readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw) as MessagesFile;
      return parsed.messages ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Load metadata for a session.
   */
  loadMetadata(sessionId: string): MetadataFile | null {
    const file = path.join(this.historyDir, sessionId, "metadata.json");
    try {
      const raw = fs.readFileSync(file, "utf-8");
      return JSON.parse(raw) as MetadataFile;
    } catch {
      return null;
    }
  }

  get(sessionId: string): SessionSummary | undefined {
    return this.index.get(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  rename(sessionId: string, title: string): boolean {
    const entry = this.index.get(sessionId);
    if (!entry) return false;
    entry.title = title;
    this.index.set(sessionId, entry);
    this.flushIndex();
    return true;
  }

  delete(sessionId: string): boolean {
    if (!this.index.has(sessionId)) return false;
    this.index.delete(sessionId);
    this.flushIndex();

    // Remove session directory
    const sessionDir = path.join(this.historyDir, sessionId);
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Ensure .agentlink/.gitignore includes required runtime folders so generated
   * artifacts are never committed.
   */
  private ensureGitignore(agentlinkDir: string): void {
    const gitignorePath = path.join(agentlinkDir, ".gitignore");
    try {
      this.ensureDir(agentlinkDir);
      const content = this.readFileIfExists(gitignorePath);

      // Match full normalized lines to avoid false positives like "my-history/"
      const existingEntries = new Set(
        content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      );

      const missingEntries = AGENTLINK_GITIGNORE_ENTRIES.filter(
        (entry) => !existingEntries.has(entry),
      );

      if (missingEntries.length === 0) return;

      // Append only what is missing to minimize writes and preserve file ordering.
      const prefix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
      fs.appendFileSync(
        gitignorePath,
        `${prefix}${missingEntries.join("\n")}\n`,
        "utf-8",
      );
    } catch {
      // Best-effort — don't block startup
    }
  }

  private readFileIfExists(filePath: string): string {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return "";
      }
      throw error;
    }
  }

  /** Convert a SessionInfo (in-memory) to a SessionSummary (persisted) */
  static infoToSummary(info: SessionInfo): SessionSummary {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: info.id,
      mode: info.mode,
      model: info.model,
      title: info.title,
      messageCount: info.messageCount,
      totalInputTokens: info.totalInputTokens,
      totalOutputTokens: info.totalOutputTokens,
      createdAt: info.createdAt,
      lastActiveAt: info.lastActiveAt,
    };
  }
}
