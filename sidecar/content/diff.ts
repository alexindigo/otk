// SPDX-License-Identifier: LGPL-3.0-only
import { parsePatch } from "diff";
import type { FileDiff, Hunk } from "@otk/protocol";
const path = (name: string) => name.replace(/^[ab]\//, "");
export function parseDiff(text: string): FileDiff[] {
  return parsePatch(text).map((patch): FileDiff => {
    const old = path(patch.oldFileName), next = path(patch.newFileName);
    const hunks = patch.hunks.map((h): Hunk => {
      let oldNo = h.oldStart, newNo = h.newStart;
      const lines: Hunk["lines"] = [];
      for (const line of h.lines) {
        if (line[0] === "\\") continue;
        if (line[0] === "+") {
          lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
        } else if (line[0] === "-") {
          lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
        } else {lines.push({
            kind: "context",
            text: line.slice(1),
            oldNo: oldNo++,
            newNo: newNo++,
          });}
      }
      return {
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines,
      };
    });
    return {
      path: next === "/dev/null" ? old : next,
      oldPath: old !== next && old !== "/dev/null" ? old : undefined,
      status: old === "/dev/null"
        ? "added"
        : next === "/dev/null"
        ? "deleted"
        : old !== next
        ? "moved"
        : "modified",
      additions: hunks.reduce(
        (n, h) => n + h.lines.filter((l) => l.kind === "add").length,
        0,
      ),
      deletions: hunks.reduce(
        (n, h) => n + h.lines.filter((l) => l.kind === "del").length,
        0,
      ),
      hunks,
    };
  });
}
