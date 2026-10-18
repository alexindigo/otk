// SPDX-License-Identifier: LGPL-3.0-only
import { fileLanguage } from "./language.ts";
import type {
  Diagnostic,
  FileDiff,
  FileToolCall,
  ToolBase,
} from "@otk/protocol";
import { parseDiff } from "@otk/content";
import type { RawPart } from "./types.ts";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
export function mapDiagnostics(value: unknown, path: string): Diagnostic[] {
  const dict = record(value),
    rows = dict[path] ?? dict[path.replaceAll("\\", "/")];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((value) => {
    const diagnostic = record(value),
      start = record(record(diagnostic.range).start);
    if (
      typeof diagnostic.message !== "string" ||
      typeof start.line !== "number" || typeof start.character !== "number"
    ) return [];
    const severity: Diagnostic["severity"] = diagnostic.severity === 1
      ? "error"
      : diagnostic.severity === 2
      ? "warning"
      : diagnostic.severity === 4
      ? "hint"
      : "info";
    return [{
      severity,
      line: start.line + 1,
      col: start.character + 1,
      message: diagnostic.message,
    }];
  });
}
export function mapFileTool(
  part: RawPart,
  base: ToolBase,
): FileToolCall | undefined {
  const input = part.state!.input,
    metadata = part.state!.metadata ?? {},
    path = text(input.filePath);
  if (part.tool === "edit") {
    return {
      ...base,
      tool: "edit",
      path,
      files: text(metadata.diff)
        ? parseDiff(text(metadata.diff)).map((file) => ({ ...file, path }))
        : [],
      diagnostics: mapDiagnostics(metadata.diagnostics, path),
    };
  }
  if (part.tool === "write") {
    return {
      ...base,
      tool: "write",
      path,
      content: text(input.content),
      lang: fileLanguage(path),
      diagnostics: mapDiagnostics(metadata.diagnostics, path),
    };
  }
  if (part.tool === "apply_patch") {
    return {
      ...base,
      tool: "patch",
      files: Array.isArray(metadata.files)
        ? metadata.files.flatMap((value) => {
          const file = record(value),
            source = text(file.filePath),
            destination = text(file.movePath) || source;
          const status: FileDiff["status"] = file.type === "add"
            ? "added"
            : file.type === "delete"
            ? "deleted"
            : file.type === "move"
            ? "moved"
            : "modified";
          return text(file.patch)
            ? parseDiff(text(file.patch)).map((diff) => ({
              ...diff,
              path: destination,
              oldPath: status === "moved" ? source : undefined,
              status,
              diagnostics: mapDiagnostics(metadata.diagnostics, destination),
            }))
            : [];
        })
        : [],
    };
  }
}
