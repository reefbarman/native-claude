import { getTerminalManager } from "../integrations/TerminalManager.js";
import { filterOutput, saveOutputTempFile } from "../util/outputFilter.js";

import { type ToolResult } from "../shared/types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const INTERACTIVE_PROMPT_PATTERNS: RegExp[] = [
  /\b(y\/n|yes\/no|press\s+(enter|return)|continue\?|are you sure)\b/i,
  /\b(choose|select)\b.*\b(option|number)\b/i,
  /\b(waiting\s+for\s+(input|confirmation)|enter\s+(?:yes|no|y|n))\b/i,
  // Known prompt text emitted by codegen workflows that pause for confirmation.
  /\bcustom code preservation\b/i,
];

function detectPromptBlock(output: string): {
  blocked_on_prompt: boolean;
  matched_pattern?: string;
} {
  const trimmed = output.trim();
  if (!trimmed) {
    return { blocked_on_prompt: false };
  }

  const tail = trimmed.slice(Math.max(0, trimmed.length - 4000));
  const nonEmptyLines = tail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const recentTail = nonEmptyLines.slice(-6).join("\n");

  for (const pattern of INTERACTIVE_PROMPT_PATTERNS) {
    if (pattern.test(recentTail)) {
      return {
        blocked_on_prompt: true,
        matched_pattern: pattern.source,
      };
    }
  }
  return { blocked_on_prompt: false };
}

export async function handleGetTerminalOutput(params: {
  terminal_id: string;
  wait_seconds?: number;
  kill?: boolean;
  output_head?: number;
  output_tail?: number;
  output_offset?: number;
  output_grep?: string;
  output_grep_context?: number;
}): Promise<ToolResult> {
  const terminalManager = getTerminalManager();
  const log = terminalManager.log;
  const startTime = Date.now();

  log?.(
    `[get_terminal_output] ENTER terminal_id=${params.terminal_id} wait_seconds=${params.wait_seconds ?? "none"}`,
  );

  // If wait_seconds is specified, poll until the command finishes or the wait
  // time expires.  We intentionally do NOT break on "new output" — for
  // continuously-producing commands that would exit after ~250ms, making
  // wait_seconds effectively useless.
  if (params.wait_seconds && params.wait_seconds > 0) {
    const deadline = Date.now() + params.wait_seconds * 1000;
    const initialState = terminalManager.getBackgroundState(params.terminal_id);

    log?.(
      `[get_terminal_output] POLL_START is_running=${initialState?.is_running ?? "unknown"}`,
    );

    while (Date.now() < deadline) {
      const current = terminalManager.getBackgroundState(params.terminal_id);
      if (!current) break;

      // Stop waiting only when the command has finished
      if (!current.is_running) break;

      await sleep(Math.min(250, deadline - Date.now()));
    }

    log?.(`[get_terminal_output] POLL_END elapsed=${Date.now() - startTime}ms`);
  }

  // Kill the running process if requested
  if (params.kill) {
    log?.(`[get_terminal_output] KILL terminal_id=${params.terminal_id}`);
    terminalManager.interruptTerminal(params.terminal_id);
    // Brief wait for the process to respond to SIGINT
    await sleep(500);
  }

  const state = terminalManager.getBackgroundState(params.terminal_id);

  if (!state) {
    const recent = terminalManager.getRecentlyClosedTerminals(5).map((t) => ({
      terminal_id: t.id,
      terminal_name: t.name,
      closed_at: new Date(t.closedAt).toISOString(),
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: `Terminal "${params.terminal_id}" not found. It may have been closed.`,
            ...(recent.length > 0 && { recently_closed_terminals: recent }),
            hint: "Use execute_command with terminal_name for long-running workflows so you can recover by name if terminal_id changes.",
          }),
        },
      ],
    };
  }

  const result: Record<string, unknown> = {
    terminal_id: params.terminal_id,
    is_running: state.is_running,
    exit_code: state.exit_code,
    output_captured: state.output_captured,
    ...(params.kill && { killed: true }),
  };

  if (state.is_running && state.output_captured) {
    const promptState = detectPromptBlock(state.output);
    if (promptState.blocked_on_prompt) {
      result.blocked_on_prompt = true;
      result.prompt_detection = "heuristic";
      if (promptState.matched_pattern) {
        result.prompt_pattern = promptState.matched_pattern;
      }
      result.prompt_hint =
        "The command appears to be waiting for interactive input. Use terminal_id with get_terminal_output(kill: true) to stop it, or open the terminal UI and answer the prompt.";
    }
  }

  if (state.output_captured && state.output) {
    const { filtered, totalLines, linesShown } = filterOutput(state.output, {
      output_head: params.output_head,
      output_tail: params.output_tail,
      output_offset: params.output_offset,
      output_grep: params.output_grep,
      output_grep_context: params.output_grep_context,
    });

    result.output = filtered;
    result.total_lines = totalLines;
    result.lines_shown = linesShown;

    if (linesShown < totalLines) {
      const outputFile = saveOutputTempFile(state.output);
      if (outputFile) {
        result.output_file = outputFile;
        result.output_warning =
          "⚠️ Output was truncated. Full output saved to output_file — use read_file(output_file) to access it. Do NOT re-run this command.";
      }
    }
  } else if (!state.output_captured) {
    result.output =
      "Output capture unavailable — shell integration was not active when the background command started.";
    result.verification_hint =
      `The command was started in terminal_id "${params.terminal_id}" without shell integration capture. ` +
      "Use the visible terminal to inspect progress or completion rather than re-running it.";
  } else {
    result.output = "";
  }

  log?.(
    `[get_terminal_output] EXIT elapsed=${Date.now() - startTime}ms terminal_id=${params.terminal_id}`,
  );

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}
