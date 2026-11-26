// SPDX-License-Identifier: LGPL-3.0-only
import type { FileDiff, Hunk } from "@otk/protocol";
import type { CommandAvailability } from "./commands.ts";

export type CodeBlockSource =
  | { kind: "fence"; text: string; lang?: string; streaming?: boolean }
  | { kind: "file"; text: string; lang?: string; startLine: number }
  | { kind: "output"; text: string }
  | { kind: "command"; text: string }
  | { kind: "request"; text: string }
  | { kind: "diff"; file: FileDiff; hunk: Hunk };

export const SHELL_LANGUAGES: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "console",
]);

export function codeCopyText(source: CodeBlockSource): string {
  if (source.kind !== "diff") return source.text;
  const omit = source.file.status === "deleted" ? "add" : "del";
  return source.hunk.lines.filter((line) => line.kind !== omit)
    .map((line) => line.text).join("\n");
}

function consoleCommands(text: string): string {
  const commands: string[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    const prompt = /^\s*\$ (.*)$/.exec(line);
    if (prompt) commands.push(prompt[1]);
    else if (commands.at(-1)?.endsWith("\\")) {
      commands.push(line.replace(/^> /, ""));
    }
  }
  return commands.join("\n");
}

export function codeRunText(source: CodeBlockSource): string | undefined {
  let text: string;
  if (source.kind === "command") text = source.text;
  else if (source.kind === "fence") {
    const lang = source.lang?.toLowerCase();
    if (!lang || !SHELL_LANGUAGES.has(lang)) return undefined;
    text = lang === "console" ? consoleCommands(source.text) : source.text;
  } else return undefined;
  text = text.replace(/[\r\n]+$/, "");
  return text.trim() ? text : undefined;
}

export function codeRunAvailability(input: {
  source: CodeBlockSource;
  sessionID?: string;
  unavailable?: string;
}): CommandAvailability {
  const { source, sessionID, unavailable } = input;
  if (source.kind === "fence" && source.streaming) {
    return { available: false, reason: "This block is still being written" };
  }
  return terminalRunAvailability({
    sessionID,
    unavailable,
    noSessionReason: "This block has no session terminal",
  });
}

export function terminalRunAvailability(
  {
    sessionID,
    unavailable,
    noSessionReason = "This text has no session terminal",
  }: {
    sessionID?: string;
    unavailable?: string;
    noSessionReason?: string;
  },
): CommandAvailability {
  const reason = sessionID ? unavailable : noSessionReason;
  return reason ? { available: false, reason } : { available: true };
}
