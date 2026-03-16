import { describe, expect, it } from "vitest";

import type { SlashCommandInfo } from "./types";
import {
  getSlashCommandSelectionState,
  parseMatchedSlashCommand,
  shouldOpenSlashPopup,
  wrapTextInBackticks,
} from "./slashCommandInput";

const commands: SlashCommandInfo[] = [
  {
    name: "mode",
    description: "Switch mode",
    source: "builtin",
    builtin: true,
  },
  {
    name: "review",
    description: "Run review prompt",
    source: "project",
    builtin: false,
    body: "Review the current changes",
  },
];

describe("slashCommandInput", () => {
  it("matches an exact slash command with args", () => {
    expect(parseMatchedSlashCommand("/mode architect", commands)).toMatchObject(
      {
        command: commands[0],
        args: "architect",
        displayText: "/mode architect",
      },
    );
  });

  it("matches a file slash command with no args", () => {
    expect(parseMatchedSlashCommand("/review", commands)).toMatchObject({
      command: commands[1],
      args: "",
      displayText: "/review",
    });
  });

  it("matches inline slash commands outside backticks", () => {
    expect(
      parseMatchedSlashCommand("please run /review this diff", commands),
    ).toMatchObject({
      command: commands[1],
      args: "this diff",
      displayText: "/review this diff",
    });
  });

  it("does not match escaped raw slash commands wrapped in backticks", () => {
    expect(parseMatchedSlashCommand("`/mode architect`", commands)).toBeNull();
    expect(
      parseMatchedSlashCommand(
        "some text `/mode architect` more text",
        commands,
      ),
    ).toBeNull();
  });

  it("does not match bare slash, unknown commands, or double slash text", () => {
    expect(parseMatchedSlashCommand("/", commands)).toBeNull();
    expect(parseMatchedSlashCommand("/unknown arg", commands)).toBeNull();
    expect(parseMatchedSlashCommand("//mode architect", commands)).toBeNull();
  });

  it("matches with leading whitespace", () => {
    expect(parseMatchedSlashCommand("  /review args", commands)).toMatchObject({
      command: commands[1],
      args: "args",
      displayText: "/review args",
    });
  });

  it("preserves already typed args when selecting a command", () => {
    expect(getSlashCommandSelectionState("/mo architect", 0, "mode")).toEqual({
      args: "architect",
      replacementText: "/mode architect",
    });
  });

  it("adds trailing space when selecting a command with no args yet", () => {
    expect(getSlashCommandSelectionState("/mo", 0, "mode")).toEqual({
      args: "",
      replacementText: "/mode ",
    });
  });

  it("only opens the slash popup outside inline backticks", () => {
    expect(shouldOpenSlashPopup("/", 0)).toBe(true);
    expect(shouldOpenSlashPopup("some /", 5)).toBe(true);
    expect(shouldOpenSlashPopup("`/`", 1)).toBe(false);
    expect(shouldOpenSlashPopup("some `/`", 6)).toBe(false);
    expect(shouldOpenSlashPopup("word/", 4)).toBe(false);
  });

  it("wraps the current text in backticks to disable matching", () => {
    expect(wrapTextInBackticks("/mode architect")).toBe("`/mode architect`");
    expect(wrapTextInBackticks("  /mode architect  ")).toBe(
      "  `/mode architect`  ",
    );
  });
});
