/**
 * Tool adapter for the built-in agent.
 *
 * Converts shared zod schemas to Claude SDK tool definitions and dispatches
 * tool calls to the existing handler functions in src/tools/*.ts.
 */

import type { ToolDefinition, JsonSchema } from "./providers/types.js";
import { z } from "zod";
import * as vscode from "vscode";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolResult } from "../shared/types.js";
import type {
  SpawnBackgroundRequest,
  SpawnBackgroundResult,
} from "./backgroundTypes.js";
import { TOOL_REGISTRY } from "../shared/toolRegistry.js";
import * as schemas from "../shared/toolSchemas.js";
import type { AgentMode } from "./modes.js";
import { getToolsForMode } from "./toolPermissions.js";
import { McpClientHub } from "./McpClientHub.js";
import {
  getMcpConfigFilePaths,
  persistMcpToolApproval,
  persistMcpServerApproval,
} from "./mcpConfig.js";

// --- Handler imports ---
import { handleReadFile } from "../tools/readFile.js";
import { handleListFiles } from "../tools/listFiles.js";
import { handleSearchFiles } from "../tools/searchFiles.js";
import { handleWriteFile } from "../tools/writeFile.js";
import { handleApplyDiff } from "../tools/applyDiff.js";
import { handleFindAndReplace } from "../tools/findAndReplace.js";
import { handleExecuteCommand } from "../tools/executeCommand.js";
import { handleGetTerminalOutput } from "../tools/getTerminalOutput.js";
import { handleCloseTerminals } from "../tools/closeTerminals.js";
import { handleOpenFile } from "../tools/openFile.js";
import { handleShowNotification } from "../tools/showNotification.js";
import { handleGetDiagnostics } from "../tools/getDiagnostics.js";
import { handleGoToDefinition } from "../tools/goToDefinition.js";
import { handleGoToImplementation } from "../tools/goToImplementation.js";
import { handleGoToTypeDefinition } from "../tools/goToTypeDefinition.js";
import { handleGetReferences } from "../tools/getReferences.js";
import { handleGetSymbols } from "../tools/getSymbols.js";
import { handleGetHover } from "../tools/getHover.js";
import { handleGetCompletions } from "../tools/getCompletions.js";
import {
  handleGetCodeActions,
  handleApplyCodeAction,
} from "../tools/codeActions.js";
import { handleGetCallHierarchy } from "../tools/getCallHierarchy.js";
import { handleGetTypeHierarchy } from "../tools/getTypeHierarchy.js";
import { handleGetInlayHints } from "../tools/getInlayHints.js";
import { handleRenameSymbol } from "../tools/renameSymbol.js";
import { handleSendFeedback } from "../tools/sendFeedback.js";
import { handleGetFeedback } from "../tools/getFeedback.js";
import { handleDeleteFeedback } from "../tools/deleteFeedback.js";

// --- Read-only tools (safe to execute in parallel) ---

export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_files",
  "search_files",
  "codebase_search",
  "get_diagnostics",
  "get_hover",
  "get_symbols",
  "get_references",
  "go_to_definition",
  "go_to_implementation",
  "go_to_type_definition",
  "get_call_hierarchy",
  "get_type_hierarchy",
  "get_inlay_hints",
  "get_completions",
  "get_code_actions",
  "open_file",
  "show_notification",
  "get_terminal_output",
  "ask_user",
  "switch_mode",
  "spawn_background_agent",
  "get_background_status",
  "get_background_result",
]);

// --- Tools excluded from the agent (MCP-only or not applicable) ---

const EXCLUDED_TOOLS = new Set(["handshake"]);
const DEV_FEEDBACK_TOOLS = new Set([
  "send_feedback",
  "get_feedback",
  "delete_feedback",
]);

// --- Zod schema record → JSON Schema conversion ---

function zodSchemaToJsonSchema(
  schema: Record<string, z.ZodTypeAny>,
): JsonSchema {
  const obj = z.object(schema);
  // Zod v4 has built-in JSON Schema support (zod-to-json-schema doesn't support v4)
  const jsonSchema = z.toJSONSchema(obj) as Record<string, unknown>;
  const { $schema: _, ...rest } = jsonSchema;
  return rest as JsonSchema;
}

// --- Tool name → zod schema mapping ---

const TOOL_SCHEMAS: Record<string, Record<string, z.ZodTypeAny>> = {
  read_file: schemas.readFileSchema,
  list_files: schemas.listFilesSchema,
  search_files: schemas.searchFilesSchema,
  get_diagnostics: schemas.getDiagnosticsSchema,
  write_file: schemas.writeFileSchema,
  apply_diff: schemas.applyDiffSchema,
  find_and_replace: schemas.findAndReplaceSchema,
  rename_symbol: schemas.renameSymbolSchema,
  open_file: schemas.openFileSchema,
  show_notification: schemas.showNotificationSchema,
  execute_command: schemas.executeCommandSchema,
  get_terminal_output: schemas.getTerminalOutputSchema,
  close_terminals: schemas.closeTerminalsSchema,
  go_to_definition: schemas.positionSchema,
  go_to_implementation: schemas.positionSchema,
  go_to_type_definition: schemas.positionSchema,
  get_hover: schemas.positionSchema,
  get_references: schemas.getReferencesSchema,
  get_symbols: schemas.getSymbolsSchema,
  get_completions: schemas.getCompletionsSchema,
  get_code_actions: schemas.getCodeActionsSchema,
  apply_code_action: schemas.applyCodeActionSchema,
  get_call_hierarchy: schemas.getCallHierarchySchema,
  get_type_hierarchy: schemas.getTypeHierarchySchema,
  get_inlay_hints: schemas.getInlayHintsSchema,
  codebase_search: schemas.codebaseSearchSchema,
  ...(__DEV_BUILD__
    ? {
        send_feedback: {
          tool_name: z
            .string()
            .describe("Name of the tool this feedback is about"),
          feedback: z
            .string()
            .describe(
              "Description of the issue, suggestion, or missing feature",
            ),
          tool_params: z
            .string()
            .optional()
            .describe(
              "Optional serialized params passed to the tool (helps reproduce)",
            ),
          tool_result_summary: z
            .string()
            .optional()
            .describe("Optional summary of what happened / unexpected result"),
        },
        get_feedback: {
          tool_name: z
            .string()
            .optional()
            .describe(
              "Filter to feedback about a specific tool (omit for all feedback)",
            ),
        },
        delete_feedback: {
          indices: z
            .array(z.coerce.number())
            .describe(
              "0-based feedback entry indices to delete (from get_feedback output)",
            ),
        },
      }
    : {}),
};

const MCP_META_TOOLS: ToolDefinition[] = [
  {
    name: "list_mcp_resources",
    description: "List all resources available from connected MCP servers.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "read_mcp_resource",
    description: "Read a resource from an MCP server by URI.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name" },
        uri: { type: "string", description: "Resource URI" },
      },
      required: ["server", "uri"],
    },
  },
  {
    name: "list_mcp_prompts",
    description:
      "List all prompt templates available from connected MCP servers.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_mcp_prompt",
    description:
      "Get a prompt template from an MCP server, optionally filling in arguments.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name" },
        name: { type: "string", description: "Prompt name" },
        arguments: { type: "object", description: "Optional prompt arguments" },
      },
      required: ["server", "name"],
    },
  },
];

/** Schema for the ask_user tool (always available in all modes). */
const ASK_USER_TOOL: ToolDefinition = {
  name: "ask_user",
  description:
    "Ask the user one or more structured questions and wait for their responses before continuing. For multiple_choice and multiple_select questions, always include `recommended`.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description:
          "The questions to ask. All are shown at once; the user answers all before you continue.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "Unique identifier for this question (used to map answers back)",
            },
            type: {
              type: "string",
              enum: [
                "multiple_choice",
                "multiple_select",
                "yes_no",
                "text",
                "scale",
                "confirmation",
              ],
              description: "Question type",
            },
            question: {
              type: "string",
              description: "The question text shown to the user",
            },
            options: {
              type: "array",
              items: { type: "string" },
              description:
                "Answer options (required for multiple_choice and multiple_select)",
            },
            recommended: {
              type: "string",
              description:
                "Recommended option value; required for multiple_choice and multiple_select.",
            },
            scale_min: {
              type: "number",
              description: "Scale minimum (default: 1)",
            },
            scale_max: {
              type: "number",
              description: "Scale maximum (default: 5)",
            },
            scale_min_label: {
              type: "string",
              description: "Label for the low end of the scale",
            },
            scale_max_label: {
              type: "string",
              description: "Label for the high end of the scale",
            },
          },
          required: ["id", "type", "question"],
        },
      },
    },
    required: ["questions"],
  },
};

/** Schema for the switch_mode meta-tool (always available, regardless of mode). */
const SWITCH_MODE_TOOL: ToolDefinition = {
  name: "switch_mode",
  description:
    "Request to switch the current agent mode (e.g. from 'code' to 'architect'). The user must approve the switch. Available modes: code, architect, ask, debug.",
  input_schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        description: "Target mode slug (code | architect | ask | debug)",
      },
      reason: {
        type: "string",
        description: "Brief explanation of why switching mode is helpful",
      },
    },
    required: ["mode"],
  },
};

/** Background agent management tools (only available in foreground sessions). */
const BG_AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "spawn_background_agent",
    description:
      "Spawn a background agent to work in parallel with the current session. Returns immediately with a sessionId; call get_background_result when you need the result.",
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Short label shown in the UI (max 50 chars)",
        },
        message: {
          type: "string",
          description:
            "Full instruction for the background agent. Be specific and self-contained.",
        },
        mode: {
          type: "string",
          description: "Optional target mode override (e.g. review, code, ask)",
        },
        model: {
          type: "string",
          description: "Optional explicit model override",
        },
        provider: {
          type: "string",
          description:
            "Optional provider preference/constraint (e.g. anthropic, codex)",
        },
        taskClass: {
          type: "string",
          description:
            "Task class used for routing policy (e.g. review_code, review_plan, research, debug)",
        },
        modelTier: {
          type: "string",
          description:
            'Optional routing tier override ("cheap", "balanced", or "deep_reasoning"). For review tasks, omit this to let the router infer complexity from the request.',
        },
      },
      required: ["task", "message"],
    },
  },
  {
    name: "get_background_status",
    description:
      "Non-blocking check on a background agent's progress. Use this only when you have other work to do in parallel; otherwise call get_background_result directly.",
    input_schema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The sessionId returned by spawn_background_agent",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_background_result",
    description:
      "Wait for a background agent to finish and return its final response. Call this when you are ready to use the result.",
    input_schema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The sessionId returned by spawn_background_agent",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "kill_background_agent",
    description:
      "Stop a running background agent and return any partial output collected so far.",
    input_schema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The sessionId of the background agent to stop",
        },
        reason: {
          type: "string",
          description:
            "Brief reason for killing the agent (logged for debugging)",
        },
      },
      required: ["sessionId"],
    },
  },
];

/** Return value of get_background_status — non-blocking snapshot. */
export interface BgStatusResult {
  status:
    | "streaming"
    | "tool_executing"
    | "awaiting_approval"
    | "idle"
    | "error";
  currentTool?: string;
  done: boolean;
  /** Last assistant message text, only present when done=true. */
  partialOutput?: string;
}

// --- Tool Profiles ---

/**
 * Named tool profiles that restrict the tool set for specific background task types.
 * Each profile is an allowlist of tool names from the native tool registry.
 */
const TOOL_PROFILES: Record<string, Set<string>> = {
  review: new Set([
    "read_file",
    "search_files",
    "codebase_search",
    "list_files",
    "get_diagnostics",
    "get_hover",
    "get_symbols",
    "get_references",
    "go_to_definition",
    "go_to_implementation",
    "get_type_hierarchy",
  ]),
};

// --- Public API ---

/**
 * Get tool definitions formatted for the Claude SDK.
 * When mode is provided, only tools allowed by the mode's toolGroups are included.
 * MCP tools (prefixed 'server__tool') are passed as external Anthropic.Tool objects.
 * When isBackground is true, background agent management tools are excluded.
 * When toolProfile is set, further restricts to only the tools in that profile.
 */
export function getAgentTools(
  mode?: AgentMode,
  mcpToolDefs?: ToolDefinition[],
  isBackground?: boolean,
  toolProfile?: string,
): ToolDefinition[] {
  const mcpToolNames = (mcpToolDefs ?? []).map((t) => t.name);
  const allowed = mode ? getToolsForMode(mode, mcpToolNames) : null;
  const profileAllowlist = toolProfile
    ? (TOOL_PROFILES[toolProfile] ?? new Set<string>())
    : undefined;

  const nativeTools = Object.entries(TOOL_SCHEMAS)
    .filter(([name]) => !EXCLUDED_TOOLS.has(name))
    .filter(([name]) => (__DEV_BUILD__ ? true : !DEV_FEEDBACK_TOOLS.has(name)))
    .filter(
      ([name]) =>
        !allowed ||
        allowed.has(name) ||
        (__DEV_BUILD__ && DEV_FEEDBACK_TOOLS.has(name)),
    )
    .filter(([name]) => !profileAllowlist || profileAllowlist.has(name))
    .map(([name, zodSchema]) => ({
      name,
      description: TOOL_REGISTRY[name]?.description ?? name,
      input_schema: zodSchemaToJsonSchema(zodSchema),
    }));

  // Append MCP tools if the mode allows the 'mcp' group (and not restricted by profile)
  const allowedMcpTools =
    !profileAllowlist &&
    (!mode || (mode.toolGroups.includes("mcp") && mcpToolDefs))
      ? (mcpToolDefs ?? [])
      : [];

  // Meta-tools and ask_user are always available regardless of mode restrictions
  // (but excluded when a tool profile is active — profiles are meant to be restrictive).
  // Background agents are excluded from switch_mode and spawn tools to prevent
  // inadvertent foreground mode changes and nested spawning.
  const metaTools = profileAllowlist ? [] : MCP_META_TOOLS;
  return [
    ...nativeTools,
    ...allowedMcpTools,
    ...metaTools,
    ...(profileAllowlist ? [] : [ASK_USER_TOOL]),
    ...(isBackground ? [] : [SWITCH_MODE_TOOL, ...BG_AGENT_TOOLS]),
  ];
}

/**
 * Context needed by the tool dispatcher.
 */
export interface QuestionResponse {
  answers: Record<string, string | string[] | number | boolean | undefined>;
  notes: Record<string, string>;
}

export interface ToolDispatchContext {
  approvalManager: ApprovalManager;
  approvalPanel: ApprovalPanelProvider;
  sessionId: string;
  extensionUri: import("vscode").Uri;
  trackerCtx?: import("../server/ToolCallTracker.js").TrackerContext;
  toolCallTracker?: import("../server/ToolCallTracker.js").ToolCallTracker;
  mcpHub?: McpClientHub;
  /** Current agent mode slug (e.g. "architect", "code"). Used for mode-specific approval logic. */
  mode?: string;
  onModeSwitch?: (
    mode: string,
    reason?: string,
  ) => Promise<{ approved: boolean; mode: string }>;
  onApprovalRequest?: import("../shared/types.js").OnApprovalRequest;
  onQuestion?: (
    questions: import("../agent/webview/types.js").Question[],
    sessionId: string,
  ) => Promise<QuestionResponse>;
  /** Called whenever the agent reads a file — used to track files for folded context on condense */
  onFileRead?: (filePath: string) => void;
  /** Spawn a background agent session. Returns routing metadata and new session ID. */
  onSpawnBackground?: (
    request: SpawnBackgroundRequest,
  ) => Promise<SpawnBackgroundResult>;
  /** Non-blocking status check for a background session. */
  onGetBackgroundStatus?: (sessionId: string) => BgStatusResult;
  /** Wait for a background session to finish and return its last assistant message. */
  onGetBackgroundResult?: (sessionId: string) => Promise<string>;
  /** Kill a running background agent and return its partial output. */
  onKillBackground?: (
    sessionId: string,
    reason?: string,
  ) => { killed: boolean; partialOutput?: string };
}

/**
 * Dispatch a tool call to the appropriate handler.
 * Returns ToolResult compatible with the Anthropic SDK.
 */
export async function dispatchToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolDispatchContext,
): Promise<ToolResult> {
  const {
    approvalManager,
    approvalPanel,
    sessionId,
    extensionUri,
    mcpHub,
    onApprovalRequest,
    trackerCtx,
  } = ctx;

  // Route MCP tools (prefixed with 'servername__') to the MCP hub
  if (McpClientHub.isMcpTool(toolName)) {
    if (!mcpHub) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "MCP hub not available" }),
          },
        ],
      };
    }

    // Check approval policy
    const serverName = toolName.split("__")[0];
    const serverConfig = mcpHub.getServerConfig(serverName);
    const bareToolName = toolName.slice(serverName.length + 2);
    const isAutoApproved =
      serverConfig?.toolPolicy === "allow" ||
      serverConfig?.allowedTools?.includes(bareToolName) ||
      approvalManager.isMcpApproved(sessionId, toolName);

    if (!isAutoApproved) {
      const inputPreview = JSON.stringify(input, null, 2).slice(0, 600);
      let choice: string;

      const cwd =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const configPaths = getMcpConfigFilePaths(cwd);

      if (onApprovalRequest) {
        const raw = await onApprovalRequest({
          kind: "mcp",
          title: `Allow MCP tool "${bareToolName}" from "${serverName}"?`,
          detail: inputPreview,
          choices: [
            { label: "Allow once", value: "allow-once", isPrimary: true },
            {
              label: "Always allow tool (session)",
              value: "always-tool-session",
            },
            {
              label: "Always allow tool (project)",
              value: "always-tool-project",
            },
            {
              label: "Always allow tool (global)",
              value: "always-tool-global",
            },
            {
              label: `Always allow ${serverName} (project)`,
              value: "always-server-project",
            },
            {
              label: `Always allow ${serverName} (global)`,
              value: "always-server-global",
            },
            { label: "Deny", value: "deny", isDanger: true },
          ],
        });
        choice = typeof raw === "string" ? raw : raw.decision;
      } else {
        // Fallback VS Code modal (no inline card available)
        const alwaysAllowServer = `Always allow from ${serverName}` as const;
        const vsChoice = await vscode.window.showWarningMessage(
          `Allow MCP tool "${bareToolName}" from "${serverName}"?`,
          { modal: true, detail: inputPreview },
          "Allow once",
          "Always allow this tool",
          alwaysAllowServer,
          "Deny",
        );
        choice =
          vsChoice === "Allow once"
            ? "allow-once"
            : vsChoice === "Always allow this tool"
              ? "always-tool-project"
              : vsChoice === alwaysAllowServer
                ? "always-server-project"
                : "deny";
      }

      if (choice === "deny" || !choice) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "User denied MCP tool execution" }),
            },
          ],
        };
      }

      switch (choice) {
        case "always-tool-session":
          approvalManager.approveMcpTool(sessionId, toolName);
          break;
        case "always-tool-project":
          approvalManager.approveMcpTool(sessionId, toolName);
          persistMcpToolApproval(
            serverName,
            bareToolName,
            configPaths.project,
          ).catch(() => undefined);
          break;
        case "always-tool-global":
          approvalManager.approveMcpTool(sessionId, toolName);
          persistMcpToolApproval(
            serverName,
            bareToolName,
            configPaths.global,
          ).catch(() => undefined);
          break;
        case "always-server-project":
          approvalManager.approveMcpServer(sessionId, serverName);
          persistMcpServerApproval(serverName, configPaths.project).catch(
            () => undefined,
          );
          break;
        case "always-server-global":
          approvalManager.approveMcpServer(sessionId, serverName);
          persistMcpServerApproval(serverName, configPaths.global).catch(
            () => undefined,
          );
          break;
        // "allow-once" — no extra action needed
      }
    }

    const result = await mcpHub.callTool(toolName, input);
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params = input as any;

  switch (toolName) {
    // --- File reading ---
    case "read_file":
      if (ctx.onFileRead && typeof params.path === "string") {
        ctx.onFileRead(params.path);
      }
      return handleReadFile(params, approvalManager, approvalPanel, sessionId);
    case "list_files":
      return handleListFiles(params, approvalManager, approvalPanel, sessionId);
    case "search_files":
      return handleSearchFiles(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );

    // --- File writing ---
    case "write_file":
      return handleWriteFile(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        onApprovalRequest,
        ctx.mode,
      );
    case "apply_diff":
      return handleApplyDiff(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        onApprovalRequest,
      );
    case "find_and_replace":
      return handleFindAndReplace(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        extensionUri,
        onApprovalRequest,
      );
    case "rename_symbol":
      return handleRenameSymbol(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        onApprovalRequest,
      );

    // --- Terminal ---
    case "execute_command":
      return handleExecuteCommand(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
        trackerCtx,
      );
    case "get_terminal_output":
      return handleGetTerminalOutput(params);
    case "close_terminals":
      return handleCloseTerminals(params);

    // --- Editor ---
    case "open_file":
      return handleOpenFile(params, approvalManager, approvalPanel, sessionId);
    case "show_notification":
      return handleShowNotification(params);

    // --- Diagnostics & language ---
    case "get_diagnostics":
      return handleGetDiagnostics(params);
    case "go_to_definition":
      return handleGoToDefinition(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "go_to_implementation":
      return handleGoToImplementation(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "go_to_type_definition":
      return handleGoToTypeDefinition(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "get_references":
      return handleGetReferences(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "get_symbols":
      return handleGetSymbols(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "get_hover":
      return handleGetHover(params, approvalManager, approvalPanel, sessionId);
    case "get_completions":
      return handleGetCompletions(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "get_code_actions":
      return handleGetCodeActions(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "apply_code_action":
      return handleApplyCodeAction(params, sessionId);
    case "get_call_hierarchy":
      return handleGetCallHierarchy(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "get_type_hierarchy":
      return handleGetTypeHierarchy(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );
    case "get_inlay_hints":
      return handleGetInlayHints(
        params,
        approvalManager,
        approvalPanel,
        sessionId,
      );

    // --- Search ---
    case "codebase_search": {
      const { semanticSearch } = await import("../services/semanticSearch.js");
      const { resolveAndValidatePath, tryGetFirstWorkspaceRoot } =
        await import("../util/paths.js");
      const dirPath = params.path
        ? resolveAndValidatePath(String(params.path)).absolutePath
        : (tryGetFirstWorkspaceRoot() ?? ".");
      return semanticSearch(dirPath, String(params.query), params.limit);
    }

    case "list_mcp_resources": {
      if (!mcpHub)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "MCP hub not available" }),
            },
          ],
        };
      const resources = mcpHub.getAllResources();
      return {
        content: [{ type: "text", text: JSON.stringify(resources, null, 2) }],
      };
    }

    case "read_mcp_resource": {
      if (!mcpHub)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "MCP hub not available" }),
            },
          ],
        };
      return mcpHub.readResource(
        String(params.server ?? ""),
        String(params.uri ?? ""),
      );
    }

    case "list_mcp_prompts": {
      if (!mcpHub)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "MCP hub not available" }),
            },
          ],
        };
      const prompts = mcpHub.getAllPrompts();
      return {
        content: [{ type: "text", text: JSON.stringify(prompts, null, 2) }],
      };
    }

    case "get_mcp_prompt": {
      if (!mcpHub)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "MCP hub not available" }),
            },
          ],
        };
      const args = params.arguments as Record<string, string> | undefined;
      return mcpHub.getPrompt(
        String(params.server ?? ""),
        String(params.name ?? ""),
        args,
      );
    }

    case "ask_user": {
      if (!ctx.onQuestion) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Question handler not available" }),
            },
          ],
        };
      }
      const questions =
        params.questions as import("../agent/webview/types.js").Question[];
      const response = await ctx.onQuestion(questions, ctx.sessionId);
      // Format as a readable responses array so Claude sees question + answer + note together
      const responses = questions.map((q) => {
        const answer = response.answers[q.id];
        const note = response.notes[q.id];
        const entry: Record<string, unknown> = {
          question: q.question,
          answer: answer ?? null,
        };
        if (note) entry.note = note;
        return entry;
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ responses }) }],
      };
    }

    case "switch_mode": {
      const mode = String(params.mode ?? "");
      const reason = params.reason ? String(params.reason) : undefined;
      if (!ctx.onModeSwitch) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Mode switching not available",
              }),
            },
          ],
        };
      }
      const switchResult = await ctx.onModeSwitch(mode, reason);
      if (!switchResult.approved) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected_by_user",
                reason: `User denied mode switch to "${mode}"`,
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, mode: switchResult.mode }),
          },
        ],
      };
    }

    case "spawn_background_agent": {
      if (!ctx.onSpawnBackground) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Background agents not available",
              }),
            },
          ],
        };
      }
      const result = await ctx.onSpawnBackground({
        task: String(params.task ?? ""),
        message: String(params.message ?? ""),
        mode:
          params.mode !== undefined && params.mode !== null
            ? String(params.mode)
            : undefined,
        model:
          params.model !== undefined && params.model !== null
            ? String(params.model)
            : undefined,
        provider:
          params.provider !== undefined && params.provider !== null
            ? String(params.provider)
            : undefined,
        taskClass:
          params.taskClass !== undefined && params.taskClass !== null
            ? String(params.taskClass)
            : undefined,
        modelTier:
          params.modelTier !== undefined && params.modelTier !== null
            ? String(params.modelTier) === "cheap" ||
              String(params.modelTier) === "balanced" ||
              String(params.modelTier) === "deep_reasoning"
              ? (String(
                  params.modelTier,
                ) as SpawnBackgroundRequest["modelTier"])
              : undefined
            : undefined,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "get_background_status": {
      if (!ctx.onGetBackgroundStatus) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Background agents not available",
              }),
            },
          ],
        };
      }
      const statusResult = ctx.onGetBackgroundStatus(
        String(params.sessionId ?? ""),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(statusResult) }],
      };
    }

    case "get_background_result": {
      if (!ctx.onGetBackgroundResult) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Background agents not available",
              }),
            },
          ],
        };
      }
      const bgResult = await ctx.onGetBackgroundResult(
        String(params.sessionId ?? ""),
      );
      return {
        content: [{ type: "text", text: bgResult }],
      };
    }

    case "kill_background_agent": {
      if (!ctx.onKillBackground) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Background agents not available",
              }),
            },
          ],
        };
      }
      const killResult = ctx.onKillBackground(
        String(params.sessionId ?? ""),
        params.reason !== undefined ? String(params.reason) : undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(killResult) }],
      };
    }

    case "send_feedback": {
      if (!__DEV_BUILD__) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Unknown tool: send_feedback" }),
            },
          ],
        };
      }
      return handleSendFeedback(
        {
          tool_name: String(params.tool_name ?? ""),
          feedback: String(params.feedback ?? ""),
          tool_params:
            params.tool_params !== undefined
              ? String(params.tool_params)
              : undefined,
          tool_result_summary:
            params.tool_result_summary !== undefined
              ? String(params.tool_result_summary)
              : undefined,
        },
        sessionId,
      );
    }

    case "get_feedback": {
      if (!__DEV_BUILD__) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Unknown tool: get_feedback" }),
            },
          ],
        };
      }
      return handleGetFeedback({
        tool_name:
          params.tool_name !== undefined ? String(params.tool_name) : undefined,
      });
    }

    case "delete_feedback": {
      if (!__DEV_BUILD__) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Unknown tool: delete_feedback" }),
            },
          ],
        };
      }
      const indices = Array.isArray(params.indices)
        ? params.indices
            .map((v: unknown) => Number(v))
            .filter((n: number) => Number.isFinite(n))
        : [];
      return handleDeleteFeedback({ indices });
    }

    default:
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
          },
        ],
      };
  }
}
