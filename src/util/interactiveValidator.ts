/**
 * Validate commands for known interactive patterns that would hang in an
 * automated terminal session. Returns null if the command is safe, or a
 * rejection object with a helpful message suggesting a non-interactive
 * alternative.
 *
 * This complements pipeValidator.ts (which handles piped filtering) and
 * the env vars set in TerminalManager (PAGER, npm_config_yes, etc.).
 */

interface InteractiveViolation {
  /** The problematic command/pattern */
  command: string;
  /** Why it's interactive */
  reason: string;
  /** Suggested alternative */
  suggestion: string;
}

export interface InteractiveValidationResult {
  message: string;
}

// ── Interactive editors ─────────────────────────────────────────────

const INTERACTIVE_EDITORS = new Set([
  "vim",
  "vi",
  "nvim",
  "neovim",
  "nano",
  "pico",
  "emacs",
  "micro",
  "joe",
  "ne",
  "ed", // line editor, but still interactive
]);

// ── System monitors / TUI apps ──────────────────────────────────────

const INTERACTIVE_TUI = new Set([
  "top",
  "htop",
  "btop",
  "atop",
  "glances",
  "nmon",
  "iotop",
  "nethogs",
  "bmon",
  "ncdu",
  "mc", // midnight commander
  "ranger",
  "nnn",
  "vifm",
  "tmux",
  "screen",
]);

// ── Database CLIs (interactive without -e/-c flag) ──────────────────

const DATABASE_CLIS: Record<string, { flags: string[]; suggestion: string }> = {
  mysql: {
    flags: ["-e", "--execute"],
    suggestion: 'Use: mysql -e "SELECT ..." or mysql < script.sql',
  },
  psql: {
    flags: ["-c", "--command", "-f", "--file"],
    suggestion: 'Use: psql -c "SELECT ..." or psql -f script.sql',
  },
  mongosh: {
    flags: ["--eval"],
    suggestion: 'Use: mongosh --eval "db.collection.find()"',
  },
  mongo: {
    flags: ["--eval"],
    suggestion: 'Use: mongo --eval "db.collection.find()"',
  },
  sqlite3: {
    flags: [], // sqlite3 with a filename + no stdin is fine, but bare sqlite3 is interactive
    suggestion:
      'Use: sqlite3 db.sqlite "SELECT ..." or sqlite3 db.sqlite < script.sql',
  },
  "redis-cli": {
    flags: ["--pipe", "--eval"],
    suggestion: "Use: redis-cli GET key or redis-cli --eval script.lua",
  },
  // Windows
  sqlcmd: {
    flags: ["-Q", "-i", "-q"],
    suggestion: 'Use: sqlcmd -Q "SELECT ..." or sqlcmd -i script.sql',
  },
  "sqlcmd.exe": {
    flags: ["-Q", "-i", "-q"],
    suggestion: 'Use: sqlcmd -Q "SELECT ..." or sqlcmd -i script.sql',
  },
};

// ── REPLs (no arguments = interactive) ──────────────────────────────

const REPL_COMMANDS: Record<
  string,
  { nonInteractiveFlags: string[]; suggestion: string }
> = {
  python: {
    nonInteractiveFlags: ["-c", "-m", "-"],
    suggestion: "Use: python -c \"print('hello')\" or python script.py",
  },
  python3: {
    nonInteractiveFlags: ["-c", "-m", "-"],
    suggestion: "Use: python3 -c \"print('hello')\" or python3 script.py",
  },
  node: {
    nonInteractiveFlags: ["-e", "--eval", "-p", "--print", "--input-type"],
    suggestion: "Use: node -e \"console.log('hello')\" or node script.js",
  },
  ruby: {
    nonInteractiveFlags: ["-e"],
    suggestion: "Use: ruby -e \"puts 'hello'\" or ruby script.rb",
  },
  irb: {
    nonInteractiveFlags: [],
    suggestion: 'Use: ruby -e "..." instead of irb',
  },
  php: {
    nonInteractiveFlags: ["-r", "-f"],
    suggestion: "Use: php -r \"echo 'hello';\" or php script.php",
  },
  lua: {
    nonInteractiveFlags: ["-e"],
    suggestion: "Use: lua -e \"print('hello')\" or lua script.lua",
  },
  perl: {
    nonInteractiveFlags: ["-e", "-E"],
    suggestion: "Use: perl -e \"print 'hello'\" or perl script.pl",
  },
};

// ── Git interactive flags ───────────────────────────────────────────

const GIT_INTERACTIVE_FLAGS: Record<
  string,
  { flags: string[]; suggestion: string }
> = {
  rebase: {
    flags: ["-i", "--interactive"],
    suggestion:
      "Interactive rebase requires manual input. Consider using non-interactive rebase or specific git commands instead.",
  },
  add: {
    flags: ["-i", "--interactive", "-p", "--patch"],
    suggestion: "Use: git add <specific-files> instead of interactive staging.",
  },
  checkout: {
    flags: ["-p", "--patch"],
    suggestion:
      "Use: git checkout <specific-files> instead of interactive patch mode.",
  },
  stash: {
    flags: ["-p", "--patch"],
    suggestion:
      "Use: git stash or git stash push <specific-files> instead of interactive patch mode.",
  },
  reset: {
    flags: ["-p", "--patch"],
    suggestion:
      "Use: git reset <specific-files> instead of interactive patch mode.",
  },
  commit: {
    flags: ["-p", "--patch"],
    suggestion:
      'Use: git add <files> && git commit -m "message" instead of interactive patch mode.',
  },
};

// ── Remote connection commands ───────────────────────────────────────

const REMOTE_COMMANDS = new Set([
  "ssh",
  "telnet",
  "ftp",
  "sftp",
  // Windows
  "plink",
  "plink.exe",
]);

// ── Interactive shell commands ───────────────────────────────────────

const SHELL_COMMANDS = new Set([
  "bash",
  "zsh",
  "sh",
  "fish",
  "csh",
  "tcsh",
  "ksh",
  "dash",
  // Windows
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "cmd",
  "cmd.exe",
]);

// ── Scaffolding commands that often prompt ───────────────────────────

const SCAFFOLDING_PREFIXES: Array<{
  prefix: string;
  yesFlags: string[];
  suggestion: string;
}> = [
  {
    prefix: "npx create-",
    yesFlags: [
      "--yes",
      "-y",
      "--use-npm",
      "--use-yarn",
      "--use-pnpm",
      "--use-bun",
    ],
    suggestion:
      "Pass all configuration flags upfront to avoid interactive prompts. For create-next-app, use: npx create-next-app@latest myapp --typescript --tailwind --eslint --app --src-dir --use-npm",
  },
  {
    prefix: "npm create ",
    yesFlags: ["--yes", "-y", "--"],
    suggestion:
      "Use -- to pass flags to the underlying scaffolder, or use npx with explicit flags.",
  },
  {
    prefix: "npm init",
    yesFlags: ["-y", "--yes", "-w", "--workspace"],
    suggestion:
      "Use: npm init -y for default package.json, or npm init -y -w packages/name for workspaces.",
  },
  {
    prefix: "yarn create ",
    yesFlags: ["--"],
    suggestion: "Pass all configuration flags to avoid interactive prompts.",
  },
  {
    prefix: "pnpm create ",
    yesFlags: ["--"],
    suggestion: "Pass all configuration flags to avoid interactive prompts.",
  },
];

// ── Password / credential prompts ────────────────────────────────────

const PASSWORD_COMMANDS = new Set(["passwd", "chpasswd", "su"]);

/**
 * Validate a command for known interactive patterns.
 * Returns null if the command appears safe, or a result with a rejection message.
 */
export function validateInteractiveCommand(
  command: string,
): InteractiveValidationResult | null {
  // Split on compound operators (&&, ||, ;) and check each sub-command
  const subCommands = splitOnCompoundOperators(command);

  for (const sub of subCommands) {
    const trimmed = sub.trim();
    if (!trimmed) continue;

    const violation = checkSingleCommand(trimmed);
    if (violation) {
      return {
        message: [
          `Command rejected: ${violation.reason}`,
          ``,
          violation.suggestion,
        ].join("\n"),
      };
    }
  }

  return null;
}

function checkSingleCommand(command: string): InteractiveViolation | null {
  const tokens = tokenize(command);
  if (tokens.length === 0) return null;

  // Skip env var prefixes (FOO=bar cmd ...)
  let cmdIndex = 0;
  while (cmdIndex < tokens.length && tokens[cmdIndex].includes("=")) {
    cmdIndex++;
  }
  if (cmdIndex >= tokens.length) return null;

  // Handle sudo prefix
  let cmd = tokens[cmdIndex];
  let argsStart = cmdIndex + 1;
  if (cmd === "sudo" && cmdIndex + 1 < tokens.length) {
    // Skip sudo flags like -u, -E, etc.
    let i = cmdIndex + 1;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      // Flags that take a value
      if (["-u", "-g", "-C", "-D", "-R", "-T"].includes(tokens[i])) {
        i += 2;
      } else {
        i++;
      }
    }
    if (i < tokens.length) {
      cmd = tokens[i];
      argsStart = i + 1;
    }
  }

  const args = tokens.slice(argsStart);

  // ── Check interactive editors ─────────────────────────────────
  if (INTERACTIVE_EDITORS.has(cmd)) {
    return {
      command: cmd,
      reason: `"${cmd}" is an interactive editor that requires keyboard input.`,
      suggestion: `Use the write_file or apply_diff tool to edit files instead.`,
    };
  }

  // ── Check TUI apps ───────────────────────────────────────────
  if (INTERACTIVE_TUI.has(cmd)) {
    return {
      command: cmd,
      reason: `"${cmd}" is an interactive TUI application that requires keyboard input.`,
      suggestion: `Use non-interactive alternatives. For disk usage: du -sh *. For process info: ps aux. For network: ss -tlnp.`,
    };
  }

  // ── Check database CLIs ───────────────────────────────────────
  const dbInfo = DATABASE_CLIS[cmd];
  if (dbInfo) {
    const hasNonInteractiveFlag = dbInfo.flags.some((f) => args.includes(f));
    // sqlite3 with at least a filename and a query arg is fine
    if (cmd === "sqlite3" && args.length >= 2) return null;
    if (
      !hasNonInteractiveFlag &&
      !(cmd === "redis-cli" && args.length > 0 && !args[0].startsWith("-"))
    ) {
      return {
        command: cmd,
        reason: `"${cmd}" without a command flag opens an interactive session.`,
        suggestion: dbInfo.suggestion,
      };
    }
  }

  // ── Check REPLs (no script file = interactive) ────────────────
  const replInfo = REPL_COMMANDS[cmd];
  if (replInfo) {
    // If there are no args at all, or only flags but no script file / -c / -e
    const hasNonInteractiveArg =
      replInfo.nonInteractiveFlags.some((f) => args.includes(f)) ||
      args.some((a) => !a.startsWith("-") && a !== cmd);
    if (!hasNonInteractiveArg) {
      return {
        command: cmd,
        reason: `"${cmd}" without arguments opens an interactive REPL.`,
        suggestion: replInfo.suggestion,
      };
    }
  }

  // ── Check git interactive flags and editor-opening flows ──────
  if (cmd === "git" && args.length > 0) {
    const gitSubCmd = args[0];
    const gitInfo = GIT_INTERACTIVE_FLAGS[gitSubCmd];
    if (gitInfo) {
      const gitArgs = args.slice(1);
      const hasInteractiveFlag = gitInfo.flags.some((f) => gitArgs.includes(f));
      if (hasInteractiveFlag) {
        return {
          command: `git ${gitSubCmd}`,
          reason: `"git ${gitSubCmd}" with interactive flags requires manual input.`,
          suggestion: gitInfo.suggestion,
        };
      }
    }

    const gitArgs = args.slice(1);
    if (gitSubCmd === "commit" && opensGitEditorWithoutMessage(gitArgs)) {
      return {
        command: "git commit",
        reason:
          '"git commit" without -m/-F/--no-edit may open an editor for the commit message.',
        suggestion:
          'Use: git commit -m "message" or git commit -F message.txt. For amend flows, use --no-edit when appropriate.',
      };
    }

    if (gitSubCmd === "tag" && opensAnnotatedTagEditor(gitArgs)) {
      return {
        command: "git tag",
        reason:
          'Annotated "git tag" without -m/-F may open an editor for the tag message.',
        suggestion:
          'Use: git tag -a <tag> -m "message" or git tag -a <tag> -F message.txt.',
      };
    }

    if (gitSubCmd === "revert" && opensGitEditorWithoutNoEdit(gitArgs)) {
      return {
        command: "git revert",
        reason:
          '"git revert" without --no-edit may open an editor for the revert message.',
        suggestion:
          "Use: git revert --no-edit <commit> when the default message is acceptable.",
      };
    }

    if (gitSubCmd === "cherry-pick" && opensGitEditorWithoutNoEdit(gitArgs)) {
      return {
        command: "git cherry-pick",
        reason:
          '"git cherry-pick" without --no-edit may open an editor for the commit message.',
        suggestion:
          "Use: git cherry-pick --no-edit <commit> when the default message is acceptable.",
      };
    }

    if (gitSubCmd === "notes" && gitArgs[0] === "edit") {
      return {
        command: "git notes edit",
        reason: '"git notes edit" opens an editor for note content.',
        suggestion:
          'Use: git notes add -m "note" <object> or git notes append -m "note" <object> instead.',
      };
    }
  }

  // ── Check remote connection commands ──────────────────────────
  if (REMOTE_COMMANDS.has(cmd)) {
    return {
      command: cmd,
      reason: `"${cmd}" opens an interactive remote connection.`,
      suggestion: `For remote commands, use: ssh host "command" to run a single command non-interactively.`,
    };
  }

  // ── Check interactive shells ──────────────────────────────────
  if (SHELL_COMMANDS.has(cmd)) {
    const hasCFlag = args.includes("-c");
    const hasScript = args.some((a) => !a.startsWith("-"));
    if (!hasCFlag && !hasScript) {
      return {
        command: cmd,
        reason: `"${cmd}" without -c or a script opens an interactive shell.`,
        suggestion: `Use: ${cmd} -c "command" to run a single command.`,
      };
    }
  }

  // ── Check scaffolding commands ────────────────────────────────
  const fullCmd = tokens.slice(cmdIndex).join(" ");
  for (const scaffold of SCAFFOLDING_PREFIXES) {
    if (
      fullCmd.startsWith(scaffold.prefix) ||
      fullCmd.startsWith(scaffold.prefix.trimEnd())
    ) {
      // Check if any yes/non-interactive flag is present
      const hasYesFlag = scaffold.yesFlags.some((f) => args.includes(f));
      if (!hasYesFlag) {
        return {
          command: fullCmd,
          reason: `"${scaffold.prefix.trim()}" may prompt for interactive input.`,
          suggestion: scaffold.suggestion,
        };
      }
    }
  }

  // ── Check password commands ───────────────────────────────────
  if (PASSWORD_COMMANDS.has(cmd)) {
    return {
      command: cmd,
      reason: `"${cmd}" prompts for password input.`,
      suggestion: `Password changes require interactive input and cannot be automated safely in this terminal.`,
    };
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Split on && ; || while respecting quotes (reused from pipeValidator).
 */
function splitOnCompoundOperators(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === "&" && i + 1 < command.length && command[i + 1] === "&") {
        segments.push(current);
        current = "";
        i += 2;
        continue;
      }
      if (ch === "|" && i + 1 < command.length && command[i + 1] === "|") {
        segments.push(current);
        current = "";
        i += 2;
        continue;
      }
      if (ch === ";") {
        segments.push(current);
        current = "";
        i++;
        continue;
      }
    }

    current += ch;
    i++;
  }

  segments.push(current);
  return segments;
}

function opensGitEditorWithoutMessage(args: string[]): boolean {
  const hasMessageFlag = args.some((arg) =>
    ["-m", "--message", "-F", "--file", "--fixup", "--squash"].includes(arg),
  );
  const hasNoEdit = args.includes("--no-edit");
  const isAmend = args.includes("--amend");
  return !hasMessageFlag && !(isAmend && hasNoEdit);
}

function opensAnnotatedTagEditor(args: string[]): boolean {
  const isAnnotated =
    args.includes("-a") || args.includes("-s") || args.includes("-u");
  if (!isAnnotated) return false;
  return !args.some((arg) => ["-m", "--message", "-F", "--file"].includes(arg));
}

function opensGitEditorWithoutNoEdit(args: string[]): boolean {
  return !args.includes("--no-edit");
}

/**
 * Simple tokenizer: split on whitespace, respecting quotes and escapes.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (ch === "\\" && i + 1 < input.length && !inSingle) {
      current += ch + input[i + 1];
      i++;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}
