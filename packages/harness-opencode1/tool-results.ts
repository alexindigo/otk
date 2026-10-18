// SPDX-License-Identifier: LGPL-3.0-only
import type { ToolResult } from "@otk/protocol";
import type { RawPart } from "./types.ts";
import { fileLanguage } from "./language.ts";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

function readResult(
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
      !Array.isArray(entries) || !entries.every((entry) =>
        typeof entry === "string"
      ) || entries.join("\n") !== match[2] ||
      typeof display.offset !== "number" ||
      typeof display.totalEntries !== "number" ||
      typeof display.truncated !== "boolean"
    ) return;
    return {
      kind: "paths",
      paths: entries.map((entry: string) =>
        `${path.replace(/\/$/, "")}/${entry}`
      ),
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
    : match[2].split("\n").map((row) => /^(\d+): (.*)$/.exec(row));
  if (rows.some((row) => !row)) return;
  const startLine = rows.length
    ? Number(rows[0]![1])
    : Number(display.lineStart ?? 1);
  if (rows.some((row, index) => Number(row![1]) !== startLine + index)) return;
  const text = rows.map((row) => row![2]).join("\n");
  const endLine = startLine + rows.length - 1;
  const totalLines = match[4] !== undefined
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
    (Number(match[5]) !== startLine || Number(match[6]) !== endLine)
  ) return;
  if (
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

function grepResult(output: string): ToolResult | undefined {
  if (output === "No files found") {
    return { kind: "matches", matches: [], truncated: false };
  }
  const lines = output.replace(/\n$/, "").split("\n");
  const header = /^Found (\d+) matches( \(more matches available\))?$/.exec(
    lines.shift() ?? "",
  );
  if (!header) return;
  const matches: { path: string; line: number; text: string }[] = [];
  let path = "", matched = false, truncated = !!header[2];
  for (const [index, row] of lines.entries()) {
    if (row === "") continue;
    if (
      row ===
        "(Results truncated. Consider using a more specific path or pattern.)" &&
      index === lines.length - 1
    ) {
      truncated = true;
      continue;
    }
    const line = /^ {2}Line (\d+): (.*)$/.exec(row);
    if (line && path && Number(line[1]) > 0) {
      matches.push({ path, line: Number(line[1]), text: line[2] });
      matched = true;
      continue;
    }
    if (row.startsWith("/") && row.endsWith(":") && (!path || matched)) {
      path = row.slice(0, -1);
      matched = false;
      continue;
    }
    return;
  }
  if (matches.length !== Number(header[1]) || (path && !matched)) return;
  return { kind: "matches", matches, truncated };
}

/** Stock 1.18.34 output formats. Unrecognized output is deliberately not decoded. */
export function toolResult(part: RawPart): ToolResult | undefined {
  const output = part.state?.output;
  if (output === undefined) return;
  const metadata = part.state?.metadata ?? {};
  if (part.tool === "read") return readResult(output, record(metadata.display));
  if (part.tool === "grep") return grepResult(output);
  if (part.tool === "glob" || part.tool === "list") {
    if (output === "No files found") {
      return { kind: "paths", paths: [], truncated: false };
    }
    const parts = output.split("\n\n");
    if (parts.length > 2) return;
    const [body, note] = parts;
    const paths = body.replace(/\n$/, "").split("\n");
    if (
      !paths.length || !paths.every((path) => path.startsWith("/")) ||
      (note !== undefined &&
        !/^\(Results are truncated: showing first \d+ results\.[^\n]*\)$/.test(
          note,
        ))
    ) return;
    return { kind: "paths", paths, truncated: note !== undefined };
  }
  if (part.tool === "task") {
    const match =
      /^<task id="[^"\n]+" state="(?:running|completed|error)">\n(?:<summary>[^\n]*<\/summary>\n)?<(task_result|task_error)>\n([\s\S]*)\n<\/\1>\n<\/task>$/
        .exec(output);
    return match ? { kind: "text", text: match[2] } : undefined;
  }
  if (part.tool === "skill") {
    const match =
      /^<skill_content name="([^"\n]+)">\n# Skill: \1\n\n([\s\S]*)\n\nBase directory for this skill: ([^\n]+)\nRelative paths in this skill[^\n]*\nNote: file list is sampled\.\n\n<skill_files>\n([\s\S]*)\n<\/skill_files>\n<\/skill_content>$/
        .exec(output);
    if (!match) return;
    const rows = match[4] === "" ? [] : match[4].split("\n");
    const paths = rows.map((row) => /^<file>([^\n]+)<\/file>$/.exec(row));
    if (paths.some((path) => !path)) return;
    return {
      kind: "skill",
      text: match[2],
      directory: match[3],
      paths: paths.map((path) => path![1]),
    };
  }
  if (part.tool === "webfetch" || part.tool === "websearch") {
    return { kind: "text", text: output };
  }
}
