// SPDX-License-Identifier: LGPL-3.0-only
import type { ToolResult } from "@otk/protocol";
/** Characterized stock 2.2.6 model wrappers. Incomplete shapes stay verbatim. */
export function toolResult(
  name: string,
  output: string | undefined,
  truncated: boolean,
): ToolResult | undefined {
  if (output === undefined) return;
  const lines = output.split("\n");
  if (name === "read") {
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
        paths,
        offset: start,
        total: cut ? undefined : end,
        truncated: cut,
      };
    }
  }
  if (name === "grep") {
    if (output === "No matches found") {
      return { kind: "matches", matches: [], truncated: false };
    }
    const header = /^Found (\d+) matches$/.exec(lines[0]);
    if (header) {
      let path: string | undefined, cut = truncated;
      const matches: { path: string; line: number; text: string }[] = [];
      for (const line of lines.slice(1)) {
        if (!line) continue;
        if (/^\(Results are truncated:/.test(line)) {
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
  return { kind: "text", text: output };
}
