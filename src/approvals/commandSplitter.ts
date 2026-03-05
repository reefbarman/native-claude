/**
 * Split a compound shell command on &&, ||, |, ;, and newlines while
 * respecting single/double quotes, backslash escapes, and # comments.
 */
export function splitCompoundCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    // Backslash escape (skip next character)
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }

    // Quote tracking
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

    // Only split when outside quotes
    if (!inSingle && !inDouble) {
      // # comment — skip to end of line (only at word boundary:
      // start of command, or preceded by whitespace/separator)
      if (ch === "#" && (current.trim() === "" || /\s$/.test(current))) {
        // Flush anything before the comment
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = "";
        // Skip to end of line or end of string
        while (i < command.length && command[i] !== "\n") {
          i++;
        }
        // Skip the newline itself
        if (i < command.length) i++;
        continue;
      }

      // Newline — treat like ;
      if (ch === "\n") {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = "";
        i++;
        continue;
      }

      // && operator
      if (ch === "&" && i + 1 < command.length && command[i + 1] === "&") {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = "";
        i += 2;
        continue;
      }

      // || operator
      if (ch === "|" && i + 1 < command.length && command[i + 1] === "|") {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = "";
        i += 2;
        continue;
      }

      // | pipe
      if (ch === "|") {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = "";
        i++;
        continue;
      }

      // ; separator
      if (ch === ";") {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = "";
        i++;
        continue;
      }
    }

    current += ch;
    i++;
  }

  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);

  return parts;
}

// ── Wrapper expansion ─────────────────────────────────────────────────────────

// Wrapper commands and their flags that consume a following value token.
// Any flag NOT listed here is assumed to be a boolean flag (no value).
const WRAPPERS = new Map<string, Set<string>>([
  [
    "sudo",
    new Set([
      "-u",
      "--user",
      "-g",
      "--group",
      "-C",
      "-D",
      "-R",
      "-T",
      "-r",
      "--role",
      "-t",
      "--type",
      "-p",
      "--prompt",
    ]),
  ],
  [
    "xargs",
    new Set([
      "-I",
      "-L",
      "-n",
      "-P",
      "-d",
      "-s",
      "-E",
      "-a",
      "--arg-file",
      "--delimiter",
      "--max-args",
      "--max-procs",
      "--replace",
    ]),
  ],
  ["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
  ["watch", new Set(["-n", "--interval", "-d", "--differences"])],
  ["nohup", new Set()],
  ["time", new Set()],
  ["strace", new Set(["-e", "-o", "-p", "-s", "-u", "-E"])],
  ["command", new Set()],
  ["builtin", new Set()],
]);

/**
 * If `cmd` is a wrapper command (sudo, xargs, env, etc.), extracts and returns
 * the inner command being invoked. Recursively unwraps nested wrappers
 * (e.g. `sudo env FOO=bar npm test` → `npm test`).
 *
 * Returns null if the command is not a wrapper.
 */
export function unwrapCommand(cmd: string): string | null {
  let current = cmd.trim();
  let unwrapped = false;

  // Max 5 levels of nesting (sudo env nice ... command)
  for (let depth = 0; depth < 5; depth++) {
    const inner = unwrapOnce(current);
    if (!inner) break;
    current = inner;
    unwrapped = true;
  }

  return unwrapped ? current : null;
}

/**
 * Expand sub-commands by decomposing wrapper commands.
 * `["cd /foo", "xargs rm -rf"]` → `["cd /foo", "xargs", "rm -rf"]`
 * `["sudo -u root npm install"]` → `["sudo", "npm install"]`
 */
export function expandSubCommands(subCommands: string[]): string[] {
  const expanded: string[] = [];
  for (const sub of subCommands) {
    const inner = unwrapCommand(sub);
    if (inner) {
      expanded.push(firstToken(sub.trim())); // just the wrapper name
      expanded.push(inner);
    } else {
      expanded.push(sub);
    }
  }
  return expanded;
}

function unwrapOnce(cmd: string): string | null {
  const tokens = tokenizeCommand(cmd);
  if (tokens.length < 2) return null;

  const wrapper = tokens[0];
  const valueFlags = WRAPPERS.get(wrapper);
  if (valueFlags === undefined) return null;

  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i];

    // Skip flags
    if (tok.startsWith("-")) {
      i++;
      // --flag=value form — value is already consumed
      if (tok.includes("=")) continue;
      // If this flag takes a separate value token, skip that too
      if (valueFlags.has(tok) && i < tokens.length) {
        i++;
      }
      continue;
    }

    // env: skip VAR=val pairs
    if (wrapper === "env" && tok.includes("=") && !tok.startsWith("=")) {
      i++;
      continue;
    }

    // timeout: first positional arg is the duration — skip it
    if (wrapper === "timeout" && /^[\d.]/.test(tok)) {
      i++;
      continue;
    }

    // Found the start of the inner command
    break;
  }

  if (i >= tokens.length) return null;
  return tokens.slice(i).join(" ");
}

/** Extract the first whitespace-delimited token from a string */
function firstToken(cmd: string): string {
  const match = cmd.match(/^(\S+)/);
  return match ? match[1] : "";
}

/**
 * Tokenize a command string on whitespace, respecting quotes and escapes.
 * Quotes are preserved in the output tokens so the result can be rejoined.
 */
function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    // Backslash escape
    if (ch === "\\" && i + 1 < cmd.length && !inSingle) {
      current += ch + cmd[i + 1];
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
