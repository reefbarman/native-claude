import type { ToolDefinition } from "./providers/types.js";

/**
 * Agent-internal todo tracking tool.
 * Not exposed via MCP — handled directly in the AgentEngine execution loop.
 */

// ── Types ──

export interface TodoItem {
  id: string;
  content: string;
  /** Present participle form shown when in_progress (e.g. "Running tests") */
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
  children?: TodoItem[];
}

// ── Tool definition for Claude SDK ──

export const TODO_TOOL_NAME = "todo_write";

export const todoTool: ToolDefinition = {
  name: TODO_TOOL_NAME,
  description: `Create and manage a structured task list to track your progress on complex tasks. The entire todo list is replaced each call — always include all items (completed, in-progress, and pending).

Use this when:
- A task requires 3+ distinct steps
- The user provides multiple tasks
- You need to show progress on complex work

Task rules:
- Exactly ONE task should be in_progress at a time
- Mark tasks completed IMMEDIATELY when done (don't batch)
- Use nested children to break complex tasks into sub-steps
- content: imperative form ("Run tests")
- activeForm: present continuous ("Running tests")`,
  input_schema: {
    type: "object" as const,
    properties: {
      todos: {
        type: "array",
        description: "The complete todo list (replaces previous state)",
        items: {
          $ref: "#/$defs/todoItem",
        },
      },
    },
    required: ["todos"],
    $defs: {
      todoItem: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Unique identifier for this task",
          },
          content: {
            type: "string",
            description:
              "Imperative description of the task (e.g. 'Run tests')",
          },
          activeForm: {
            type: "string",
            description:
              "Present continuous form (e.g. 'Running tests'). Shown when task is in_progress.",
          },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed"],
          },
          children: {
            type: "array",
            description: "Optional sub-tasks",
            items: { $ref: "#/$defs/todoItem" },
          },
        },
        required: ["id", "content", "activeForm", "status"],
      },
    },
  },
};

// ── Internal handler ──

export interface TodoToolInput {
  todos: TodoItem[];
}

/**
 * Handle a todo_write tool call. Returns the tool result content
 * and the parsed todo list for the webview.
 */
export function handleTodoWrite(input: TodoToolInput): {
  content: string;
  todos: TodoItem[];
} {
  const todos = Array.isArray(input.todos) ? input.todos : [];

  const counts = countTodos(todos);
  const summary = `Updated: ${counts.completed}/${counts.total} complete, ${counts.inProgress} in progress, ${counts.pending} pending`;

  return {
    content: summary,
    todos,
  };
}

function countTodos(items: TodoItem[]): {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
} {
  let total = 0;
  let completed = 0;
  let inProgress = 0;
  let pending = 0;

  for (const item of items) {
    total++;
    if (item.status === "completed") completed++;
    else if (item.status === "in_progress") inProgress++;
    else pending++;

    if (item.children?.length) {
      const sub = countTodos(item.children);
      total += sub.total;
      completed += sub.completed;
      inProgress += sub.inProgress;
      pending += sub.pending;
    }
  }

  return { total, completed, inProgress, pending };
}
