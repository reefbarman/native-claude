import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";

import { tryGetFirstWorkspaceRoot } from "../util/paths.js";
import { getTerminalManager } from "../integrations/TerminalManager.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { TrackerContext } from "../server/ToolCallTracker.js";
import {
  splitCompoundCommand,
  expandSubCommands,
} from "../approvals/commandSplitter.js";
import type { SubCommandEntry } from "../approvals/webview/types.js";
import { filterOutput, saveOutputTempFile } from "../util/outputFilter.js";
import { validateCommand } from "../util/pipeValidator.js";
import { validateInteractiveCommand } from "../util/interactiveValidator.js";
import { Semaphore } from "../util/Semaphore.js";

/** Serializes the approval-check phase so pending dialogs block other commands. */
const approvalGate = new Semaphore(1);

import { type ToolResult } from "../shared/types.js";

export async function handleExecuteCommand(
  params: {
    command: string;
    cwd?: string;
    terminal_id?: string;
    terminal_name?: string;
    split_from?: string;
    background?: boolean;
    timeout?: number;
    output_head?: number;
    output_tail?: number;
    output_offset?: number;
    output_grep?: string;
    output_grep_context?: number;
    force?: boolean;
    force_reason?: string;
    reason?: string;
  },
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  trackerCtx?: TrackerContext,
): Promise<ToolResult> {
  try {
    if (!params.command || params.command.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Command cannot be empty" }),
          },
        ],
      };
    }

    const workspaceRoot = tryGetFirstWorkspaceRoot();

    // Resolve cwd
    let cwd = workspaceRoot ?? os.homedir();
    if (params.cwd) {
      cwd = path.isAbsolute(params.cwd)
        ? params.cwd
        : path.resolve(cwd, params.cwd);
    }

    // Master bypass check
    const masterBypass = vscode.workspace
      .getConfiguration("agentlink")
      .get<boolean>("masterBypass", false);

    let commandToRun = params.command;
    let approvalFollowUp: string | undefined;

    // Reject disallowed command patterns (direct head/tail/cat/grep, piped filtering)
    const commandViolation = validateCommand(params.command);
    if (commandViolation) {
      // force=true can only bypass "direct" violations (shell expansion false positives),
      // never "pipe" violations — those have dedicated output_* params with no false positives.
      const canBypass =
        params.force &&
        commandViolation.type === "direct" &&
        params.force_reason;

      if (!canBypass) {
        const reason =
          params.force && commandViolation.type === "pipe"
            ? commandViolation.message +
              "\n\nforce=true cannot bypass pipe filtering rejections. Use the output_grep/output_head/output_tail parameters instead."
            : params.force && !params.force_reason
              ? commandViolation.message +
                "\n\nforce=true requires a force_reason explaining why the rejection is a false positive."
              : commandViolation.message;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected",
                command: params.command,
                reason,
              }),
            },
          ],
        };
      }
    }

    // Reject known interactive commands (editors, REPLs, TUI apps, etc.)
    const interactiveViolation = validateInteractiveCommand(params.command);
    if (interactiveViolation) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "rejected",
              command: params.command,
              reason: interactiveViolation.message,
            }),
          },
        ],
      };
    }

    if (!masterBypass) {
      // Gate: only one command goes through approval at a time, so pending
      // dialogs aren't buried by terminals from auto-approved commands.
      const releaseGate = await approvalGate.acquire();
      try {
        const subCommands = splitCompoundCommand(params.command);
        const approvalResult = await approveSubCommands(
          subCommands,
          params.command,
          approvalManager,
          approvalPanel,
          sessionId,
          params.reason,
        );

        if (!approvalResult.approved) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "rejected_by_user",
                  command: params.command,
                  ...(approvalResult.reason && {
                    reason: approvalResult.reason,
                  }),
                }),
              },
            ],
          };
        }

        if (approvalResult.editedCommand) {
          commandToRun = approvalResult.editedCommand;
        }

        approvalFollowUp = approvalResult.followUp;
      } finally {
        releaseGate();
      }
    }

    const terminalManager = getTerminalManager();
    const result = await terminalManager.executeCommand({
      command: commandToRun,
      cwd,
      terminal_id: params.terminal_id,
      terminal_name: params.terminal_name,
      split_from: params.split_from,
      background: params.background,
      timeout: params.timeout ? params.timeout * 1000 : undefined, // seconds → ms
      onTerminalAssigned: trackerCtx
        ? (tid) => trackerCtx.setTerminalId(tid)
        : undefined,
    });

    // Apply output filtering and temp file saving
    if (result.output_captured && result.output) {
      const { filtered, totalLines, linesShown } = filterOutput(result.output, {
        output_head: params.output_head,
        output_tail: params.output_tail,
        output_offset: params.output_offset,
        output_grep: params.output_grep,
        output_grep_context: params.output_grep_context,
      });

      result.total_lines = totalLines;
      result.lines_shown = linesShown;

      // Only save temp file when output is actually being truncated
      if (linesShown < totalLines) {
        const outputFile = saveOutputTempFile(result.output);
        if (outputFile) {
          result.output_file = outputFile;
          result.output_warning =
            "⚠️ Output was truncated. Full output saved to output_file — use read_file(output_file) to access it. Do NOT re-run this command.";
        }
      }

      result.output = filtered;
    } else if (!result.output_captured && !result.output) {
      result.output =
        "Command execution was sent to the terminal, but no output was captured.";
    }

    // If the user edited the command, include modification info
    if (commandToRun !== params.command) {
      result.command_modified = true;
      result.original_command = params.command;
      result.command = commandToRun;
    }

    if (approvalFollowUp) {
      result.follow_up = approvalFollowUp;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message, command: params.command }),
        },
      ],
    };
  }
}

/**
 * Approve sub-commands by showing a single dialog with the full command.
 *
 * - Split compound command, expand wrappers into separate sub-commands
 * - Build enriched entries with existing matching rules
 * - Run/Edit/Reject applies to the whole command at once
 * - Always-visible per-sub-command rule editor with per-row scope
 */
async function approveSubCommands(
  subCommands: string[],
  fullCommand: string,
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  sessionId: string,
  reason?: string,
): Promise<{
  approved: boolean;
  reason?: string;
  editedCommand?: string;
  followUp?: string;
}> {
  // Expand wrappers: ["cd /foo", "sudo npm install"] → ["cd /foo", "sudo", "npm install"]
  const expanded = expandSubCommands(subCommands);

  // Check if all expanded sub-commands are already approved,
  // or the full command was recently approved within the TTL window
  const allApproved = expanded.every((sub) =>
    approvalManager.isCommandApproved(sessionId, sub),
  );
  if (allApproved || approvalPanel.isRecentlyApproved("command", fullCommand)) {
    return { approved: true };
  }

  // Build enriched entries for ALL sub-commands (even already-approved ones)
  const entries: SubCommandEntry[] = expanded.map((cmd) => {
    const match = approvalManager.findMatchingCommandRule(sessionId, cmd);
    if (match) {
      return {
        command: cmd,
        existingRule: {
          pattern: match.rule.pattern,
          mode: match.rule.mode,
          scope: match.scope,
        },
      };
    }
    return { command: cmd };
  });

  // Show dialog with full command + enriched sub-command entries
  const { promise } = approvalPanel.enqueueCommandApproval(
    fullCommand,
    fullCommand,
    { subCommands: entries, reason },
  );
  const response = await promise;

  if (response.decision === "reject") {
    return { approved: false, reason: response.rejectionReason };
  }

  // Save per-sub-command rules (each with its own scope)
  if (response.rules && response.rules.length > 0) {
    for (const rule of response.rules) {
      if (rule.mode === "skip" || !rule.pattern) {
        continue;
      }
      const scope = rule.scope as "session" | "project" | "global";
      approvalManager.addCommandRule(
        sessionId,
        {
          pattern: rule.pattern,
          mode: rule.mode as "prefix" | "exact" | "regex",
        },
        scope,
      );
    }
  }

  if (response.editedCommand) {
    return {
      approved: true,
      editedCommand: response.editedCommand,
      followUp: response.followUp,
    };
  }
  return { approved: true, followUp: response.followUp };
}
