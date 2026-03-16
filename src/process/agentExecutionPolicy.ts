export interface AgentExecutionEnvOptions {
  extraEnv?: Record<string, string | undefined>;
}

export function buildAgentExecutionEnv(
  options: AgentExecutionEnvOptions = {},
): Record<string, string> {
  const base: Record<string, string> = {
    CLAUDE_CODE: "1",
    CLAUDECODE: "1",
    AGENTLINK: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_MERGE_AUTOEDIT: "no",
    npm_config_yes: "true",
    DEBIAN_FRONTEND: "noninteractive",
    VTE_VERSION: "0",
    PROMPT_EOL_MARK: "",
    SYSTEMD_PAGER: "",
  };

  if (process.platform === "win32") {
    base.PAGER = "";
    base.GIT_PAGER = "";
    base.MANPAGER = "";
  } else {
    base.PAGER = "cat";
    base.GIT_PAGER = "cat";
    base.MANPAGER = "cat";
  }

  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    if (value !== undefined) {
      base[key] = value;
    }
  }

  return base;
}

export function inheritProcessEnv(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      inherited[key] = value;
    }
  }
  return inherited;
}
