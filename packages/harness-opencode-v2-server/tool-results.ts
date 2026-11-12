// SPDX-License-Identifier: LGPL-3.0-only
import type { ToolResult } from "@otk/protocol";
import { fileLanguage } from "./language.ts";
import { join } from "@std/path";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
/** Historical model envelopes retained verbatim by stock V1 -> V2 migration. */
function legacyRead(
  output: string,
  display: Record<string, unknown>,
): ToolResult | undefined {
  if (display.type === "directory") {
    const match =
      /^<path>([^\n]+)<\/path>\n<type>directory<\/type>\n<entries>\n([\s\S]*)\n\n\((?:\d+ entries|Showing \d+ of \d+ entries\.[^\n]*)\)\n<\/entries>$/
        .exec(output);
    const entries = display.entries, path = display.path;
    if (
      !match || typeof path !== "string" || match[1] !== path ||
      !Array.isArray(entries) || !entries.every((v) => typeof v === "string") ||
      entries.join("\n") !== match[2] ||
      typeof display.offset !== "number" ||
      typeof display.totalEntries !== "number" ||
      typeof display.truncated !== "boolean"
    ) return;
    return {
      kind: "paths",
      paths: entries.map((v: string) => `${path.replace(/\/$/, "")}/${v}`),
      offset: display.offset,
      total: display.totalEntries,
      truncated: display.truncated,
    };
  }
  const match =
    /^<path>([^\n]+)<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n\n\((End of file - total (\d+) lines|Showing lines (\d+)-(\d+) of (\d+)\. Use offset=\d+ to continue\.|Output capped at [^\n]+\. Showing lines (\d+)-(\d+)\. Use offset=\d+ to continue\.)\)\n<\/content>(?:\n\n<system-reminder>\n[\s\S]*\n<\/system-reminder>)?$/
      .exec(output);
  if (!match) return;
  const rows = match[2] === ""
    ? []
    : match[2].split("\n").map((r) => /^(\d+): (.*)$/.exec(r));
  if (rows.some((r) => !r)) return;
  const startLine = rows.length
      ? Number(rows[0]![1])
      : Number(display.lineStart ?? 1),
    endLine = startLine + rows.length - 1;
  if (rows.some((r, i) => Number(r![1]) !== startLine + i)) return;
  const text = rows.map((r) => r![2]).join("\n"),
    totalLines = match[4] !== undefined
      ? Number(match[4])
      : match[7] !== undefined
      ? Number(match[7])
      : undefined;
  if (
    (display.type !== undefined && display.type !== "file") ||
    (display.text !== undefined && display.text !== text) ||
    (display.path !== undefined && display.path !== match[1]) ||
    (display.lineStart !== undefined && display.lineStart !== startLine) ||
    (display.lineEnd !== undefined && display.lineEnd !== endLine) ||
    (totalLines !== undefined && display.totalLines !== undefined &&
      totalLines !== display.totalLines)
  ) return;
  if (
    match[5] !== undefined &&
      (Number(match[5]) !== startLine || Number(match[6]) !== endLine) ||
    match[8] !== undefined &&
      (Number(match[8]) !== startLine || Number(match[9]) !== endLine)
  ) return;
  return {
    kind: "file",
    text,
    lang: fileLanguage(match[1]),
    startLine,
    endLine,
    totalLines,
    truncated: match[4] === undefined,
  };
}
/** Characterized stock 2.2.6 model wrappers. Incomplete shapes stay verbatim. */
export function toolResult(
  name: string,
  output: string | undefined,
  truncated: boolean,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
): ToolResult | undefined {
  if (output === undefined) return;
  const lines = output.split("\n");
  if (name === "read") {
    const legacy = legacyRead(output, record(metadata.display));
    if (legacy) return legacy;
    const file = /^Read file .+, (?:lines (\d+)-(\d+)|(0) lines)$/.exec(
      lines[0],
    );
    if (file) {
      const start = file[1] ? Number(file[1]) : 1,
        end = file[2] ? Number(file[2]) : 0,
        body: string[] = [];
      let cut = truncated;
      for (const line of lines.slice(1)) {
        if (
          /^\[Output truncated\. Continue reading with offset: \d+\]$/.test(
            line,
          )
        ) {
          cut = true;
          continue;
        }
        const match = /^(\d+): (.*)$/.exec(line);
        if (!match || Number(match[1]) !== start + body.length) {
          return { kind: "text", text: output };
        }
        body.push(match[2]);
      }
      if (body.length !== (end ? end - start + 1 : 0)) {
        return { kind: "text", text: output };
      }
      return {
        kind: "file",
        text: body.join("\n"),
        lang: typeof input.path === "string"
          ? fileLanguage(input.path)
          : undefined,
        startLine: start,
        endLine: end,
        truncated: cut,
      };
    }
    const directory = /^Read directory .+, (?:entries (\d+)-(\d+)|(0) entries)$/
      .exec(lines[0]);
    if (directory) {
      let cut = truncated;
      const paths = lines.slice(1).filter((line) => {
        if (
          /^\[Output truncated\. Continue reading with offset: \d+\]$/.test(
            line,
          )
        ) {
          cut = true;
          return false;
        }
        return true;
      });
      const start = directory[1] ? Number(directory[1]) : 1,
        end = directory[2] ? Number(directory[2]) : 0;
      if (paths.length !== (end ? end - start + 1 : 0)) {
        return { kind: "text", text: output };
      }
      return {
        kind: "paths",
        paths: typeof input.path === "string"
          ? paths.map((path) =>
            join(input.path as string, path) + (path.endsWith("/") ? "/" : "")
          )
          : paths,
        offset: typeof input.offset === "number" && input.offset > 0
          ? input.offset
          : start,
        total: cut || !paths.length && Number(input.offset) > 1
          ? undefined
          : end,
        truncated: cut,
      };
    }
  }
  if (name === "glob" || name === "list") {
    let cut = truncated;
    const paths = lines.filter((line) => {
      if (/^\(Results are truncated:/.test(line)) {
        cut = true;
        return false;
      }
      return !!line && line !== "No files found";
    });
    return { kind: "paths", paths, truncated: cut };
  }
  if (name === "grep") {
    if (output === "No matches found" || output === "No files found") {
      return { kind: "matches", matches: [], truncated: false };
    }
    const header = /^Found (\d+) matches( \(more matches available\))?$/.exec(
      lines[0],
    );
    if (header) {
      let path: string | undefined, cut = truncated || !!header[2];
      const matches: { path: string; line: number; text: string }[] = [];
      for (const line of lines.slice(1)) {
        if (!line) continue;
        if (
          /^\(Results are truncated:/.test(line) ||
          line ===
            "(Results truncated. Consider using a more specific path or pattern.)"
        ) {
          cut = true;
          continue;
        }
        const row = /^ {2}Line (\d+): (.*)$/.exec(line);
        if (row && path) {
          matches.push({ path, line: Number(row[1]), text: row[2] });
          continue;
        }
        if (line.endsWith(":")) {
          path = line.slice(0, -1);
          continue;
        }
        return { kind: "text", text: output };
      }
      if (matches.length === Number(header[1])) {
        return { kind: "matches", matches, truncated: cut };
      }
    }
  }
  if (name === "task") {
    const match =
      /^<task id="[^"\n]+" state="(?:running|completed|error)">\n(?:<summary>[^\n]*<\/summary>\n)?<(task_result|task_error)>\n([\s\S]*)\n<\/\1>\n<\/task>$/
        .exec(output);
    if (match) return { kind: "text", text: match[2] };
  }
  if (name === "skill") {
    const match =
      /^<skill_content name="([^"\n]+)">\n# Skill: \1\n\n([\s\S]*)\n\nBase directory for this skill: ([^\n]+)\nRelative paths in this skill[^\n]*\nNote: file list is sampled\.\n\n<skill_files>\n([\s\S]*)\n<\/skill_files>\n<\/skill_content>$/
        .exec(output);
    if (match) {
      const paths = match[4] === ""
        ? []
        : match[4].split("\n").map((r) => /^<file>([^\n]+)<\/file>$/.exec(r));
      if (paths.every((p) => p)) {
        return {
          kind: "skill",
          text: match[2],
          directory: match[3],
          paths: paths.map((p) => p![1]),
        };
      }
    }
  }
  return { kind: "text", text: output };
}
