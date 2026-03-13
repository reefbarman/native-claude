#!/usr/bin/env bash
# PreToolUse hook for Claude Code and VS Code Copilot
# Blocks built-in tools when AgentLink MCP equivalents should be used.
# Logs violations to ~/.agentlink/agentlink-violations.jsonl
#
# Auto-detects the calling agent from input JSON:
#   - Copilot includes "hookEventName" in input; Claude Code does not
#   - Output format differs: Claude uses {decision: "block"}, Copilot uses {hookSpecificOutput: {permissionDecision: "deny"}}
#
# Install: Add to ~/.claude/settings.json (see README for details)
# Requires: jq

set -euo pipefail

# Skip AgentLink enforcement for Claude Code CLI sessions.
# Treat missing/unknown entrypoints as CLI to avoid over-enforcing outside IDE flows.
entrypoint="${CLAUDE_CODE_ENTRYPOINT:-}"
entrypoint_lower=$(printf '%s' "$entrypoint" | tr '[:upper:]' '[:lower:]')
if [ -z "$entrypoint_lower" ] || [ "$entrypoint_lower" = "cli" ]; then
  exit 0
fi

# Read hook input from stdin
input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name')

# Detect calling agent: Copilot includes hookEventName, Claude Code does not
hook_event=$(echo "$input" | jq -r '.hookEventName // ""')

# Allow built-in file tools for markdown files in plans directories
# Agents use built-in tools for plan files — these don't need agentlink's diff view
file_tools_re="^(Read|Write|Edit|readFile|editFiles|createFile)$"
if [[ "$tool_name" =~ $file_tools_re ]]; then
  file_path=$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.filePath // .tool_input.path // ""')
  if echo "$file_path" | grep -qiE '(^|[\\/])plans[\\/][^\\/]*\.md$'; then
    exit 0
  fi
fi

# Allow Read for non-text file types that agentlink can't handle
# (images, PDFs, notebooks — Claude's built-in Read handles these natively)
if [ "$tool_name" = "Read" ]; then
  file_path=$(echo "$input" | jq -r '.tool_input.file_path // ""')
  ext="${file_path##*.}"
  ext_lower=$(echo "$ext" | tr '[:upper:]' '[:lower:]')
  case "$ext_lower" in
    # Images (Claude is multimodal — built-in Read displays these visually)
    png|jpg|jpeg|gif|bmp|svg|webp|ico|tiff|tif|avif)  exit 0 ;;
    # PDFs (built-in Read supports pages parameter)
    pdf)  exit 0 ;;
    # Jupyter notebooks (built-in Read renders cells + outputs)
    ipynb)  exit 0 ;;
  esac
fi

# Map built-in tools to agentlink equivalents
case "$tool_name" in
  # Claude Code built-in tools
  Read)     alt="read_file" ;;
  Edit)     alt="apply_diff or find_and_replace" ;;
  Write)    alt="write_file" ;;
  Bash)     alt="execute_command" ;;
  Glob)     alt="list_files" ;;
  Grep)     alt="search_files" ;;
  # Copilot built-in tools
  editFiles)     alt="apply_diff or write_file" ;;
  createFile)    alt="write_file" ;;
  readFile)      alt="read_file" ;;
  runInTerminal) alt="execute_command" ;;
  getErrors)     alt="get_diagnostics" ;;
  listFiles)     alt="list_files" ;;
  *)        exit 0 ;; # Not a blocked tool — allow
esac

# Log the violation
log_dir="${HOME}/.agentlink"
mkdir -p "$log_dir"
log_file="${log_dir}/agentlink-violations.jsonl"
tool_input=$(echo "$input" | jq -c '.tool_input // {}')
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
jq -n -c \
  --arg ts "$timestamp" \
  --arg tool "$tool_name" \
  --arg alt "$alt" \
  --argjson input "$tool_input" \
  '{timestamp: $ts, blocked_tool: $tool, suggested: $alt, tool_input: $input}' \
  >> "$log_file"

# Block with reason — agent sees this and retries with the correct tool
reason="BLOCKED: Use agentlink \`$alt\` instead of built-in \`$tool_name\`. The agentlink MCP server provides VS Code-integrated equivalents with diff views, integrated terminal, and real diagnostics."

if [ -n "$hook_event" ]; then
  # Copilot format
  jq -n \
    --arg reason "$reason" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
else
  # Claude Code format
  jq -n \
    --arg reason "$reason" \
    '{decision: "block", reason: $reason}'
fi
