// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptPart } from "./rpc.ts";
export interface HistoryEntry {
  input: string;
  mode: "normal" | "shell";
  parts: PromptPart[];
  time: number;
}
export function sameParts(a: PromptPart[], b: PromptPart[]): boolean {
  return a.length === b.length && a.every((part, i) => {
    const other = b[i];
    if (part.kind === "text") {
      return other.kind === "text" && part.text === other.text;
    }
    if (part.kind === "agent") {
      return other.kind === "agent" && part.name === other.name;
    }
    if (other.kind !== "file") return false;
    if (part.source === "upload") {
      return other.source === "upload" && part.name === other.name &&
        part.mime === other.mime && part.dataBase64 === other.dataBase64;
    }
    if (part.source === "resource") {
      return other.source === "resource" && part.name === other.name &&
        part.mime === other.mime && part.uri === other.uri &&
        part.server === other.server;
    }
    if (part.source === "history") {
      return other.source === "history" && part.sidecarID === other.sidecarID &&
        part.messageID === other.messageID && part.partID === other.partID;
    }
    return other.source === "path" && part.path === other.path &&
      part.range?.start === other.range?.start &&
      part.range?.end === other.range?.end;
  });
}
export function sameHistory(
  a: Pick<HistoryEntry, "input" | "mode" | "parts"> | undefined,
  b: Pick<HistoryEntry, "input" | "mode" | "parts">,
): boolean {
  return !!a && a.input === b.input && a.mode === b.mode &&
    sameParts(a.parts, b.parts);
}
export function mergeHistory(groups: HistoryEntry[][]): HistoryEntry[] {
  const result: HistoryEntry[] = [];
  for (const entry of groups.flat().sort((a, b) => b.time - a.time)) {
    if (!sameHistory(result.at(-1), entry)) result.push(entry);
  }
  return result.slice(0, 50);
}
