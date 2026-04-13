import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  TerminalManager,
  escapeHistoryExpansion,
  shouldEscapeHistoryExpansion,
} from "./TerminalManager.js";

type MockManagedTerminal = {
  id: string;
  name: string;
  cwd: string;
  busy: boolean;
  envKey?: string;
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

describe("shouldEscapeHistoryExpansion", () => {
  it("always escapes on non-windows platforms", () => {
    expect(shouldEscapeHistoryExpansion("linux", "/usr/bin/bash")).toBe(true);
    expect(shouldEscapeHistoryExpansion("darwin", "/bin/zsh")).toBe(true);
    expect(shouldEscapeHistoryExpansion("linux", undefined)).toBe(true);
  });

  it("escapes on windows only for bash-like shells", () => {
    expect(
      shouldEscapeHistoryExpansion(
        "win32",
        "C:\\Program Files\\Git\\bin\\bash.exe",
      ),
    ).toBe(true);
    expect(
      shouldEscapeHistoryExpansion("win32", "C:/msys64/usr/bin/bash.exe"),
    ).toBe(true);
    expect(shouldEscapeHistoryExpansion("win32", "C:/tools/zsh.exe")).toBe(
      true,
    );
  });

  it("does not escape on windows powershell/cmd or unknown shell", () => {
    expect(
      shouldEscapeHistoryExpansion(
        "win32",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ),
    ).toBe(false);
    expect(
      shouldEscapeHistoryExpansion("win32", "C:\\Windows\\System32\\cmd.exe"),
    ).toBe(false);
    expect(shouldEscapeHistoryExpansion("win32", undefined)).toBe(false);
  });
});

describe("escapeHistoryExpansion", () => {
  it("escapes unquoted and double-quoted exclamation marks", () => {
    expect(escapeHistoryExpansion("echo wow!")).toBe("echo wow\\!");
    expect(escapeHistoryExpansion('echo "wow!"')).toBe('echo "wow\\!"');
  });

  it("does not escape inside single quotes", () => {
    expect(escapeHistoryExpansion("echo 'wow!'")).toBe("echo 'wow!'");
  });

  it("preserves already escaped exclamation marks", () => {
    expect(escapeHistoryExpansion("echo wow\\!")).toBe("echo wow\\!");
  });

  it("handles windows git bash patterns used to wrap powershell", () => {
    const input =
      'powershell -NoProfile -Command "if (!(Test-Path $bashrc)) { Write-Output ok }"';
    const output = escapeHistoryExpansion(input);
    expect(output).toContain("if (\\!(Test-Path $bashrc))");
  });
});

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

    expect(createTerminalSpy).toHaveBeenCalledWith(
      "/workspace",
      "AgentLink",
      undefined,
    );
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

    expect(createTerminalSpy).toHaveBeenCalledWith(
      "/workspace",
      "AgentLink",
      undefined,
    );

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

  it("creates a separate default terminal when env map differs", async () => {
    const manager = new TerminalManager();

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const first = await manager.executeCommand({
      command: "echo first",
      cwd: "/workspace",
      env: { CI: "1" },
    });

    const second = await manager.executeCommand({
      command: "echo second",
      cwd: "/workspace",
      env: { CI: "0" },
    });

    expect(first.terminal_id).not.toBe(second.terminal_id);
  });

  it("rejects terminal_id reuse when env differs", async () => {
    const manager = new TerminalManager();

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const first = await manager.executeCommand({
      command: "echo first",
      cwd: "/workspace",
      env: { CI: "1" },
    });

    await expect(
      manager.executeCommand({
        command: "echo second",
        cwd: "/workspace",
        terminal_id: first.terminal_id,
      }),
    ).rejects.toThrow(/different env set/);
  });

  it("allows terminal_id reuse when env matches", async () => {
    const manager = new TerminalManager();

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const first = await manager.executeCommand({
      command: "echo first",
      cwd: "/workspace",
      env: { CI: "1" },
    });

    expect(manager.interruptTerminal(first.terminal_id)).toBe(true);

    const second = await manager.executeCommand({
      command: "echo second",
      cwd: "/workspace",
      terminal_id: first.terminal_id,
      env: { CI: "1" },
    });

    expect(second.terminal_id).toBe(first.terminal_id);
  });

  it("does not reuse a send_text fallback terminal while the prior command may still be running", async () => {
    const manager = new TerminalManager();

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const first = await manager.executeCommand({
      command: "long-running-command",
      cwd: "/workspace",
    });

    const second = await manager.executeCommand({
      command: "another-command",
      cwd: "/workspace",
    });

    expect(first.execution_mode).toBe("send_text");
    expect(second.execution_mode).toBe("send_text");
    expect(first.terminal_id).not.toBe(second.terminal_id);

    const firstState = manager.getBackgroundState(first.terminal_id);
    expect(firstState).toMatchObject({
      is_running: true,
      output_captured: false,
      exit_code: null,
    });
  });

  it("releases a send_text fallback reservation when interrupted", async () => {
    const manager = new TerminalManager();

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const first = await manager.executeCommand({
      command: "long-running-command",
      cwd: "/workspace",
    });

    const firstState = manager.getBackgroundState(first.terminal_id);
    expect(firstState?.is_running).toBe(true);

    expect(manager.interruptTerminal(first.terminal_id)).toBe(true);

    const releasedState = manager.getBackgroundState(first.terminal_id);
    expect(releasedState).toMatchObject({
      is_running: false,
      output_captured: false,
      exit_code: null,
    });

    const second = await manager.executeCommand({
      command: "after-interrupt",
      cwd: "/workspace",
      terminal_id: first.terminal_id,
    });

    expect(second.terminal_id).toBe(first.terminal_id);
  });
});
