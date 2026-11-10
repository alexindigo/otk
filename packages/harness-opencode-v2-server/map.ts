// SPDX-License-Identifier: LGPL-3.0-only
import { markdown, parseDiff } from "@otk/content";
import { toolResult } from "./tool-results.ts";
import { stripVTControlCharacters } from "node:util";
import type {
  Message,
  Part,
  ReportedTokens,
  ToolBase,
  ToolCall,
} from "@otk/protocol";
import type { NativeMessage, NativeSession } from "./messages.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { session } from "./metadata.ts";
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
export const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
export function millis(value: unknown): number {
  return typeof value === "number"
    ? value
    : typeof value === "string"
    ? Date.parse(value) || 0
    : 0;
}
export const reported = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
export function tokens(value: unknown): ReportedTokens {
  const t = record(value), c = record(t.cache);
  const count = (v: unknown): number | null =>
    Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : null;
  return {
    input: count(t.input),
    output: count(t.output),
    reasoning: count(t.reasoning),
    cache: { read: count(c.read), write: count(c.write) },
  };
}
export function completeTokens(
  value: unknown,
): import("@otk/protocol").Tokens | undefined {
  const t = tokens(value);
  return t.input !== null && t.output !== null && t.reasoning !== null &&
      t.cache.read !== null && t.cache.write !== null
    ? {
      input: t.input,
      output: t.output,
      reasoning: t.reasoning,
      cache: { read: t.cache.read, write: t.cache.write },
    }
    : undefined;
}
export function mapSession(
  raw: NativeSession,
): import("@otk/protocol").ContentSession {
  return {
    ...session(raw),
    selection: {
      agent: raw.agent ?? undefined,
      model: raw.model
        ? { provider: raw.model.providerID, model: raw.model.id }
        : undefined,
      variant: raw.model?.variant ?? undefined,
    },
    ...(raw.revert
      ? {
        revert: {
          messageID: raw.revert.messageID,
          messageCount: 0,
          files: (raw.revert.files ?? []).map((f) => ({
            path: f.file,
            additions: f.additions,
            deletions: f.deletions,
          })),
        },
      }
      : {}),
  };
}
export function partID(
  messageID: string,
  kind: "text" | "reasoning" | "tool",
  ordinal: number | string,
): string {
  return `${messageID}:${kind}:${ordinal}`;
}
export function preview(value: unknown): string {
  return (typeof value === "string" ? value : JSON.stringify(value) ?? "")
    .slice(0, 16384);
}
export function errorText(error: unknown): string {
  const e = record(error);
  return text(e.message) ?? text(e._tag) ?? "Native operation failed";
}
type Tool = Extract<NativeMessage, { type: "assistant" }>["content"][number] & {
  type: "tool";
};
export function mapTool(tool: Tool): ToolCall {
  const state = tool.state,
    input = record(state.input),
    meta = record("metadata" in state ? state.metadata : undefined);
  const output = "content" in state
    ? state.content?.flatMap((c) => c.type === "text" ? [c.text] : []).join(
      "\n",
    )
    : undefined;
  const base: ToolBase = {
    callID: tool.id,
    sourceName: tool.name,
    status: state.status === "streaming"
      ? "pending"
      : state.status === "error" &&
          record(state.error).type === "permission.rejected"
      ? "denied"
      : state.status,
    time: {
      start: millis(tool.time.ran ?? tool.time.created),
      ...(tool.time.completed ? { end: millis(tool.time.completed) } : {}),
    },
    title: text(meta.title) ?? text(meta.description),
    error: "error" in state ? errorText(state.error) : undefined,
    output,
    outputContent: toolResult(tool.name, output, meta.truncated === true),
    ...(typeof meta.sessionID === "string"
      ? { childSessionID: ids.encode(meta.sessionID) }
      : {}),
  };
  const path = text(input.path) ?? "";
  switch (tool.name) {
    case "shell":
      return {
        ...base,
        tool: "bash",
        command: text(input.command) ?? "",
        description: text(input.description),
        cwd: text(input.workdir),
        output: stripVTControlCharacters(text(meta.output) ?? output ?? ""),
        exitCode: typeof meta.exit === "number" ? meta.exit : undefined,
      };
    case "subagent":
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
        files: mapFileDiffs(meta.files),
        diagnostics: [],
      };
    case "write":
      return {
        ...base,
        tool: "write",
        path,
        content: text(input.content) ?? "",
        diagnostics: [],
      };
    case "patch":
      return {
        ...base,
        tool: "patch",
        files: mapFileDiffs(meta.files),
      };
    case "glob":
    case "grep":
    case "list":
      return {
        ...base,
        tool: "search",
        mode: tool.name,
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
      return { ...base, tool: "websearch", query: text(input.query) ?? "" };
    case "skill":
      return { ...base, tool: "skill", name: text(input.name) ?? "" };
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
          ? input.questions.flatMap((value) => {
            const q = record(value);
            return typeof q.question === "string"
              ? [{
                text: q.question,
                options: Array.isArray(q.options)
                  ? q.options.flatMap((value) => {
                    const o = record(value);
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
        summary: base.title ?? tool.name,
        input: preview(state.input),
        metadata: preview(meta),
        output: output === undefined ? undefined : preview(output),
        outputTruncated: (output?.length ?? 0) > 16384,
        outputContent: output === undefined
          ? undefined
          : { kind: "text", text: preview(output) },
      };
  }
}
function mapFileDiffs(value: unknown): import("@otk/protocol").FileDiff[] {
  return Array.isArray(value)
    ? value.flatMap((raw) => {
      const file = record(raw);
      if (typeof file.file !== "string") return [];
      const status =
        ["added", "deleted", "modified"].includes(String(file.status))
          ? file.status as "added" | "deleted" | "modified"
          : "unknown";
      const parsed = typeof file.patch === "string"
        ? parseDiff(file.patch)
        : [];
      return parsed.length
        ? parsed.map((p) => ({ ...p, path: file.file as string, status }))
        : typeof file.additions === "number" &&
            typeof file.deletions === "number"
        ? [{
          path: file.file,
          status,
          additions: file.additions,
          deletions: file.deletions,
          hunks: [],
        }]
        : [];
    })
    : [];
}
export interface MessageContext {
  order: number;
  replyTo?: string;
  agent?: string;
  model?: { providerID: string; id: string; variant?: string };
}
/** A single snapshot mapper, also used for event terminal checkpoints. */
export function mapMessage(
  raw: NativeMessage,
  sessionID: string,
  context: MessageContext,
): Message | undefined {
  const common = {
    id: raw.id,
    sessionID,
    sourceOrder: context.order,
    time: { created: millis(raw.time.created) },
  };
  const prose = (value: string, synthetic = false): Part => ({
    kind: "text",
    id: partID(raw.id, "text", 0),
    blocks: markdown(value),
    synthetic,
  });
  if (
    raw.type === "agent-switched" || raw.type === "model-switched" ||
    raw.type === "location-switched" || raw.type === "idle"
  ) return;
  if (raw.type === "assistant") {
    const ordinals = { text: 0, reasoning: 0 };
    const parts: Part[] = [
      { kind: "step", id: `${raw.id}:start`, phase: "start" },
      ...raw.content.map((p, index): Part => {
        if (p.type === "tool") {
          return {
            kind: "tool",
            id: partID(raw.id, "tool", p.id),
            call: mapTool(p),
          };
        }
        if (p.type !== "text" && p.type !== "reasoning") {
          return {
            kind: "external",
            id: `${raw.id}:external:${index}`,
            name: text(record(p).type) ?? "content",
            data: preview(p),
          };
        }
        const id = partID(raw.id, p.type, ordinals[p.type]++);
        return p.type === "text"
          ? { kind: "text", id, synthetic: false, blocks: markdown(p.text) }
          : {
            kind: "reasoning",
            id,
            blocks: markdown(p.text),
            time: {
              start: millis(p.time?.created ?? raw.time.created),
              ...(p.time?.completed ? { end: millis(p.time.completed) } : {}),
            },
          };
      }),
    ];
    if (raw.time.completed) {
      parts.push({
        kind: "step",
        id: `${raw.id}:finish`,
        phase: "finish",
        ...(reported(raw.cost) !== null ? { cost: raw.cost } : {}),
        ...(completeTokens(raw.tokens)
          ? { tokens: completeTokens(raw.tokens) }
          : {}),
      });
    }
    return {
      ...common,
      role: "assistant",
      agent: raw.agent,
      model: { provider: raw.model.providerID, model: raw.model.id },
      replyTo: context.replyTo,
      cost: reported(raw.cost),
      tokens: tokens(raw.tokens),
      interrupted: record(raw.error).type === "aborted",
      error: raw.error
        ? {
          kind: text(record(raw.error).type) ?? "native",
          message: errorText(raw.error),
        }
        : undefined,
      time: {
        ...common.time,
        ...(raw.time.completed
          ? { completed: millis(raw.time.completed) }
          : {}),
        lastOutput: millis(
          raw.time.streamed ?? raw.time.completed ?? raw.time.created,
        ),
      },
      parts,
    };
  }
  if (raw.type === "user") {
    return {
      ...common,
      role: "user",
      agent: context.agent,
      model: context.model
        ? { provider: context.model.providerID, model: context.model.id }
        : undefined,
      variant: context.model?.variant,
      parts: [
        prose(raw.text),
        ...(raw.files ?? []).map((f, i): Part => ({
          kind: "file",
          id: `${raw.id}:file:${i}`,
          name: f.name ?? "file",
          mime: f.mime,
          url: f.mime.startsWith("image/")
            ? `data:${f.mime};base64,${f.data}`
            : undefined,
          path: f.source.type === "uri" ? f.source.uri : undefined,
        })),
        ...(raw.agents ?? []).map((a, i): Part => ({
          kind: "agent",
          id: `${raw.id}:agent:${i}`,
          name: a.name,
        })),
        ...(raw.skills ?? []).map((s, i): Part => ({
          kind: "external",
          id: `${raw.id}:skill:${i}`,
          name: "skill",
          data: s.name,
        })),
      ],
    };
  }
  if (raw.type === "shell") {
    return {
      ...common,
      role: "user",
      origin: "shell",
      parts: [{
        kind: "tool",
        id: `${raw.id}:shell`,
        call: {
          tool: "bash",
          callID: raw.shellID,
          sourceName: "shell",
          status: raw.status === "running"
            ? "running"
            : raw.status === "exited"
            ? "completed"
            : "error",
          command: raw.command,
          output: raw.output?.output ?? "",
          outputBytes: raw.output?.size,
          outputTruncated: raw.output?.truncated,
          exitCode: typeof raw.exit === "number" ? raw.exit : undefined,
          time: {
            start: common.time.created,
            end: raw.time.completed ? millis(raw.time.completed) : undefined,
          },
        },
      }],
    };
  }
  if (raw.type === "compaction") {
    return {
      ...common,
      role: "user",
      origin: "compaction",
      parts: [
        { kind: "compaction", id: `${raw.id}:compaction` },
        prose("summary" in raw ? raw.summary : errorText(raw.error), true),
      ],
    };
  }
  if (
    raw.type !== "synthetic" && raw.type !== "system" && raw.type !== "skill"
  ) {
    return {
      ...common,
      role: "user",
      origin: "external",
      parts: [{
        kind: "external",
        id: `${common.id}:external`,
        name: text(record(raw).type) ?? "message",
        data: preview(raw),
      }],
    };
  }
  return {
    ...common,
    role: "user",
    origin: raw.type,
    parts: [prose(raw.text, true)],
  };
}
