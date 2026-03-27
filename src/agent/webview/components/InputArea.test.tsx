import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/preact";

import { InputArea } from "./InputArea";
import type { SlashCommandInfo } from "../types";

function renderInputArea(slashCommands: SlashCommandInfo[]) {
  return render(
    <InputArea
      onSend={vi.fn()}
      onStop={vi.fn()}
      streaming={false}
      thinkingEnabled={false}
      onToggleThinking={vi.fn()}
      onExportTranscript={vi.fn()}
      hasMessages={false}
      vscodeApi={{ postMessage: vi.fn() }}
      injection={null}
      onInjectionConsumed={vi.fn()}
      slashCommands={slashCommands}
    />,
  );
}

describe("InputArea slash popup", () => {
  it("keeps popup visible when exact match is a prefix of other commands", () => {
    const slashCommands: SlashCommandInfo[] = [
      {
        name: "mcp",
        description: "Open MCP picker",
        source: "builtin",
        builtin: true,
      },
      {
        name: "mcp-refresh",
        description: "Refresh MCP",
        source: "builtin",
        builtin: true,
      },
      {
        name: "mcp-status",
        description: "Show MCP status",
        source: "builtin",
        builtin: true,
      },
    ];

    const { container } = renderInputArea(slashCommands);
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    expect(input).toBeTruthy();

    input.value = "/";
    input.selectionStart = 1;
    input.selectionEnd = 1;
    fireEvent.input(input);

    input.value = "/mcp";
    input.selectionStart = 4;
    input.selectionEnd = 4;
    fireEvent.input(input);

    expect(container.querySelector(".slash-cmd-popup")).toBeTruthy();
    expect(container.querySelectorAll(".slash-cmd-option").length).toBe(3);
  });
});
