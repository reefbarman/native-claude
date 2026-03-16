import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener<T> = (value: T) => void;

class MockEventEmitter<T> {
  private listeners = new Set<Listener<T>>();

  event = (listener: Listener<T>) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

const mockWorkspace = {
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  createFileSystemWatcher: vi.fn(() => ({
    onDidChange: vi.fn(),
    onDidCreate: vi.fn(),
    onDidDelete: vi.fn(),
    dispose: vi.fn(),
  })),
  onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
  getConfiguration: vi.fn(() => ({
    get: vi.fn((_key: string, fallback?: unknown) => fallback),
  })),
};

vi.mock("vscode", () => ({
  EventEmitter: MockEventEmitter,
  workspace: mockWorkspace,
  window: {
    createOutputChannel: vi.fn(() => ({
      info: vi.fn(),
      dispose: vi.fn(),
    })),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    showTextDocument: vi.fn(() => Promise.resolve(undefined)),
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
  },
}));

class MockMemento {
  private store = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.store.has(key) ? this.store.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
      return;
    }
    this.store.set(key, value);
  }
}

describe("ApprovalManager session approval persistence", () => {
  const originalHome = process.env.HOME;
  let tempDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-approval-test-"),
    );
    workspaceDir = path.join(tempDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    process.env.HOME = tempDir;
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: workspaceDir } }];
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function createManagers(memento: MockMemento) {
    const { ConfigStore } = await import("./ConfigStore.js");
    const { ApprovalManager } = await import("./ApprovalManager.js");
    const configStore = new ConfigStore();
    const approvalManager = new ApprovalManager(memento as never, configStore);
    return { configStore, approvalManager };
  }

  it("persists session-scoped agent write approval across manager recreation", async () => {
    const memento = new MockMemento();
    const sessionId = "session-1";

    {
      const { approvalManager, configStore } = await createManagers(memento);
      approvalManager.setAgentWriteApproval(sessionId, "session");
      expect(approvalManager.isAgentWriteApproved(sessionId)).toBe(true);
      expect(approvalManager.getAgentWriteApprovalState(sessionId)).toBe(
        "session",
      );
      approvalManager.dispose();
      configStore.dispose();
    }

    {
      const { approvalManager, configStore } = await createManagers(memento);
      expect(approvalManager.isAgentWriteApproved(sessionId)).toBe(true);
      expect(approvalManager.getAgentWriteApprovalState(sessionId)).toBe(
        "session",
      );
      approvalManager.dispose();
      configStore.dispose();
    }
  });

  it("does not restore cleared session approval state", async () => {
    const memento = new MockMemento();
    const sessionId = "session-2";

    {
      const { approvalManager, configStore } = await createManagers(memento);
      approvalManager.setAgentWriteApproval(sessionId, "session");
      approvalManager.clearSession(sessionId);
      expect(approvalManager.isAgentWriteApproved(sessionId)).toBe(false);
      expect(approvalManager.getAgentWriteApprovalState(sessionId)).toBe(
        "prompt",
      );
      approvalManager.dispose();
      configStore.dispose();
    }

    {
      const { approvalManager, configStore } = await createManagers(memento);
      expect(approvalManager.isAgentWriteApproved(sessionId)).toBe(false);
      expect(approvalManager.getAgentWriteApprovalState(sessionId)).toBe(
        "prompt",
      );
      approvalManager.dispose();
      configStore.dispose();
    }
  });
});
