import type { ToolResult } from "../shared/types.js";
import { errorResult } from "../shared/types.js";
import { FileLockTimeoutError } from "../integrations/DiffViewProvider.js";

export function handlePendingEditLockError(
  err: unknown,
  toolPath: string,
): ToolResult | null {
  if (!(err instanceof FileLockTimeoutError)) {
    return null;
  }

  return errorResult("Another edit to this file is still pending approval", {
    path: toolPath,
    reason: err.code,
    hint: "Wait for the existing diff/write approval to finish, or use the sidebar Tool Calls panel to complete or cancel the pending edit before retrying.",
    details: err.message,
  });
}
