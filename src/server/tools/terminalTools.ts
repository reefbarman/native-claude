import { z } from "zod";
import { handleExecuteCommand } from "../../tools/executeCommand.js";
import { handleGetTerminalOutput } from "../../tools/getTerminalOutput.js";
import { handleCloseTerminals } from "../../tools/closeTerminals.js";
import type { ToolRegistrationContext } from "./types.js";

export function registerTerminalTools(ctx: ToolRegistrationContext): void {
  const { server, tracker, approvalManager, approvalPanel, sid, touch, desc } =
    ctx;

  server.registerTool(
    "execute_command",
    {
      description: desc("execute_command"),
      inputSchema: {
        command: z.string().describe("Shell command to execute"),
        cwd: z
          .string()
          .optional()
          .describe(
            "Working directory (absolute or relative to workspace root). Only applies when creating a new terminal — ignored on reused terminals. The response 'cwd' field shows the terminal's actual directory after execution.",
          ),
        terminal_id: z
          .string()
          .optional()
          .describe(
            "Run in a specific terminal by ID (returned from previous commands)",
          ),
        terminal_name: z
          .string()
          .optional()
          .describe(
            "Run in a named terminal (e.g. 'Server', 'Build', 'Tests'). Creates if it doesn't exist. Enables parallel execution in separate terminals.",
          ),
        split_from: z
          .string()
          .optional()
          .describe(
            "Split the new terminal alongside an existing terminal (by terminal_id or terminal_name), creating a visual group. Only takes effect when a new terminal is created — ignored if terminal_name matches an existing idle terminal. Example: start a backend server with terminal_name='Backend', then use split_from='Backend' with terminal_name='Frontend' to group them side-by-side.",
          ),
        background: z
          .boolean()
          .optional()
          .describe(
            "Run without waiting for completion. Use for long-running processes like dev servers. Returns immediately with terminal_id.",
          ),
        timeout: z.coerce
          .number()
          .optional()
          .describe(
            "Timeout in seconds. If set, command output is returned when the timeout is reached, but the command may still be running in the terminal. If omitted, waits indefinitely for the command to finish. IMPORTANT: Always set a timeout for commands you expect to complete quickly (e.g. git, ls, cat, grep, npm test — use 10-30s). This prevents the session from hanging if a command unexpectedly blocks. Only omit timeout for long-running processes where you explicitly want to wait indefinitely.",
          ),
        output_head: z.coerce
          .number()
          .optional()
          .describe(
            "Return only the first N lines of output. Overrides the default 200-line tail cap.",
          ),
        output_tail: z.coerce
          .number()
          .optional()
          .describe(
            "Return only the last N lines of output. Overrides the default 200-line tail cap.",
          ),
        output_offset: z.coerce
          .number()
          .optional()
          .describe(
            'Skip first N lines/entries before applying head/tail, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
          ),
        output_grep: z
          .string()
          .optional()
          .describe(
            "Filter output to lines matching this regex pattern (case-insensitive). Applied before head/tail. Use this instead of piping through grep.",
          ),
        output_grep_context: z.coerce
          .number()
          .optional()
          .describe(
            "Number of context lines around each grep match (like grep -C). Only used with output_grep.",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "Bypass command validation for direct file-reading commands (grep, cat, head, tail, sed on files). Only use when the rejection is a false positive — e.g. commands with shell expansion ($(), env vars) in arguments. Does NOT bypass pipe filtering rejections (cmd | grep/head/tail) — use output_grep/output_head/output_tail params instead.",
          ),
        force_reason: z
          .string()
          .optional()
          .describe(
            "Required when force=true. Explain why the rejection is a false positive (e.g. 'grep target is a $VAR path that read_file cannot resolve'). Commands with force=true but no force_reason will be rejected.",
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    tracker.wrapHandler(
      "execute_command",
      (params, ctx) => {
        touch();
        return handleExecuteCommand(
          params,
          approvalManager,
          approvalPanel,
          sid(),
          ctx,
        );
      },
      (p) => String(p.command ?? "").slice(0, 80),
      sid,
    ),
  );

  server.registerTool(
    "close_terminals",
    {
      description: desc("close_terminals"),
      inputSchema: {
        names: z
          .array(z.string())
          .optional()
          .describe(
            "Terminal names to close (e.g. ['Server', 'Tests']). Omit to close all managed terminals.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "close_terminals",
      (params) => {
        touch();
        return handleCloseTerminals(params);
      },
      (p) =>
        Array.isArray(p.names) ? (p.names as string[]).join(", ") : "all",
      sid,
    ),
  );

  server.registerTool(
    "get_terminal_output",
    {
      description: desc("get_terminal_output"),
      inputSchema: {
        terminal_id: z
          .string()
          .describe("Terminal ID returned by execute_command (e.g. 'term_3')"),
        wait_seconds: z.coerce
          .number()
          .optional()
          .describe(
            "Wait up to N seconds for new output to appear before returning. Useful when a background command was just started and you want to avoid a double-call. Polls every 250ms and returns early when new output arrives or the command finishes.",
          ),
        kill: z
          .boolean()
          .optional()
          .describe(
            "Send Ctrl+C (SIGINT) to kill the running command. Returns captured output.",
          ),
        output_head: z.coerce
          .number()
          .optional()
          .describe("Return only the first N lines of output."),
        output_tail: z.coerce
          .number()
          .optional()
          .describe("Return only the last N lines of output."),
        output_offset: z.coerce
          .number()
          .optional()
          .describe("Skip first N lines before applying head/tail."),
        output_grep: z
          .string()
          .optional()
          .describe(
            "Filter output to lines matching this regex pattern (case-insensitive).",
          ),
        output_grep_context: z.coerce
          .number()
          .optional()
          .describe("Number of context lines around each grep match."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_terminal_output",
      (params) => {
        touch();
        return handleGetTerminalOutput(params);
      },
      (p) => String(p.terminal_id ?? ""),
      sid,
    ),
  );
}
