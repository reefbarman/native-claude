import * as vscode from "vscode";

import { cleanTerminalOutput } from "../util/ansi.js";
import { buildAgentExecutionEnv } from "../process/agentExecutionPolicy.js";

let terminalIconPath: vscode.Uri | undefined;

/**
 * Escape `!` characters that would trigger shell history expansion.
 * History expansion occurs in unquoted and double-quoted contexts but NOT
 * inside single quotes. Walks the string tracking quote state and replaces
 * unprotected `!` with `\!`.
 */
export function escapeHistoryExpansion(command: string): string {
  if (!command.includes("!")) return command;
  let result = "";
  let inSingle = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const prev = i > 0 ? command[i - 1] : "";
    if (ch === "'" && prev !== "\\") {
      inSingle = !inSingle;
      result += ch;
    } else if (ch === "!" && !inSingle && prev !== "\\") {
      result += "\\!";
    } else {
      result += ch;
    }
  }
  return result;
}

export function initializeTerminalManager(
  extensionUri: vscode.Uri,
  log?: (message: string) => void,
): void {
  terminalIconPath = vscode.Uri.joinPath(
    extensionUri,
    "media",
    "agentlink-terminal.svg",
  );
  if (log) {
    getTerminalManager().log = log;
  }
}

interface ManagedTerminal {
  id: string;
  terminal: vscode.Terminal;
  name: string;
  cwd: string;
  busy: boolean;
  /** Timestamp when the last foreground command completed — used for reuse cooldown */
  lastCommandEndedAt: number;
  /** Accumulated output from the current shell integration execution */
  outputBuffer: string;
  /** True while a background command is actively running */
  backgroundRunning: boolean;
  /** Exit code of the completed background command (null while running or if unknown) */
  backgroundExitCode: number | null;
  /** Whether output was captured for the background command */
  backgroundOutputCaptured: boolean;
  /** Disposables for background listeners (stream reader, exit listener) */
  backgroundDisposables: vscode.Disposable[];
}

export interface CommandResult {
  exit_code: number | null;
  output: string;
  cwd?: string;
  output_captured: boolean;
  terminal_id: string;
  output_file?: string;
  output_warning?: string;
  total_lines?: number;
  lines_shown?: number;
  command?: string;
  command_modified?: boolean;
  original_command?: string;
  follow_up?: string;
  timed_out?: boolean;
  execution_mode?: "shell_integration" | "send_text";
  verification_hint?: string;
  command_sent?: boolean;
}

export interface ExecuteOptions {
  command: string;
  cwd: string;
  terminal_id?: string;
  terminal_name?: string;
  /** Split the new terminal alongside this terminal (by id or name) */
  split_from?: string;
  background?: boolean;
  timeout?: number;
  /** Called once the terminal is resolved, before execution begins */
  onTerminalAssigned?: (terminalId: string) => void;
}

const SHELL_INTEGRATION_TIMEOUT = 15000; // 15 seconds (WSL2 / heavy shell configs can be slow)

/** OSC 633;D completion marker emitted by VS Code shell integration */
// oxlint-disable-next-line no-control-regex -- intentionally matching ANSI escape sequences
const MARKER_RE = /\x1b\]633;D(?:;(\d+))?(?:\x07|\x1b\\)/;

/**
 * Check the output buffer for an OSC 633;D completion marker.
 * If found, strips the marker from the buffer, returns the parsed exit code.
 * @param buffer The output buffer to scan
 * @param fromPos Start scanning from this position (with 20-char overlap for split markers)
 * @returns `{ exitCode, stripped }` if found, `undefined` otherwise
 */
function findAndStripMarker(
  buffer: string,
  fromPos: number,
): { exitCode: number | null; stripped: string } | undefined {
  const searchFrom = Math.max(0, fromPos - 20);
  const region = buffer.slice(searchFrom);
  const match = region.match(MARKER_RE);
  if (!match) return undefined;
  // Use the match index within the region to find the exact marker position,
  // rather than lastIndexOf on the full buffer which could find a stale marker.
  const markerIdx = match.index !== undefined ? searchFrom + match.index : -1;
  const stripped = markerIdx >= 0 ? buffer.slice(0, markerIdx) : buffer;
  const exitCode = match[1] !== undefined ? parseInt(match[1], 10) : null;
  return { exitCode, stripped };
}

let nextTerminalId = 1;

export class TerminalManager {
  private terminals: ManagedTerminal[] = [];
  private disposables: vscode.Disposable[] = [];
  log?: (message: string) => void;

  /**
   * Rolling window of startup latencies (ms from executeCommand call to
   * onDidStartTerminalShellExecution firing). Used to understand typical
   * shell integration overhead so we can tune fallback timeouts.
   */
  private startupLatencies: number[] = [];
  private static readonly MAX_LATENCY_SAMPLES = 50;

  /**
   * Minimum ms between finishing one command and starting another on the
   * same terminal.  Prevents shell integration event loss caused by sending
   * a new command before the shell has fully processed the previous
   * command's OSC 633 completion sequences.
   */
  private static readonly REUSE_COOLDOWN_MS = 500;

  /** Wait until the terminal's reuse cooldown has elapsed. */
  private async waitForCooldown(managed: ManagedTerminal): Promise<void> {
    const remaining =
      TerminalManager.REUSE_COOLDOWN_MS -
      (Date.now() - managed.lastCommandEndedAt);
    if (remaining > 0) {
      this.log?.(
        `[cooldown] waiting ${remaining}ms for terminal ${managed.id} to be ready`,
      );
      await new Promise((r) => setTimeout(r, remaining));
    }
  }

  /** Record a startup latency sample and log the rolling stats. */
  private recordStartupLatency(latencyMs: number): void {
    // Skip extreme outliers (from cancelled/stuck commands with stale listeners)
    if (latencyMs > 30_000) return;
    this.startupLatencies.push(latencyMs);
    if (this.startupLatencies.length > TerminalManager.MAX_LATENCY_SAMPLES) {
      this.startupLatencies.shift();
    }
    const sorted = [...this.startupLatencies].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    this.log?.(
      `[startup-latency] sample=${latencyMs}ms n=${sorted.length} ` +
        `min=${min}ms median=${median}ms p95=${p95}ms max=${max}ms`,
    );
  }

  constructor() {
    // Clean up terminals that get closed
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closedTerminal) => {
        const closing = this.terminals.filter(
          (t) => t.terminal === closedTerminal,
        );
        for (const managed of closing) {
          for (const d of managed.backgroundDisposables) d.dispose();
          managed.backgroundDisposables = [];
        }
        this.terminals = this.terminals.filter(
          (t) => t.terminal !== closedTerminal,
        );
      }),
    );
  }

  async executeCommand(options: ExecuteOptions): Promise<CommandResult> {
    // Escape ! characters to prevent shell history expansion in
    // interactive terminals (zsh/bash treat ! specially in double quotes).
    const command =
      process.platform !== "win32"
        ? escapeHistoryExpansion(options.command)
        : options.command;

    const managed = await this.resolveTerminal(options);
    options.onTerminalAssigned?.(managed.id);

    try {
      // Show the terminal so the user can see it
      managed.terminal.show(true); // preserveFocus = true

      // Wait for shell integration
      const hasShellIntegration = await this.waitForShellIntegration(
        managed.terminal,
      );

      if (options.background) {
        return this.executeBackground(managed, command, hasShellIntegration);
      }

      if (hasShellIntegration) {
        return await this.executeWithShellIntegration(
          managed,
          command,
          options.timeout,
        );
      } else {
        return this.executeWithSendText(managed, command);
      }
    } finally {
      managed.lastCommandEndedAt = Date.now();
      managed.busy = false;
    }
  }

  private async resolveTerminal(
    options: ExecuteOptions,
  ): Promise<ManagedTerminal> {
    const { cwd, terminal_id, terminal_name, split_from } = options;

    // If terminal_id is specified, find that specific terminal
    if (terminal_id) {
      const existing = this.terminals.find((t) => t.id === terminal_id);
      if (existing) {
        if (existing.busy || existing.backgroundRunning) {
          throw new Error(
            `Terminal ${terminal_id} is busy. Wait for the current command to finish or use get_terminal_output/kill for background commands.`,
          );
        }
        existing.busy = true;
        try {
          await this.waitForCooldown(existing);
          return existing;
        } catch (err) {
          existing.busy = false;
          throw err;
        }
      }
      // If not found, fall through to creation
    }

    // If terminal_name is specified, find or create by name
    if (terminal_name) {
      const existing = this.terminals.find(
        (t) => t.name === terminal_name && !t.busy && !t.backgroundRunning,
      );
      if (existing) {
        existing.busy = true;
        try {
          await this.waitForCooldown(existing);
          return existing;
        } catch (err) {
          existing.busy = false;
          throw err;
        }
      }
      // Create with the specified name, optionally split from a parent
      const managed = this.createTerminal(cwd, terminal_name);
      managed.busy = true;
      try {
        if (split_from) {
          await this.splitTerminalBeside(managed, split_from);
        }
        return managed;
      } catch (err) {
        managed.busy = false;
        throw err;
      }
    }

    // Default: only reuse an idle unnamed terminal when its tracked cwd still
    // matches the requested cwd. If cwd differs, create a fresh terminal so the
    // command runs from the requested directory instead of inheriting stale state.
    const cwdMatch = this.terminals.find(
      (t) =>
        !t.busy &&
        !t.backgroundRunning &&
        t.name === "AgentLink" &&
        t.cwd === cwd,
    );
    if (cwdMatch) {
      cwdMatch.busy = true;
      try {
        await this.waitForCooldown(cwdMatch);
        return cwdMatch;
      } catch (err) {
        cwdMatch.busy = false;
        throw err;
      }
    }

    const managed = this.createTerminal(cwd, "AgentLink");
    managed.busy = true;
    try {
      if (split_from) {
        await this.splitTerminalBeside(managed, split_from);
      }
      return managed;
    } catch (err) {
      managed.busy = false;
      throw err;
    }
  }

  /**
   * Split the parent terminal and replace the child's vscode.Terminal reference
   * with the newly created split terminal. Works around a VS Code bug (#205254)
   * where `createTerminal({ location: { parentTerminal } })` is silently ignored
   * when the parent was created in a previous async operation.
   */
  private async splitTerminalBeside(
    child: ManagedTerminal,
    splitFrom: string,
  ): Promise<void> {
    const parent =
      this.terminals.find((t) => t.id === splitFrom) ??
      this.terminals.find((t) => t.name === splitFrom);
    if (!parent) {
      this.log?.(
        `split_from "${splitFrom}" not found in ${this.terminals.length} terminals: [${this.terminals.map((t) => `${t.name}(${t.id})`).join(", ")}]`,
      );
      return;
    }

    this.log?.(`split_from: splitting beside "${parent.name}" (${parent.id})`);

    // Dispose the child terminal we just created — we'll replace it with
    // the split terminal that VS Code creates from the parent.
    // Detach the old terminal reference first so onDidCloseTerminal doesn't
    // remove the managed object from this.terminals during the swap.
    const oldTerminal = child.terminal;
    child.terminal = undefined as unknown as vscode.Terminal;
    oldTerminal.dispose();

    // Focus the parent terminal so the split command acts on it
    parent.terminal.show(false);
    // Small delay to ensure the parent terminal is focused
    await new Promise((r) => setTimeout(r, 150));

    // Listen for the new terminal that the split command will create.
    // Split terminals inherit the parent shell environment, so this path must
    // only be used with AgentLink-managed parent terminals that were created
    // with buildAgentExecutionEnv().
    const splitTerminal = await new Promise<vscode.Terminal>((resolve) => {
      const disposable = vscode.window.onDidOpenTerminal((t) => {
        disposable.dispose();
        resolve(t);
      });
      vscode.commands.executeCommand("workbench.action.terminal.split");
    });

    // Rename the split terminal to the requested name
    splitTerminal.show(false);
    await new Promise((r) => setTimeout(r, 50));
    await vscode.commands.executeCommand(
      "workbench.action.terminal.renameWithArg",
      { name: child.name },
    );

    // Replace the terminal reference on the managed object
    child.terminal = splitTerminal;

    this.log?.(
      `split_from: created split terminal "${child.name}" (${child.id})`,
    );
  }

  private createTerminal(cwd: string, name: string): ManagedTerminal {
    const terminal = vscode.window.createTerminal({
      name,
      cwd,
      iconPath: terminalIconPath ?? new vscode.ThemeIcon("terminal"),
      env: buildAgentExecutionEnv(),
    });

    const id = `term_${nextTerminalId++}`;
    const managed: ManagedTerminal = {
      id,
      terminal,
      name,
      cwd,
      busy: false,
      lastCommandEndedAt: 0,
      outputBuffer: "",
      backgroundRunning: false,
      backgroundExitCode: null,
      backgroundOutputCaptured: false,
      backgroundDisposables: [],
    };
    this.terminals.push(managed);
    return managed;
  }

  private async waitForShellIntegration(
    terminal: vscode.Terminal,
  ): Promise<boolean> {
    if (terminal.shellIntegration) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let resolved = false;
      const done = (result: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        clearInterval(poll);
        disposable.dispose();
        if (!result) {
          this.log?.(
            `[waitForShellIntegration] TIMEOUT after ${SHELL_INTEGRATION_TIMEOUT}ms`,
          );
        }
        resolve(result);
      };

      const timeout = setTimeout(() => done(false), SHELL_INTEGRATION_TIMEOUT);

      // Primary: VS Code event fires when shell integration activates
      const disposable = vscode.window.onDidChangeTerminalShellIntegration(
        (e) => {
          if (e.terminal === terminal) {
            done(true);
          }
        },
      );

      // Fallback: poll the property in case the event is missed
      const poll = setInterval(() => {
        if (terminal.shellIntegration) {
          done(true);
        }
      }, 200);
    });
  }

  private async executeWithShellIntegration(
    managed: ManagedTerminal,
    command: string,
    timeout?: number,
  ): Promise<CommandResult> {
    const terminal = managed.terminal;
    const shellIntegration = terminal.shellIntegration!;
    let timedOut = false;
    const disposables: vscode.Disposable[] = [];

    // Reset the output buffer for this execution
    managed.outputBuffer = "";

    // --- Diagnostic state tracking ---
    const execTag = `${managed.id}:${Date.now()}`;
    const startTime = Date.now();
    const diag = {
      startEventFired: false,
      endEventFired: false,
      terminalClosed: false,
      streamChunks: 0,
      streamBytes: 0,
      streamDone: false,
      markerInStream: false,
      markerByPoll: false,
      raceResolved: false,
      raceWinner: "",
      lastActivityAt: startTime,
    };

    const logDiag = (event: string) => {
      const elapsed = Date.now() - startTime;
      this.log?.(
        `[exec:${execTag}] ${event} (+${elapsed}ms) | ` +
          `start=${diag.startEventFired} end=${diag.endEventFired} closed=${diag.terminalClosed} ` +
          `chunks=${diag.streamChunks} bytes=${diag.streamBytes} ` +
          `stream_done=${diag.streamDone} ` +
          `marker_stream=${diag.markerInStream} marker_poll=${diag.markerByPoll} ` +
          `buf=${managed.outputBuffer.length} race=${diag.raceResolved}` +
          (diag.raceWinner ? ` winner=${diag.raceWinner}` : ""),
      );
      diag.lastActivityAt = Date.now();
    };

    logDiag(`EXEC_START cmd="${command.slice(0, 120)}"`);

    // --- Stall detector ---
    // Periodically logs complete state when no progress has been made.
    // Does NOT cancel or resolve anything — purely diagnostic.
    const STALL_CHECK_MS = 10_000;
    const stallCheck = setInterval(() => {
      if (diag.raceResolved) return;
      const sinceActivity = Date.now() - diag.lastActivityAt;
      if (sinceActivity >= STALL_CHECK_MS) {
        const elapsed = Date.now() - startTime;
        const latencyStats =
          this.startupLatencies.length > 0
            ? `samples=${this.startupLatencies.length} last=${this.startupLatencies[this.startupLatencies.length - 1]}ms`
            : "no_samples";
        this.log?.(
          `[exec:${execTag}] STALL_WARNING no activity for ${sinceActivity}ms (total ${elapsed}ms) | ` +
            `start=${diag.startEventFired} end=${diag.endEventFired} closed=${diag.terminalClosed} ` +
            `chunks=${diag.streamChunks} bytes=${diag.streamBytes} ` +
            `stream_done=${diag.streamDone} ` +
            `marker_stream=${diag.markerInStream} marker_poll=${diag.markerByPoll} ` +
            `buf=${managed.outputBuffer.length} ` +
            `shellIntegration=${!!terminal.shellIntegration} ` +
            `timeout=${timeout ?? "none"} ` +
            `startup_latency={${latencyStats}} ` +
            `cmd="${command.slice(0, 120)}"`,
        );
      }
    }, STALL_CHECK_MS);
    disposables.push({ dispose: () => clearInterval(stallCheck) });

    // --- Primary: shell integration events ---
    const exitCodePromise = new Promise<number | undefined>((resolve) => {
      disposables.push(
        vscode.window.onDidEndTerminalShellExecution((e) => {
          if (e.terminal === terminal) {
            diag.endEventFired = true;
            logDiag(`END_EVENT exitCode=${e.exitCode}`);
            resolve(e.exitCode);
          }
        }),
      );

      // Terminal closed while command is running — exit event will never fire
      disposables.push(
        vscode.window.onDidCloseTerminal((t) => {
          if (t === terminal) {
            diag.terminalClosed = true;
            logDiag("TERMINAL_CLOSED");
            resolve(undefined);
          }
        }),
      );

      // Always listen for the start event (for diagnostics), and set up
      // timeout only when configured. Defers timeout until the shell
      // actually starts executing the command, so terminal startup /
      // shell queue delays don't eat into the user-specified timeout.
      disposables.push(
        vscode.window.onDidStartTerminalShellExecution((e) => {
          if (e.terminal === terminal) {
            diag.startEventFired = true;
            this.recordStartupLatency(Date.now() - executeCalledAt);
            logDiag("START_EVENT");

            if (timeout !== undefined) {
              // Clear the catch-all — the precise deferred timer takes over
              if (catchAllTimer) {
                clearTimeout(catchAllTimer);
                catchAllTimer = undefined;
              }
              const timer = setTimeout(() => {
                timedOut = true;
                logDiag("TIMEOUT_FIRED");
                resolve(undefined);
              }, timeout);
              disposables.push({ dispose: () => clearTimeout(timer) });
            }
          }
        }),
      );

      // Catch-all timeout: prevent infinite hang if the start event
      // never fires (shell integration race on rapid terminal reuse).
      // Only active when the user specified a timeout — they explicitly
      // want a time limit. Uses timeout + startup grace so the deferred
      // timer still gets priority in the normal case.
      let catchAllTimer: ReturnType<typeof setTimeout> | undefined;
      if (timeout !== undefined) {
        const STARTUP_GRACE_MS = 15_000;
        catchAllTimer = setTimeout(() => {
          if (!diag.raceResolved) {
            timedOut = true;
            logDiag("CATCH_ALL_TIMEOUT");
            resolve(undefined);
          }
        }, timeout + STARTUP_GRACE_MS);
        disposables.push({
          dispose: () => {
            if (catchAllTimer) clearTimeout(catchAllTimer);
          },
        });
      }
    });

    // Execute the command — record timestamp so we can measure startup latency
    const executeCalledAt = Date.now();
    logDiag("CALLING_EXECUTE_COMMAND");
    const execution = shellIntegration.executeCommand(command);
    logDiag("EXECUTE_COMMAND_RETURNED");

    // Collect output from the stream (stored on managed terminal for external access)
    const stream = execution.read();

    // Race stream reading against exit code / marker / timeout.
    // The stream's async iterator can hang even after the command finishes
    // (VS Code shell integration quirk), so we must not block on it alone.
    // The marker fallback catches cases where the event is dropped but the
    // shell did send the OSC 633;D completion sequence.
    //
    // We check for the 633;D marker both inside the stream loop (fast path)
    // and via independent polling (catches markers the stream loop misses,
    // e.g. if the stream hangs after yielding the marker data).
    let resolveStreamMarker: ((code: number | undefined) => void) | undefined;
    let streamMarkerResolved = false;
    const streamMarkerPromise = new Promise<number | undefined>((resolve) => {
      resolveStreamMarker = (code) => {
        if (streamMarkerResolved) return;
        streamMarkerResolved = true;
        resolve(code);
      };
    });

    // Track how far we've scanned so we don't re-check old data
    let lastMarkerCheckPos = 0;

    const checkForMarker = (source: "stream" | "poll"): boolean => {
      const result = findAndStripMarker(
        managed.outputBuffer,
        lastMarkerCheckPos,
      );
      if (result) {
        if (source === "stream") {
          diag.markerInStream = true;
        } else {
          diag.markerByPoll = true;
        }
        managed.outputBuffer = result.stripped;
        logDiag(
          `MARKER_FOUND source=${source} exitCode=${result.exitCode ?? "none"}`,
        );
        resolveStreamMarker!(result.exitCode ?? undefined);
        return true;
      }
      lastMarkerCheckPos = managed.outputBuffer.length;
      return false;
    };

    // Independent marker polling — runs outside the stream loop so it can
    // detect markers even if the for-await iterator hangs after yielding data.
    const MARKER_POLL_MS = 500;
    const markerPoll = setInterval(() => {
      if (managed.outputBuffer.length > lastMarkerCheckPos) {
        checkForMarker("poll");
      }
    }, MARKER_POLL_MS);

    const streamDone = (async () => {
      for await (const data of stream) {
        diag.streamChunks++;
        diag.streamBytes += data.length;
        if (diag.streamChunks === 1) {
          logDiag(`STREAM_FIRST_DATA len=${data.length}`);
        }
        diag.lastActivityAt = Date.now();
        managed.outputBuffer += data;
        if (checkForMarker("stream")) break;
      }
      diag.streamDone = true;
      logDiag("STREAM_COMPLETED");
    })();

    await Promise.race([streamDone, exitCodePromise, streamMarkerPromise]);

    // If the race resolved but we have no output yet, the stream may
    // still be delivering data (observed when exit event fires ~100ms
    // before stream data arrives on rapidly-reused terminals). Wait
    // briefly for it rather than returning empty output.
    if (managed.outputBuffer.length === 0 && !diag.streamDone) {
      const OUTPUT_GRACE_MS = 300;
      logDiag(`OUTPUT_GRACE waiting ${OUTPUT_GRACE_MS}ms for stream data`);
      await Promise.race([
        streamDone,
        new Promise((r) => setTimeout(r, OUTPUT_GRACE_MS)),
      ]);
    }

    diag.raceResolved = true;
    // Determine which promise won the race
    if (diag.streamDone) diag.raceWinner = "stream";
    else if (diag.endEventFired || diag.terminalClosed || timedOut)
      diag.raceWinner = diag.endEventFired
        ? "exitEvent"
        : diag.terminalClosed
          ? "terminalClosed"
          : "timeout";
    else if (diag.markerInStream || diag.markerByPoll)
      diag.raceWinner = "marker";
    else diag.raceWinner = "unknown";
    logDiag("RACE_RESOLVED");

    clearInterval(markerPoll);

    // Strip any remaining completion marker from output (safety net)
    const leftover = findAndStripMarker(managed.outputBuffer, 0);
    if (leftover) {
      managed.outputBuffer = leftover.stripped;
    }

    // Clean up the output
    managed.outputBuffer = cleanTerminalOutput(managed.outputBuffer);

    // Bounded wait for exit code: if the promise hasn't resolved yet (e.g.
    // stream finished but exit event is delayed), give it a short grace
    // period rather than blocking forever.
    const EXIT_CODE_GRACE_MS = 5_000;
    const exitCode = await Promise.race([
      exitCodePromise,
      streamMarkerPromise,
      new Promise<undefined>((r) =>
        setTimeout(() => r(undefined), EXIT_CODE_GRACE_MS),
      ),
    ]);

    logDiag(`EXIT_CODE=${exitCode ?? "null"}`);

    // Clean up all listeners
    for (const d of disposables) d.dispose();

    // Read the terminal's actual cwd after execution (reflects cd, etc.)
    const actualCwd = shellIntegration.cwd?.fsPath;
    if (actualCwd) {
      managed.cwd = actualCwd;
    }

    const result: CommandResult = {
      exit_code: exitCode ?? null,
      output: managed.outputBuffer,
      ...(actualCwd && { cwd: actualCwd }),
      output_captured: true,
      terminal_id: managed.id,
      execution_mode: "shell_integration",
      command_sent: true,
    };

    if (timedOut) {
      this.transitionToBackground(managed);
      result.timed_out = true;
      result.output += `\n[Timed out after ${timeout! / 1000}s — command may still be running. Use get_terminal_output with terminal_id "${managed.id}" to check on progress, or add kill: true to stop it.]`;
    }

    logDiag("RETURNING_RESULT");
    return result;
  }

  private executeWithSendText(
    managed: ManagedTerminal,
    command: string,
  ): CommandResult {
    managed.terminal.sendText(command, true);

    return {
      exit_code: null,
      output:
        "Command was sent to the terminal, but output capture is unavailable because shell integration is not active.",
      output_captured: false,
      terminal_id: managed.id,
      execution_mode: "send_text",
      command_sent: true,
      verification_hint:
        `The command may still be running or may have already finished in terminal_id "${managed.id}". ` +
        "Do not re-run it just to verify. Inspect the visible terminal, or use get_terminal_output with this terminal_id if shell integration later becomes available.",
    };
  }

  /**
   * Transition a foreground command that timed out into background state,
   * so get_terminal_output can retrieve its output and detect completion.
   * The stream async generator from executeWithShellIntegration continues
   * pumping data into managed.outputBuffer independently.
   */
  private transitionToBackground(managed: ManagedTerminal): void {
    // Clean up any stale background state
    for (const d of managed.backgroundDisposables) d.dispose();
    managed.backgroundDisposables = [];

    managed.backgroundRunning = true;
    managed.backgroundOutputCaptured = true;
    managed.backgroundExitCode = null;

    const execTag = `timeout-bg:${managed.id}:${Date.now()}`;
    const logBg = (event: string) => {
      this.log?.(
        `[${execTag}] ${event} | running=${managed.backgroundRunning} buf=${managed.outputBuffer.length}`,
      );
    };

    logBg("TRANSITION_TO_BACKGROUND");

    // Helper to finalize background state
    const finalize = (source: string) => {
      if (!managed.backgroundRunning) return;
      managed.backgroundRunning = false;
      managed.outputBuffer = cleanTerminalOutput(managed.outputBuffer);
      clearInterval(markerPoll);
      for (const d of managed.backgroundDisposables) d.dispose();
      managed.backgroundDisposables = [];
      logBg(
        `FINALIZED source=${source} exit_code=${managed.backgroundExitCode}`,
      );
    };

    // Listen for shell execution end event
    const exitDisposable = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.terminal === managed.terminal) {
        logBg(`END_EVENT exitCode=${e.exitCode}`);
        managed.backgroundExitCode = e.exitCode ?? null;
        finalize("exitEvent");
      }
    });

    // Listen for terminal close
    const closeDisposable = vscode.window.onDidCloseTerminal((t) => {
      if (t === managed.terminal) {
        logBg("TERMINAL_CLOSED");
        finalize("terminalClosed");
      }
    });

    managed.backgroundDisposables.push(exitDisposable, closeDisposable);

    // Marker polling — catches completion markers in the output buffer
    let lastMarkerCheckPos = 0;
    const checkForMarker = (): boolean => {
      const result = findAndStripMarker(
        managed.outputBuffer,
        lastMarkerCheckPos,
      );
      if (result) {
        logBg(`MARKER_FOUND exitCode=${result.exitCode ?? "none"}`);
        managed.outputBuffer = result.stripped;
        managed.backgroundExitCode = result.exitCode;
        finalize("marker");
        return true;
      }
      lastMarkerCheckPos = managed.outputBuffer.length;
      return false;
    };

    const markerPoll = setInterval(() => {
      if (!managed.backgroundRunning) {
        clearInterval(markerPoll);
        return;
      }
      if (managed.outputBuffer.length > lastMarkerCheckPos) {
        checkForMarker();
      }
    }, 500);
    managed.backgroundDisposables.push({
      dispose: () => clearInterval(markerPoll),
    });
  }

  private executeBackground(
    managed: ManagedTerminal,
    command: string,
    _hasShellIntegration: boolean,
  ): CommandResult {
    // Clean up any previous background state
    for (const d of managed.backgroundDisposables) d.dispose();
    managed.backgroundDisposables = [];
    managed.backgroundRunning = true;
    managed.backgroundExitCode = null;
    managed.outputBuffer = "";

    const execTag = `bg:${managed.id}:${Date.now()}`;
    const startTime = Date.now();
    const logBg = (event: string) => {
      const elapsed = Date.now() - startTime;
      this.log?.(
        `[${execTag}] ${event} (+${elapsed}ms) | ` +
          `running=${managed.backgroundRunning} captured=${managed.backgroundOutputCaptured} ` +
          `buf=${managed.outputBuffer.length}`,
      );
    };

    // Helper to clean up background state and dispose listeners
    const finalize = (source: string) => {
      if (!managed.backgroundRunning) return; // already finalized
      managed.backgroundRunning = false;
      managed.outputBuffer = cleanTerminalOutput(managed.outputBuffer);
      clearInterval(markerPoll);
      for (const d of managed.backgroundDisposables) d.dispose();
      managed.backgroundDisposables = [];
      logBg(
        `FINALIZED source=${source} exit_code=${managed.backgroundExitCode}`,
      );
    };

    // --- Register listeners BEFORE executing (prevents race for fast commands) ---

    // Listen for shell execution end event as primary completion signal
    const exitDisposable = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.terminal === managed.terminal) {
        logBg(`END_EVENT exitCode=${e.exitCode}`);
        managed.backgroundExitCode = e.exitCode ?? null;
        // If we used sendText but shell integration picked up the execution,
        // retroactively mark output as captured since the stream may have data
        if (
          !managed.backgroundOutputCaptured &&
          managed.outputBuffer.length > 0
        ) {
          managed.backgroundOutputCaptured = true;
        }
        finalize("exitEvent");
      }
    });

    // Listen for terminal close
    const closeDisposable = vscode.window.onDidCloseTerminal((t) => {
      if (t === managed.terminal) {
        logBg("TERMINAL_CLOSED");
        finalize("terminalClosed");
      }
    });

    managed.backgroundDisposables.push(exitDisposable, closeDisposable);

    // --- Independent marker polling (catches markers if stream hangs) ---
    let lastMarkerCheckPos = 0;

    const checkForMarker = (): boolean => {
      const result = findAndStripMarker(
        managed.outputBuffer,
        lastMarkerCheckPos,
      );
      if (result) {
        logBg(`MARKER_FOUND exitCode=${result.exitCode ?? "none"}`);
        managed.outputBuffer = result.stripped;
        managed.backgroundExitCode = result.exitCode;
        finalize("marker");
        return true;
      }
      lastMarkerCheckPos = managed.outputBuffer.length;
      return false;
    };

    const markerPoll = setInterval(() => {
      if (!managed.backgroundRunning) {
        clearInterval(markerPoll);
        return;
      }
      if (managed.outputBuffer.length > lastMarkerCheckPos) {
        checkForMarker();
      }
    }, 500);
    managed.backgroundDisposables.push({
      dispose: () => clearInterval(markerPoll),
    });

    // --- Re-verify shell integration at point of use (don't trust stale boolean) ---
    const shellIntegration = managed.terminal.shellIntegration;

    if (shellIntegration) {
      managed.backgroundOutputCaptured = true;
      logBg(`EXEC_START cmd="${command.slice(0, 120)}" mode=shellIntegration`);

      const execution = shellIntegration.executeCommand(command);
      const stream = execution.read();

      // Read stream asynchronously — don't await, let it run in background
      const streamDone = (async () => {
        let chunks = 0;
        for await (const data of stream) {
          chunks++;
          if (chunks === 1) logBg(`STREAM_FIRST_DATA len=${data.length}`);
          managed.outputBuffer += data;
          if (checkForMarker()) break;
        }
        logBg(`STREAM_DONE chunks=${chunks}`);
      })();

      // Catch stream errors (terminal may close mid-read)
      streamDone.catch((err) => {
        logBg(`STREAM_ERROR ${err?.message ?? err}`);
        finalize("streamError");
      });
    } else {
      // sendText fallback — shell integration not available
      managed.backgroundOutputCaptured = false;
      logBg(`EXEC_START cmd="${command.slice(0, 120)}" mode=sendText`);
      managed.terminal.sendText(command, true);
      // Note: exit/close listeners are already registered above.
      // If shell integration activates after sendText, the exit listener
      // will still fire and finalize the state properly.
    }

    return {
      exit_code: null,
      output: `Background command started in terminal "${managed.name}". Use terminal_id "${managed.id}" with get_terminal_output to check on progress.`,
      output_captured: false,
      terminal_id: managed.id,
      execution_mode: shellIntegration ? "shell_integration" : "send_text",
      command_sent: true,
      ...(shellIntegration
        ? {}
        : {
            verification_hint:
              `Background command was started in terminal_id "${managed.id}", but shell integration was not active so live output capture is unavailable. ` +
              "Use the visible terminal to verify progress rather than re-running the command.",
          }),
    };
  }

  /**
   * Close managed terminals. Returns the count of terminals closed.
   * If names are specified, only closes terminals with matching names.
   * Otherwise closes all managed terminals.
   * Returns the count of closed terminals and any names that weren't found.
   */
  closeTerminals(names?: string[]): { closed: number; not_found?: string[] } {
    const toClose = names
      ? this.terminals.filter((t) => names.includes(t.name))
      : [...this.terminals];

    for (const managed of toClose) {
      for (const d of managed.backgroundDisposables) d.dispose();
      managed.backgroundDisposables = [];
      managed.terminal.dispose();
    }

    // The onDidCloseTerminal listener will clean up the array,
    // but do it eagerly too for immediate consistency.
    const closedIds = new Set(toClose.map((t) => t.id));
    this.terminals = this.terminals.filter((t) => !closedIds.has(t.id));

    // Report any requested names that weren't found
    const closedNames = new Set(toClose.map((t) => t.name));
    const notFound = names?.filter((n) => !closedNames.has(n));

    return {
      closed: toClose.length,
      ...(notFound && notFound.length > 0 && { not_found: notFound }),
    };
  }

  /**
   * Get accumulated output from a busy or background terminal.
   * Returns undefined if the terminal is not found.
   */
  getCurrentOutput(
    terminalId: string,
    options?: { force?: boolean },
  ): string | undefined {
    const managed = this.terminals.find((t) => t.id === terminalId);
    if (!managed) return undefined;
    if (
      !options?.force &&
      !managed.busy &&
      !managed.backgroundRunning &&
      !managed.backgroundOutputCaptured
    )
      return undefined;
    return cleanTerminalOutput(managed.outputBuffer);
  }

  /**
   * Get the background execution state of a terminal.
   * Returns undefined if the terminal is not found.
   */
  getBackgroundState(terminalId: string):
    | {
        is_running: boolean;
        exit_code: number | null;
        output: string;
        output_captured: boolean;
      }
    | undefined {
    const managed = this.terminals.find((t) => t.id === terminalId);
    if (!managed) return undefined;
    return {
      is_running: managed.backgroundRunning,
      exit_code: managed.backgroundExitCode,
      output: managed.backgroundRunning
        ? cleanTerminalOutput(managed.outputBuffer)
        : managed.outputBuffer,
      output_captured: managed.backgroundOutputCaptured,
    };
  }

  /**
   * Send Ctrl+C (SIGINT) to a managed terminal to interrupt the running process.
   * Returns true if the terminal was found and interrupted.
   */
  interruptTerminal(terminalId: string): boolean {
    const managed = this.terminals.find((t) => t.id === terminalId);
    if (!managed) return false;
    managed.terminal.sendText("\x03", false);
    return true;
  }

  /**
   * List all managed terminals with their current state.
   */
  listTerminals(): Array<{
    id: string;
    name: string;
    busy: boolean;
  }> {
    return this.terminals.map((t) => ({
      id: t.id,
      name: t.name,
      busy: t.busy,
    }));
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    // Don't close terminals — let the user keep them
  }
}

// Singleton instance
let instance: TerminalManager | null = null;

export function getTerminalManager(): TerminalManager {
  if (!instance) {
    instance = new TerminalManager();
  }
  return instance;
}

export function disposeTerminalManager(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
