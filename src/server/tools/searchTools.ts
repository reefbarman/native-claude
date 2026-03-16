import { codebaseSearchSchema } from "../../shared/toolSchemas.js";
import type { ToolRegistrationContext } from "./types.js";

export function registerSearchTools(ctx: ToolRegistrationContext): void {
  const { server, tracker, sid, touch, desc } = ctx;

  server.registerTool(
    "codebase_search",
    {
      description: desc("codebase_search"),
      inputSchema: codebaseSearchSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tracker.wrapHandler(
      "codebase_search",
      async (params) => {
        touch();
        const { semanticSearch } =
          await import("../../services/semanticSearch.js");
        const { resolveAndValidatePath, tryGetFirstWorkspaceRoot } =
          await import("../../util/paths.js");
        const dirPath = params.path
          ? resolveAndValidatePath(String(params.path)).absolutePath
          : (tryGetFirstWorkspaceRoot() ?? ".");
        return semanticSearch(
          dirPath,
          String(params.query),
          params.limit,
          params.exclude_globs,
        );
      },
      (p) => String(p.query ?? "").slice(0, 60),
      sid,
    ),
  );
}
