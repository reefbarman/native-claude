import { describe, it, expect } from "vitest";
import type * as vscode from "vscode";
import { McpOAuthProvider } from "./McpOAuthProvider.js";

class FakeMemento implements vscode.Memento {
  private store = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) return this.store.get(key) as T;
    return defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

describe("McpOAuthProvider callback port reuse", () => {
  it("reuses cached localhost redirect port when available", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_notion_client", {
      client_id: "cid",
      redirect_uris: ["http://localhost:45671/callback"],
    });

    const provider = new McpOAuthProvider(
      "notion",
      "https://mcp.notion.example",
      storage,
    );

    await provider.start();

    try {
      expect(provider.redirectUrl).toBe("http://localhost:45671/callback");
    } finally {
      provider.stop();
    }
  });

  it("falls back to ephemeral port when cached localhost redirect port is unavailable", async () => {
    const storage = new FakeMemento();
    await storage.update("mcp_oauth_notion_client", {
      client_id: "cid",
      redirect_uris: ["http://localhost:45672/callback"],
    });

    const first = new McpOAuthProvider(
      "notion",
      "https://mcp.notion.example",
      storage,
    );
    await first.start();

    const second = new McpOAuthProvider(
      "notion",
      "https://mcp.notion.example",
      storage,
    );

    try {
      await second.start();
      expect(second.redirectUrl).not.toBe("http://localhost:45672/callback");
      expect(second.redirectUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    } finally {
      second.stop();
      first.stop();
    }
  });
});
