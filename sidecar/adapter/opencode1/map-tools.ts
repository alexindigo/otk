// SPDX-License-Identifier: LGPL-3.0-only
import type { Todo, ToolBase, ToolCall } from "../../../protocol/content.ts";
import { stripVTControlCharacters } from "node:util";
import type { RawPart } from "./types.ts";
import { mapFileTool } from "./file-tools.ts";
const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
export function mapTodos(value: unknown): Todo[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
      const todo = record(item);
      if (
        typeof todo.content !== "string" ||
        !["pending", "in_progress", "completed", "cancelled"].includes(
          String(todo.status),
        )
      ) return [];
      return [{
        content: todo.content,
        status: todo.status as Todo["status"],
        priority: string(todo.priority) || "medium",
      }];
    })
    : [];
}
export function mapTool(part: RawPart, awaitingPermission = false): ToolCall {
  const state = part.state!;
  const base: ToolBase = {
    callID: part.callID!,
    status: state.status === "error" &&
        /QuestionRejectedError|rejected permission|specified a rule|user dismissed/i
          .test(state.error || "")
      ? "denied"
      : state.status,
    title: state.title,
    error: state.error,
    time: { start: state.time?.start, end: state.time?.end },
    awaitingPermission,
  };
  const input = state.input, metadata = state.metadata ?? {};
  if (part.tool === "task") {
    return {
      ...base,
      tool: "task",
      agent: string(input.subagent_type) || "general",
      description: string(input.description) || "",
      childSessionID: string(metadata.sessionId),
      toolCount: 0,
      duration: state.time?.end !== undefined && state.time.start !== undefined
        ? state.time.end - state.time.start
        : undefined,
    };
  }
  const fileTool = mapFileTool(part, base);
  if (fileTool) return fileTool;
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const display = record(metadata.display);
  if (part.tool === "read" && display.type !== "directory") {
    return {
      ...base,
      tool: "read",
      path: string(input.filePath) || "",
      offset: number(input.offset),
      limit: number(input.limit),
      loaded: strings(metadata.loaded),
    };
  }
  if (
    ["glob", "grep", "list"].includes(part.tool || "") ||
    (part.tool === "read" && display.type === "directory")
  ) {
    const mode = part.tool === "read" || part.tool === "list"
      ? "list"
      : part.tool as "glob" | "grep";
    return {
      ...base,
      tool: "search",
      mode,
      pattern: string(input.pattern) || "*",
      path: string(input.path) ||
        (mode === "list" ? string(input.filePath) : undefined),
      matches: number(
        mode === "grep"
          ? metadata.matches
          : mode === "list" && display.type === "directory"
          ? display.totalEntries
          : metadata.count,
      ) || 0,
    };
  }
  if (part.tool === "webfetch") {
    return {
      ...base,
      tool: "fetch",
      url: string(input.url) || "",
      format: string(input.format),
    };
  }
  if (part.tool === "websearch") {
    return {
      ...base,
      tool: "websearch",
      query: string(input.query) || "",
      provider: string(metadata.provider),
    };
  }
  if (part.tool === "skill") {
    return {
      ...base,
      tool: "skill",
      name: string(input.name) || string(metadata.name) || "",
    };
  }
  if (part.tool === "todowrite") {
    return {
      ...base,
      tool: "todo",
      items: mapTodos(metadata.todos ?? input.todos),
    };
  }
  if (part.tool === "question") {
    return {
      ...base,
      tool: "question",
      questions: Array.isArray(input.questions)
        ? input.questions.flatMap((item, i) => {
          const question = record(item);
          if (typeof question.question !== "string") return [];
          return [{
            text: question.question,
            options: Array.isArray(question.options)
              ? question.options.flatMap((item) => {
                const option = record(item);
                return typeof option.label === "string"
                  ? [{
                    label: option.label,
                    description: string(option.description) || "",
                  }]
                  : [];
              })
              : [],
            answer: Array.isArray(metadata.answers)
              ? strings(metadata.answers[i])
              : undefined,
          }];
        })
        : [],
    };
  }
  if (part.tool === "bash") {
    return {
      ...base,
      tool: "bash",
      command: string(input.command) || "",
      description: string(input.description),
      cwd: string(input.workdir),
      output: stripVTControlCharacters(
        string(metadata.output) ?? state.output ?? "",
      ),
      exitCode: typeof metadata.exit === "number" ? metadata.exit : undefined,
    };
  }
  const bytes = state.output === undefined
    ? undefined
    : new TextEncoder().encode(state.output);
  const outputTruncated = (bytes?.length || 0) > 65_536;
  const output = outputTruncated
    ? new TextDecoder().decode(bytes!.subarray(0, 65_536), { stream: true })
    : state.output;
  return {
    ...base,
    tool: "generic",
    name: part.tool!,
    summary:
      Object.values(input).map(string).find((v) => v?.trim())?.split("\n")[0]
        .slice(0, 256) || part.tool!,
    output,
    outputTruncated,
    childSessionID: string(metadata.sessionId),
  };
}
