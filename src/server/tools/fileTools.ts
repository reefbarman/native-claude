import { handleReadFile } from "../../tools/readFile.js";
import { handleLoadSkill } from "../../tools/loadSkill.js";
import { handleListFiles } from "../../tools/listFiles.js";
import { handleSearchFiles } from "../../tools/searchFiles.js";
import { handleGetDiagnostics } from "../../tools/getDiagnostics.js";
import {
  readFileSchema,
  loadSkillSchema,
  listFilesSchema,
  searchFilesSchema,
  getDiagnosticsSchema,
} from "../../shared/toolSchemas.js";
import type { ToolRegistrationContext } from "./types.js";

export function registerFileTools(ctx: ToolRegistrationContext): void {
  const { server, tracker, approvalManager, approvalPanel, sid, touch, desc } =
    ctx;

  server.registerTool(
    "read_file",
    {
      description: desc("read_file"),
      inputSchema: readFileSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "read_file",
      (params) => {
        touch();
        return handleReadFile(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "load_skill",
    {
      description: desc("load_skill"),
      inputSchema: loadSkillSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "load_skill",
      (params) => {
        touch();
        return handleLoadSkill(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "list_files",
    {
      description: desc("list_files"),
      inputSchema: listFilesSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "list_files",
      (params) => {
        touch();
        return handleListFiles(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.path ?? ""),
      sid,
    ),
  );

  server.registerTool(
    "search_files",
    {
      description: desc("search_files"),
      inputSchema: searchFilesSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "search_files",
      (params) => {
        touch();
        return handleSearchFiles(params, approvalManager, approvalPanel, sid());
      },
      (p) => String(p.regex ?? "").slice(0, 60),
      sid,
    ),
  );

  server.registerTool(
    "get_diagnostics",
    {
      description: desc("get_diagnostics"),
      inputSchema: getDiagnosticsSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_diagnostics",
      (params) => {
        touch();
        return handleGetDiagnostics(params);
      },
      (p) => String(p.path ?? "workspace"),
      sid,
    ),
  );
}
