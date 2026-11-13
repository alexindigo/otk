// SPDX-License-Identifier: LGPL-3.0-only
import { parseDiff } from "@otk/content";
import type { FileDiff, ToolBase, ToolCall } from "@otk/protocol";
import { stripVTControlCharacters } from "node:util";
import type { NativeMessage } from "./messages.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { fileLanguage } from "./language.ts";
import { toolContent } from "./tool-results.ts";
import { nativeSource } from "./native-source.ts";

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {};
const text = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
const millis = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) || 0 : 0;
const preview = (v: unknown): string =>
  (typeof v === "string" ? v : JSON.stringify(v) ?? "").slice(0, 16384);
type Tool = Extract<NativeMessage, { type: "assistant" }>["content"][number] & {
  type: "tool";
};

/** Native versions do not determine a history's dialect: migrated calls coexist
 * with current calls. All consumers ask this owner, retaining sourceName. */
const aliases: Record<string, string> = {
  shell: "bash",
  subagent: "task",
  apply_patch: "patch",
};
export function sharedToolName(name: string): string {
  return Object.hasOwn(aliases, name) ? aliases[name] : name;
}
/** Bounded scalar inputs for usage/helper reads. No body/output is requested. */
const fields = {
  input: [
    "command",
    "description",
    "path",
    "filePath",
    "agent",
    "subagent_type",
    "sessionID",
    "task_id",
    "workdir",
    "cwd",
    "id",
    "name",
  ],
  metadata: ["title", "description", "sessionID", "sessionId"],
} as const;
export function toolScalarSQL(data: string): string {
  const project = (kind: keyof typeof fields) =>
    "json_object(" + fields[kind].map((key) =>
      `'${key}',CASE WHEN json_type(${data},'$.state.${kind}.${key}')='text' THEN ${
        key === "command"
          ? `substr(json_extract(${data},'$.state.${kind}.${key}'),1,200)`
          : `json_extract(${data},'$.state.${kind}.${key}')`
      } END`
    ).join(",") + ")";
  return `json_object('type',json_extract(${data},'$.type'),'id',json_extract(${data},'$.id'),'name',json_extract(${data},'$.name'),'state',json_object('status',json_extract(${data},'$.state.status'),'input',${
    project("input")
  },'metadata',${
    project("metadata")
  }), 'time',json_object('created',json_extract(${data},'$.time.created'),'completed',json_extract(${data},'$.time.completed')))`;
}
export function interpretTool(
  name: string,
  rawInput: unknown,
  rawMetadata: unknown,
): {
  name: string;
  sourceName: string;
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
  child: string | undefined;
  title: string | undefined;
} {
  const input = record(rawInput), metadata = record(rawMetadata);
  return {
    name: sharedToolName(name),
    sourceName: name,
    input: {
      ...input,
      path: text(input.path) ?? text(input.filePath),
      // Stock 2.2.6 documents workdir, not cwd. Keep the older cwd dialect.
      cwd: text(input.workdir) ?? text(input.cwd),
      agent: text(input.agent) ?? text(input.subagent_type),
      sessionID: text(input.sessionID) ?? text(input.task_id),
    },
    metadata,
    child: text(metadata.sessionID) ?? text(metadata.sessionId),
    title: text(metadata.title) ?? text(metadata.description) ??
      (sharedToolName(name) === "bash"
        ? text(input.command)?.slice(0, 200)
        : text(input.description)),
  };
}
export function toolTitle(
  name: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
): string | undefined {
  return interpretTool(name, input, metadata).title;
}
export function toolProgress(
  name: string,
  input: unknown,
  metadata: unknown,
  created: unknown,
) {
  const value = interpretTool(name, input, metadata);
  return {
    name: value.name,
    ...(value.title === undefined ? {} : { title: value.title }),
    startedAt: millis(created),
  };
}
export function mapTool(tool: Tool): ToolCall {
  const state = tool.state;
  const { name, input, metadata: meta, child, title } = interpretTool(
    tool.name,
    state.input,
    "metadata" in state ? state.metadata : undefined,
  );
  const output = "content" in state
    ? state.content?.flatMap((c) => c.type === "text" ? [c.text] : []).join(
      "\n",
    )
    : undefined;
  const error = "error" in state ? record(state.error) : {};
  const declined = error.type === "permission.rejected" ||
    error.type === "aborted" &&
      (error.message === "The user dismissed this question" ||
        error.message === "The user declined this tool call");
  const nested = name === "execute" && Array.isArray(meta.toolCalls)
    ? meta.toolCalls
    : [];
  const children = nested.map((value, index): ToolCall => {
    const child = record(value), failed = child.status === "error";
    return {
      tool: "external",
      callID: `${tool.id}:nested:${index}`,
      name: text(child.tool) ?? "Call",
      summary: "",
      status: failed
        ? "error"
        : child.status === "running"
        ? "running"
        : "completed",
      ...(failed
        ? {
          failure: {
            message: text(child.error) ?? text(record(child.error).message) ??
              text(meta.message) ?? output ?? "Nested call failed",
          },
        }
        : {}),
      input: preview(child.input),
      source: nativeSource("nested-tool", child),
      time: {},
    };
  });
  const processFailure = name === "bash" ? shellFailure(meta) : undefined;
  const resultFailure = processFailure ??
    (name === "execute" &&
        (meta.error === true || children.some((c) => c.failure))
      ? text(meta.message) ?? text(record(meta.error).message) ??
        children.find((c) => c.failure)?.failure?.message ?? output ??
        "Script failed"
      : undefined);
  const base: ToolBase = {
    callID: tool.id,
    source: nativeSource("tool", tool),
    ...(resultFailure ? { failure: { message: resultFailure } } : {}),
    ...(children.length ? { children } : {}),
    sourceName: tool.name,
    status: state.status === "streaming"
      ? "pending"
      : state.status === "error" && declined
      ? "denied"
      : state.status,
    title,
    time: {
      start: millis(tool.time.ran ?? tool.time.created),
      ...(tool.time.completed ? { end: millis(tool.time.completed) } : {}),
    },
    error: "error" in state
      ? text(error.message) ?? text(error._tag) ?? "Native operation failed"
      : undefined,
    output,
    outputContent: toolContent(
      name,
      "content" in state ? state.content : undefined,
      input,
      meta,
    ),
    ...(child ? { childSessionID: ids.encode(child) } : {}),
  };
  const path = text(input.path) ?? "";
  switch (name) {
    case "bash":
      return {
        ...base,
        tool: "bash",
        command: text(input.command) ?? "",
        description: text(input.description),
        cwd: text(input.cwd),
        output: stripVTControlCharacters(text(meta.output) ?? output ?? ""),
        exitCode: typeof meta.exit === "number" ? meta.exit : undefined,
      };
    case "task":
      return {
        ...base,
        tool: "task",
        agent: text(input.agent),
        description: text(input.description) ?? "",
        duration: base.time.end !== undefined && base.time.start !== undefined
          ? base.time.end - base.time.start
          : undefined,
      };
    case "read":
      if (base.outputContent?.kind === "paths") {
        return {
          ...base,
          tool: "search",
          mode: "list",
          path,
          matches: base.outputContent.truncated
            ? undefined
            : base.outputContent.total ?? base.outputContent.paths.length,
        };
      }
      if (record(meta.display).type === "directory") {
        return {
          ...base,
          tool: "search",
          mode: "list",
          path,
          matches: typeof record(meta.display).totalEntries === "number"
            ? record(meta.display).totalEntries as number
            : undefined,
        };
      }
      return {
        ...base,
        tool: "read",
        path,
        offset: typeof input.offset === "number" ? input.offset : undefined,
        limit: typeof input.limit === "number" ? input.limit : undefined,
        loaded: Array.isArray(meta.loaded)
          ? meta.loaded.filter((v): v is string => typeof v === "string")
          : [],
      };
    case "edit":
      return {
        ...base,
        tool: "edit",
        path,
        files: mapFileDiffs(
          meta.files ??
            (typeof meta.diff === "string"
              ? [{ file: path, patch: meta.diff, status: "modified" }]
              : undefined),
        ),
        diagnostics: [],
      };
    case "write":
      return {
        ...base,
        tool: "write",
        path,
        content: text(input.content) ?? "",
        lang: fileLanguage(path),
        diagnostics: [],
      };
    case "patch":
      return {
        ...base,
        tool: "patch",
        files: mapFileDiffs(meta.files, text(input.patchText)),
      };
    case "glob":
    case "grep":
    case "list":
      return {
        ...base,
        tool: "search",
        mode: name,
        path: text(input.path),
        pattern: text(input.pattern),
        matches: typeof meta.matches === "number"
          ? meta.matches
          : typeof meta.count === "number"
          ? meta.count
          : undefined,
      };
    case "webfetch":
      return {
        ...base,
        tool: "fetch",
        url: text(input.url) ?? "",
        format: text(input.format),
      };
    case "websearch":
      return {
        ...base,
        tool: "websearch",
        query: text(input.query) ?? "",
        provider: text(input.provider),
      };
    case "skill":
      return {
        ...base,
        tool: "skill",
        name: text(input.id) ?? text(input.name) ?? "",
      };
    case "todowrite":
      return {
        ...base,
        tool: "todo",
        items: Array.isArray(input.todos)
          ? input.todos.flatMap((v) => {
            const t = record(v);
            return typeof t.content === "string" &&
                ["pending", "in_progress", "completed", "cancelled"].includes(
                  String(t.status),
                )
              ? [{
                content: t.content,
                status: t.status as import("@otk/protocol").Todo["status"],
                priority: text(t.priority),
              }]
              : [];
          })
          : [],
      };
    case "question":
      return {
        ...base,
        tool: "question",
        questions: Array.isArray(input.questions)
          ? input.questions.flatMap((value, index) => {
            const q = record(value),
              answer = Array.isArray(meta.answers)
                ? meta.answers[index]
                : undefined;
            return typeof q.question === "string"
              ? [{
                text: q.question,
                ...(Array.isArray(answer) &&
                    answer.every((v) => typeof v === "string")
                  ? { answer: [...answer] }
                  : {}),
                options: Array.isArray(q.options)
                  ? q.options.flatMap((v) => {
                    const o = record(v);
                    return typeof o.label === "string"
                      ? [{
                        label: o.label,
                        description: text(o.description) ?? "",
                      }]
                      : [];
                  })
                  : [],
              }]
              : [];
          })
          : [],
      };
    default:
      return {
        ...base,
        tool: "external",
        name: tool.name,
        summary: base.title ?? "",
        input: preview(state.input),
        metadata: preview(meta),
        output: output === undefined ? undefined : preview(output),
        outputTruncated: (output?.length ?? 0) > 16384,
        outputContent: base.outputContent,
      };
  }
}
export function shellFailure(
  meta: Record<string, unknown>,
): string | undefined {
  if (meta.timeout === true || meta.status === "timeout") {
    return "Command timed out";
  }
  if (typeof meta.signal === "string") return `Killed by ${meta.signal}`;
  if (meta.status === "killed" || meta.state === "cancelled") {
    return "Command cancelled";
  }
  if (typeof meta.exit === "number" && meta.exit !== 0) {
    return `Exited with code ${meta.exit}`;
  }
}
export function mapFileDiffs(value: unknown, patchText?: string): FileDiff[] {
  const moves = new Map<string, string>();
  let source: string | undefined;
  for (const line of patchText?.split("\n") ?? []) {
    if (line.startsWith("*** Update File: ")) source = line.slice(17);
    else if (line.startsWith("*** Move to: ") && source) {
      moves.set(line.slice(13), source);
    } else if (line.startsWith("*** ")) source = undefined;
  }
  return Array.isArray(value)
    ? value.flatMap((raw): FileDiff[] => {
      const file = record(raw), path = text(file.file) ?? text(file.filePath);
      if (path === undefined) return [];
      const legacy: Record<string, FileDiff["status"]> = {
        add: "added",
        delete: "deleted",
        update: "modified",
        move: "moved",
      };
      const status =
        ["added", "deleted", "modified", "moved"].includes(String(file.status))
          ? file.status as FileDiff["status"]
          : Object.hasOwn(legacy, String(file.type))
          ? legacy[String(file.type)]
          : "unknown";
      const parsed = typeof file.patch === "string"
        ? parseDiff(file.patch)
        : [];
      const moved = [...moves].find(([target]) =>
        path === target || path.endsWith("/" + target)
      );
      const oldPath = moved
        ? path.slice(0, -moved[0].length) + moved[1]
        : text(file.movePath)
        ? path
        : undefined;
      const target = text(file.movePath) ?? path;
      return parsed.length
        ? parsed.map((p) => ({
          ...p,
          path: target,
          oldPath: oldPath ?? p.oldPath,
          status: oldPath || p.status === "moved" ? "moved" : status,
        }))
        : typeof file.additions === "number" &&
            typeof file.deletions === "number"
        ? [{
          path: target,
          status: oldPath ? "moved" : status,
          ...(oldPath ? { oldPath } : {}),
          additions: file.additions,
          deletions: file.deletions,
          hunks: [],
        }]
        : [];
    })
    : [];
}
