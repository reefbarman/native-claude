import type { SlashCommandInfo } from "./types";

export interface MatchedSlashCommand {
  command: SlashCommandInfo;
  args: string;
  displayText: string;
}

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\n" || char === "\t";
}

function isInsideInlineCode(text: string, index: number): boolean {
  let inside = false;
  for (let i = 0; i < index; i++) {
    if (text[i] === "`") {
      inside = !inside;
    }
  }
  return inside;
}

function findSlashCommandStart(text: string): number {
  const trimmedEnd = text.trimEnd();
  if (!trimmedEnd) {
    return -1;
  }

  for (let i = 0; i < trimmedEnd.length; i++) {
    if (trimmedEnd[i] !== "/") {
      continue;
    }
    if (trimmedEnd[i + 1] === "/") {
      continue;
    }
    if (!isWhitespace(trimmedEnd[i - 1])) {
      continue;
    }
    if (isInsideInlineCode(trimmedEnd, i)) {
      continue;
    }
    return i;
  }

  return -1;
}

export function shouldOpenSlashPopup(
  text: string,
  slashIndex: number,
): boolean {
  if (slashIndex < 0 || text[slashIndex] !== "/") {
    return false;
  }
  if (text[slashIndex + 1] === "/") {
    return false;
  }
  if (!isWhitespace(text[slashIndex - 1])) {
    return false;
  }
  return !isInsideInlineCode(text, slashIndex);
}

export function parseMatchedSlashCommand(
  text: string,
  slashCommands: readonly SlashCommandInfo[],
): MatchedSlashCommand | null {
  const slashStart = findSlashCommandStart(text);
  if (slashStart < 0) {
    return null;
  }

  const slashText = text.slice(slashStart).trim();
  if (!slashText.startsWith("/")) {
    return null;
  }

  const firstWhitespace = slashText.search(/\s/);
  const name =
    firstWhitespace >= 0
      ? slashText.slice(1, firstWhitespace)
      : slashText.slice(1);
  if (!name) {
    return null;
  }

  const command = slashCommands.find((candidate) => candidate.name === name);
  if (!command) {
    return null;
  }

  const args =
    firstWhitespace >= 0 ? slashText.slice(firstWhitespace).trim() : "";
  return {
    command,
    args,
    displayText: args ? `/${name} ${args}` : `/${name}`,
  };
}

export function getSlashCommandSelectionState(
  text: string,
  slashStart: number,
  commandName: string,
): { args: string; replacementText: string } {
  const before = slashStart >= 0 ? text.slice(0, slashStart) : "";
  const activeSlashText = slashStart >= 0 ? text.slice(slashStart) : text;
  const firstWhitespace = activeSlashText.search(/\s/);
  const suffix =
    firstWhitespace >= 0 ? activeSlashText.slice(firstWhitespace) : "";

  return {
    args: suffix.trim(),
    replacementText: `${before}/${commandName}${suffix || " "}`,
  };
}

export function wrapTextInBackticks(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }

  const leadingWhitespace = text.match(/^\s*/)?.[0].length ?? 0;
  const start = leadingWhitespace;
  const end = start + trimmed.length;
  return `${text.slice(0, start)}\`${trimmed}\`${text.slice(end)}`;
}
