# PreToolUse hook for Claude Code and VS Code Copilot (Windows)
# Blocks built-in tools when AgentLink MCP equivalents should be used.
# Logs violations to ~\.agentlink\agentlink-violations.jsonl
#
# Auto-detects the calling agent from input JSON:
#   - Copilot includes "hookEventName" in input; Claude Code does not
#   - Output format differs: Claude uses {decision: "block"}, Copilot uses {hookSpecificOutput: {permissionDecision: "deny"}}
#
# Install: Add to ~/.claude/settings.json (see README for details)

$ErrorActionPreference = "Stop"

# Skip AgentLink enforcement for Claude Code CLI sessions.
# Treat missing/unknown entrypoints as CLI to avoid over-enforcing outside IDE flows.
$entrypoint = [Environment]::GetEnvironmentVariable("CLAUDE_CODE_ENTRYPOINT")
if ([string]::IsNullOrWhiteSpace($entrypoint) -or $entrypoint.ToLowerInvariant() -eq "cli") {
    exit 0
}

# Read hook input from stdin
$inputText = [Console]::In.ReadToEnd()
$input = $inputText | ConvertFrom-Json
$toolName = $input.tool_name

# Detect calling agent: Copilot includes hookEventName, Claude Code does not
$hookEvent = ""
if ($input.PSObject.Properties["hookEventName"]) {
    $hookEvent = $input.hookEventName
}

# Allow built-in file tools for markdown files in plans directories
# Agents use built-in tools for plan files - these don't need agentlink's diff view
$fileTools = @("Read", "Write", "Edit", "readFile", "editFiles", "createFile")
if ($toolName -in $fileTools) {
    $planPath = ""
    if ($input.tool_input) {
        foreach ($field in @("file_path", "filePath", "path")) {
            if ($input.tool_input.PSObject.Properties[$field]) {
                $planPath = $input.tool_input.$field
                break
            }
        }
    }
    if ($planPath -and $planPath -match '(^|[/\\])plans[/\\][^/\\]*\.md$') {
        exit 0
    }
}

# Allow Read for non-text file types that agentlink can't handle
# (images, PDFs, notebooks - Claude's built-in Read handles these natively)
if ($toolName -eq "Read") {
    $filePath = ""
    if ($input.tool_input -and $input.tool_input.PSObject.Properties["file_path"]) {
        $filePath = $input.tool_input.file_path
    }
    if ($filePath) {
        $ext = [System.IO.Path]::GetExtension($filePath).TrimStart(".").ToLower()
        $allowedExts = @(
            # Images (Claude is multimodal - built-in Read displays these visually)
            "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "ico", "tiff", "tif", "avif",
            # PDFs (built-in Read supports pages parameter)
            "pdf",
            # Jupyter notebooks (built-in Read renders cells + outputs)
            "ipynb"
        )
        if ($ext -in $allowedExts) {
            exit 0
        }
    }
}

# Map built-in tools to agentlink equivalents
$alt = switch ($toolName) {
    # Claude Code built-in tools
    "Read"    { "read_file" }
    "Edit"    { "apply_diff or find_and_replace" }
    "Write"   { "write_file" }
    "Bash"    { "execute_command" }
    "Glob"    { "list_files" }
    "Grep"    { "search_files" }
    # Copilot built-in tools
    "editFiles"     { "apply_diff or write_file" }
    "createFile"    { "write_file" }
    "readFile"      { "read_file" }
    "runInTerminal" { "execute_command" }
    "getErrors"     { "get_diagnostics" }
    "listFiles"     { "list_files" }
    default   { $null }
}

# Not a blocked tool - allow
if (-not $alt) {
    exit 0
}

# Log the violation
$logDir = Join-Path $env:USERPROFILE ".agentlink"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$logFile = Join-Path $logDir "agentlink-violations.jsonl"

$toolInput = if ($input.tool_input) { $input.tool_input } else { @{} }
$timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$logEntry = @{
    timestamp    = $timestamp
    blocked_tool = $toolName
    suggested    = $alt
    tool_input   = $toolInput
} | ConvertTo-Json -Compress
Add-Content -Path $logFile -Value $logEntry

# Block with reason - agent sees this and retries with the correct tool
$reason = "BLOCKED: Use agentlink ``$alt`` instead of built-in ``$toolName``. The agentlink MCP server provides VS Code-integrated equivalents with diff views, integrated terminal, and real diagnostics."

if ($hookEvent) {
    # Copilot format
    @{
        hookSpecificOutput = @{
            hookEventName           = "PreToolUse"
            permissionDecision      = "deny"
            permissionDecisionReason = $reason
        }
    } | ConvertTo-Json -Depth 3
} else {
    # Claude Code format
    @{
        decision = "block"
        reason   = $reason
    } | ConvertTo-Json
}
