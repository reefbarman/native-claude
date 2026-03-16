import { describe, it, expect, beforeEach, vi } from "vitest";

import { TerminalManager } from "./TerminalManager.js";

type MockManagedTerminal = {
  id: string;
  name: string;
  cwd: string;
  busy: boolean;
  backgroundRunning: boolean;
  lastCommandEndedAt: number;
  outputBuffer: string;
  backgroundExitCode: number | null;
  backgroundOutputCaptured: boolean;
  backgroundDisposables: Array<{ dispose(): void }>;
  terminal: {
    show: ReturnType<typeof vi.fn>;
    sendText: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    shellIntegration?: {
      cwd?: { fsPath: string };
      executeCommand: ReturnType<typeof vi.fn>;
    };
  };
};

describe("TerminalManager terminal selection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a new default terminal when the only idle default terminal has a different cwd", async () => {
    const manager = new TerminalManager();

    const existing = {
      id: "term_existing",
      name: "AgentLink",
      cwd: "/workspace/templates",
      busy: false,
      backgroundRunning: false,
      lastCommandEndedAt: 0,
      outputBuffer: "",
      backgroundExitCode: null,
      backgroundOutputCaptured: false,
      backgroundDisposables: [],
      terminal: {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
      },
    } satisfies MockManagedTerminal;

    const createTerminalSpy = vi
      .spyOn(
        manager as unknown as {
          createTerminal: (cwd: string, name: string) => MockManagedTerminal;
        },
        "createTerminal",
      )
      .mockImplementation((cwd: string, name: string) => ({
        id: "term_new",
        name,
        cwd,
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal: {
          show: vi.fn(),
          sendText: vi.fn(),
          dispose: vi.fn(),
        },
      }));

    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      existing,
    ];
    vi.spyOn(
      manager as unknown as {
        waitForCooldown: (managed: MockManagedTerminal) => Promise<void>;
      },
      "waitForCooldown",
    ).mockResolvedValue();
    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const result = await manager.executeCommand({
      command: "pwd",
      cwd: "/workspace",
    });

    expect(createTerminalSpy).toHaveBeenCalledWith("/workspace", "AgentLink");
    expect(result.terminal_id).toBe("term_new");
    expect(existing.terminal.sendText).not.toHaveBeenCalled();
  });

  it("marks a reused terminal busy before awaiting cooldown so concurrent callers cannot race onto it", async () => {
    const manager = new TerminalManager();

    const existing = {
      id: "term_existing",
      name: "AgentLink",
      cwd: "/workspace",
      busy: false,
      backgroundRunning: false,
      lastCommandEndedAt: 0,
      outputBuffer: "",
      backgroundExitCode: null,
      backgroundOutputCaptured: false,
      backgroundDisposables: [],
      terminal: {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
      },
    } satisfies MockManagedTerminal;

    let releaseCooldown: (() => void) | undefined;
    const cooldownPromise = new Promise<void>((resolve) => {
      releaseCooldown = resolve;
    });

    const waitForCooldownSpy = vi
      .spyOn(
        manager as unknown as {
          waitForCooldown: (managed: MockManagedTerminal) => Promise<void>;
        },
        "waitForCooldown",
      )
      .mockImplementation(async () => cooldownPromise);

    const createTerminalSpy = vi
      .spyOn(
        manager as unknown as {
          createTerminal: (cwd: string, name: string) => MockManagedTerminal;
        },
        "createTerminal",
      )
      .mockImplementation((cwd: string, name: string) => ({
        id: "term_new",
        name,
        cwd,
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal: {
          show: vi.fn(),
          sendText: vi.fn(),
          dispose: vi.fn(),
        },
      }));

    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      existing,
    ];
    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const first = manager.executeCommand({
      command: "echo first",
      cwd: "/workspace",
    });
    await Promise.resolve();

    expect(existing.busy).toBe(true);
    expect(waitForCooldownSpy).toHaveBeenCalledTimes(1);

    const second = manager.executeCommand({
      command: "echo second",
      cwd: "/workspace",
    });
    await Promise.resolve();

    expect(createTerminalSpy).toHaveBeenCalledWith("/workspace", "AgentLink");

    releaseCooldown?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.terminal_id).toBe("term_existing");
    expect(secondResult.terminal_id).toBe("term_new");
  });

  it("rejects execute_command when terminal_id targets a busy terminal", async () => {
    const manager = new TerminalManager();

    const existing = {
      id: "term_busy",
      name: "AgentLink",
      cwd: "/workspace",
      busy: true,
      backgroundRunning: false,
      lastCommandEndedAt: 0,
      outputBuffer: "",
      backgroundExitCode: null,
      backgroundOutputCaptured: false,
      backgroundDisposables: [],
      terminal: {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
      },
    } satisfies MockManagedTerminal;

    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      existing,
    ];

    await expect(
      manager.executeCommand({
        command: "echo blocked",
        cwd: "/workspace",
        terminal_id: "term_busy",
      }),
    ).rejects.toThrow(/Terminal term_busy is busy/);
  });

  it("returns explicit send_text execution metadata when shell integration is unavailable", async () => {
    const manager = new TerminalManager();

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const result = await manager.executeCommand({
      command: "echo no-capture",
      cwd: "/workspace/no-capture",
    });

    expect(result.output_captured).toBe(false);
    expect(result.execution_mode).toBe("send_text");
    expect(result.command_sent).toBe(true);
    expect(result.verification_hint).toContain("Do not re-run");
  });
});
