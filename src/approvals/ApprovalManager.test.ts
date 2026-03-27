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

  it("supports file-level agent write approval when a matching write rule exists", async () => {
    const memento = new MockMemento();
    const sessionId = "session-file-rule";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      sessionId,
      { pattern: "src/feature", mode: "glob" },
      "session",
    );

    expect(
      approvalManager.isAgentWriteApproved(sessionId, "src/feature/file.ts"),
    ).toBe(true);
    expect(
      approvalManager.isAgentWriteApproved(
        sessionId,
        "src/feature/nested/file.ts",
      ),
    ).toBe(true);
    expect(
      approvalManager.isAgentWriteApproved(sessionId, "src/other/file.ts"),
    ).toBe(false);

    approvalManager.dispose();
    configStore.dispose();
  });

  it("does not auto-approve agent writes without file path unless blanket trust exists", async () => {
    const memento = new MockMemento();
    const sessionId = "session-no-file";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      sessionId,
      { pattern: "src/feature", mode: "glob" },
      "session",
    );

    expect(approvalManager.isAgentWriteApproved(sessionId)).toBe(false);

    approvalManager.dispose();
    configStore.dispose();
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

  it("treats a bare directory glob rule as recursive for descendant files", async () => {
    const memento = new MockMemento();
    const sessionId = "session-3";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      sessionId,
      { pattern: "src/feature", mode: "glob" },
      "session",
    );

    expect(
      approvalManager.isFileWriteApproved(sessionId, "src/feature/file.ts"),
    ).toBe(true);
    expect(
      approvalManager.isFileWriteApproved(
        sessionId,
        "src/feature/nested/file.ts",
      ),
    ).toBe(true);
    expect(
      approvalManager.isFileWriteApproved(
        sessionId,
        "src/feature-other/file.ts",
      ),
    ).toBe(false);

    approvalManager.dispose();
    configStore.dispose();
  });

  it("surfaces session write rules in active session state", async () => {
    const memento = new MockMemento();
    const sessionId = "session-4";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      sessionId,
      { pattern: "src/feature", mode: "glob" },
      "session",
    );

    expect(approvalManager.getWriteRules(sessionId).session).toEqual([
      { pattern: "src/feature", mode: "glob" },
    ]);
    expect(approvalManager.getActiveSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sessionId,
          writeRuleCount: 1,
        }),
      ]),
    );

    approvalManager.dispose();
    configStore.dispose();
  });

  it("treats a bare directory prefix rule as recursive without overmatching siblings", async () => {
    const memento = new MockMemento();
    const sessionId = "session-5";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      sessionId,
      { pattern: "src/feat", mode: "prefix" },
      "session",
    );

    expect(
      approvalManager.isFileWriteApproved(sessionId, "src/feat/file.ts"),
    ).toBe(true);
    expect(
      approvalManager.isFileWriteApproved(sessionId, "src/feat/nested/file.ts"),
    ).toBe(true);
    expect(
      approvalManager.isFileWriteApproved(sessionId, "src/feature/file.ts"),
    ).toBe(false);

    approvalManager.dispose();
    configStore.dispose();
  });

  it("applies the bare directory heuristic to trusted path rules", async () => {
    const memento = new MockMemento();
    const sessionId = "session-6";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addPathRule(
      sessionId,
      { pattern: "src/feature", mode: "glob" },
      "session",
    );

    expect(
      approvalManager.isPathTrusted(sessionId, "src/feature/file.ts"),
    ).toBe(true);
    expect(
      approvalManager.isPathTrusted(sessionId, "src/feature/nested/file.ts"),
    ).toBe(true);
    expect(
      approvalManager.isPathTrusted(sessionId, "src/feature-other/file.ts"),
    ).toBe(false);

    approvalManager.dispose();
    configStore.dispose();
  });

  it("normalizes backslashes in custom directory rules", async () => {
    const memento = new MockMemento();
    const sessionId = "session-7";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      sessionId,
      { pattern: "src\\feature", mode: "glob" },
      "session",
    );

    expect(
      approvalManager.isFileWriteApproved(sessionId, "src/feature/file.ts"),
    ).toBe(true);

    approvalManager.dispose();
    configStore.dispose();
  });

  it("merges placeholder approval state into an existing real session", async () => {
    const memento = new MockMemento();

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      "agent",
      { pattern: "src/from-placeholder", mode: "glob" },
      "session",
    );
    approvalManager.addWriteRule(
      "real-session",
      { pattern: "src/from-real", mode: "glob" },
      "session",
    );
    approvalManager.addPathRule(
      "agent",
      { pattern: "outside/path", mode: "glob" },
      "session",
    );
    approvalManager.setAgentWriteApproval("agent", "session");

    approvalManager.migrateSessionState("agent", "real-session");

    expect(approvalManager.getWriteRules("real-session").session).toEqual(
      expect.arrayContaining([
        { pattern: "src/from-placeholder", mode: "glob" },
        { pattern: "src/from-real", mode: "glob" },
      ]),
    );
    expect(approvalManager.getPathRules("real-session").session).toEqual([
      { pattern: "outside/path", mode: "glob" },
    ]);
    expect(approvalManager.getAgentWriteApprovalState("real-session")).toBe(
      "session",
    );
    expect(approvalManager.getWriteRules("agent").session).toEqual([]);
    expect(approvalManager.getPathRules("agent").session).toEqual([]);

    approvalManager.dispose();
    configStore.dispose();
  });
});
