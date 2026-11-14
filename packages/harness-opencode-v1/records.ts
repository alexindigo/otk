// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ContextMessage,
  type ExternalPart,
  type NativeSource,
  referenceSources,
} from "@otk/protocol";
import { markdown } from "@otk/content";
import { HarnessError } from "@otk/harness";
import type { Info, RawPart } from "./types.ts";
import { preview } from "./previews.ts";
import type { NativeMessage } from "./messages.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import { taskEnvelope } from "./tool-results.ts";

/** Native content evidence, not a header's declared user role, establishes a prompt. */
const promptTypes = ["text", "file", "agent"] as const;
export function isPromptPart(
  part: Pick<RawPart, "type" | "synthetic">,
): boolean {
  return promptTypes.some((type) => part.type === type) &&
    (part.type !== "text" || part.synthetic !== true);
}
export function isPrompt(info: Info, parts: readonly RawPart[]): boolean {
  return info.role === "user" && parts.some(isPromptPart);
}
/** Scalar-only SQL equivalent of isPromptPart, shared by native metadata readers.
 * The unary `+` keeps the session check out of index selection, so each probe
 * searches one message's parts rather than every part of the session. */
export function promptEvidenceSQL(message = "m"): string {
  const types = promptTypes.map((type) => `'${type}'`).join(",");
  return `EXISTS (SELECT 1 FROM part prompt_part WHERE prompt_part.message_id=${message}.id AND +prompt_part.session_id=${message}.session_id AND json_valid(prompt_part.data) AND json_extract(prompt_part.data,'$.type') IN (${types}) AND (json_extract(prompt_part.data,'$.type')!='text' OR coalesce(json_extract(prompt_part.data,'$.synthetic'),0)!=1))`;
}
/** V1 owns its source reference format: the derivation origin and location. */
export interface V1SourceRef {
  origin: "message" | "record";
  id: string;
  path: string;
}
export function sourceRef(value: V1SourceRef): string {
  return "v1:" + btoa(JSON.stringify([value.origin, value.id, value.path]))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function parseSourceRef(ref: string): V1SourceRef {
  try {
    if (!ref.startsWith("v1:")) throw new Error();
    const [origin, id, path] = JSON.parse(
      atob(ref.slice(3).replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      !["message", "record"].includes(origin) || typeof id !== "string" ||
      !id || typeof path !== "string"
    ) throw new Error();
    return { origin, id, path };
  } catch {
    throw new TypeError("Invalid V1 source reference");
  }
}
const sourceFailures = {
  reference: [
    "This source reference is no longer valid",
    "Reload the conversation, then open Source again",
  ],
  record: [
    "The retained record no longer exists",
    "This record's source is no longer available",
  ],
  message: [
    "The native message for this record no longer exists",
    "This record's source is no longer available",
  ],
  item: [
    "The native message no longer contains this record",
    "This record's source is no longer available",
  ],
  unreachable: ["opencode is not reachable", "Retry"],
  read: ["opencode could not return the native message", "Retry"],
} as const;
/** V1 says why a Source read failed, in words a person can act on. */
export function sourceFailure(kind: keyof typeof sourceFailures): HarnessError {
  const [reason, recovery] = sourceFailures[kind];
  return new HarnessError(`source.${kind}`, reason, { reason, recovery });
}
/** A loaded copy of a retained record; the retained value keeps its source. */
export function recordReference<T extends ContextMessage>(message: T): T {
  return referenceSources(
    structuredClone(message),
    (path) => sourceRef({ origin: "record", id: message.id, path }),
  );
}
export function nativeSource(
  kind: string,
  raw: unknown,
  payload?: string,
): NativeSource {
  const value = preview(raw);
  const text = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "";
  return {
    kind: `opencode-v1/${kind}`,
    preview: value.text,
    bytes: new TextEncoder().encode(text).length,
    truncated: value.truncated,
    payload: payload ?? text,
  };
}
export function recordPart(part: RawPart): ExternalPart {
  const source = nativeSource(
    part.type,
    part,
    part.type === "text" || part.type === "reasoning" ? part.text : undefined,
  );
  const common = {
    kind: "external" as const,
    id: part.id,
    name: `opencode-v1/${part.type}`,
    data: source.preview,
    source,
    // Native text is the record's message content; other kinds are bookkeeping.
    ...(part.type === "text" || part.type === "reasoning"
      ? { content: true }
      : {}),
  };
  const parameters = Object.entries(part).filter(([key]) =>
    !["id", "sessionID", "messageID", "type", "text"].includes(key)
  ).map(([key, value]) => ({
    key,
    label: key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
  const activity: ExternalPart["activity"] = {
    kindLabel: part.type,
    layout: "row",
    category: "record",
    tone: "normal",
    title: part.type,
    parameters,
  };
  switch (part.type) {
    case "text":
      {
        const task = part.synthetic ? taskEnvelope(part.text ?? "") : undefined;
        if (task) {
          const failed = task.state === "error";
          return {
            ...common,
            activity: {
              ...activity,
              category: "delegation",
              title: failed
                ? "Task failed"
                : task.state === "running"
                ? "Task running"
                : "Task finished",
              detail: task.summary,
              tone: failed ? "error" : "normal",
              child: {
                sessionID: ids.encode(task.sessionID),
                label: "Open task",
              },
              state: {
                key: task.state,
                label: task.state,
                facts: {
                  active: task.state === "running",
                  terminal: task.state !== "running",
                },
              },
              body: markdown(task.text),
            },
          };
        }
      }
      return {
        ...common,
        activity: {
          ...activity,
          title: "Outgoing context",
          direction: "outgoing",
          category: "outgoing",
          body: markdown(part.text ?? ""),
        },
      };
    case "snapshot":
      activity.title = "Snapshot";
      activity.detail = part.snapshot;
      break;
    case "patch":
      activity.title = "Changed files";
      activity.detail = part.files?.join(", ");
      break;
    case "retry":
      activity.title = `Retry ${part.attempt ?? ""}`.trim();
      activity.tone = "error";
      activity.detail = nativeError(Reflect.get(part, "error"));
      activity.body = markdown(activity.detail ?? "");
      break;
    case "subtask":
      activity.title = "Delegate";
      activity.detail = part.description;
      activity.category = "delegation";
      activity.body = markdown(part.prompt ?? "");
      break;
    case "compaction":
      activity.title = "Session compaction";
      activity.layout = "boundary";
      activity.category = "compaction";
      break;
    case "step-start":
      activity.title = "Step started";
      break;
    case "step-finish":
      activity.title = "Step finished";
      activity.detail = part.reason;
      break;
  }
  return { ...common, activity };
}

export function nativeError(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return;
  const message = Reflect.get(value, "message");
  if (typeof message === "string") return message;
  return nativeError(Reflect.get(value, "data"));
}

/** Request copy is V1-owned and accepts both raw asks and normalized inventories. */
function requestSummary(
  permission: boolean,
  request?: Record<string, unknown>,
): string {
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value : undefined;
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (!permission) {
    const questions = Array.isArray(request?.questions)
      ? request.questions
      : [request];
    const summaries = questions.map((value) => {
      const question = object(value);
      return [
        ...new Set(
          [text(question.header), text(question.question)].filter(Boolean),
        ),
      ].join(": ");
    }).filter(Boolean);
    return summaries.join("; ") || "Question";
  }
  const metadata = object(request?.metadata), detail = object(request?.detail);
  const tool = text(request?.permission) ?? text(request?.kind) ??
    text(request?.title);
  const patterns = Array.isArray(request?.patterns)
    ? request.patterns.map(text).filter(Boolean).join(", ")
    : undefined;
  const target = text(metadata.command) ?? text(detail.command) ??
    text(metadata.path) ?? text(metadata.filePath) ?? text(patterns) ??
    text(detail.summary);
  return target
    ? tool ? `${tool}: ${target}` : target
    : tool ?? "Permission request";
}

/** V1 event records remain plugin-owned, including outcome keys and copy. */
export function eventRecord(
  sessionID: string,
  id: string,
  created: number,
  type: string,
  data: Record<string, unknown>,
  request?: Record<string, unknown>,
): ContextMessage {
  const permission = type.startsWith("permission.");
  const retry = type === "session.retry";
  const rejected = type === "question.rejected" || data.reply === "reject";
  const title = retry
    ? `Retry ${String(data.attempt ?? "")}`.trim()
    : permission
    ? rejected ? "Permission rejected" : "Permission answered"
    : rejected
    ? "Question cancelled"
    : "Question answered";
  const action = data.action && typeof data.action === "object"
    ? data.action as Record<string, unknown>
    : undefined;
  const body = [
    typeof data.message === "string" ? data.message : "",
    action && typeof action.message === "string" ? action.message : "",
  ].filter(Boolean).join("\n\n");
  const parameters = Object.entries(data).filter(([key]) => key !== "sessionID")
    .map(([key, value]) => ({
      key,
      label: key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));
  const source = nativeSource(type, { data, request });
  const blocks = markdown(body);
  if (action && typeof action.link === "string") {
    blocks.push({
      b: "paragraph",
      inline: [{
        i: "link",
        href: action.link,
        inline: [{
          i: "text",
          text: typeof action.label === "string" ? action.label : action.link,
        }],
      }],
    });
  }
  return {
    id,
    sessionID: ids.encode(sessionID),
    role: "context",
    time: { created },
    source,
    parts: [{
      kind: "external",
      id: `${id}:record`,
      name: `opencode-v1/${type}`,
      source,
      activity: {
        kindLabel: retry ? "retry" : permission ? "permission" : "question",
        category: "record",
        layout: "row",
        title,
        detail: retry
          ? body.split("\n")[0]
          : requestSummary(permission, request),
        tone: retry || rejected ? "error" : "normal",
        parameters,
        state: {
          key: retry ? "retry" : rejected ? "rejected" : "answered",
          label: title,
          facts: { active: false, terminal: true },
        },
        body: blocks,
      },
    }],
  };
}

/** Bounded native assembly for non-stream records. Text/reasoning streams stay
 * with StreamBuffers. Losing a seed requests the existing recovery owner. */
export class RecordProjection {
  #records = new Map<
    string,
    { session: string; info?: Info; parts: Map<string, RawPart>; bytes: number }
  >();
  #bytes = 0;
  constructor(readonly policy: { replayops: number; replaybytes: number }) {}
  #key(session: string, message: string): string {
    return JSON.stringify([session, message]);
  }
  #store(
    session: string,
    message: string,
    info?: Info,
    part?: RawPart,
    replace?: RawPart[],
  ): NativeMessage | undefined {
    const key = this.#key(session, message);
    const old = this.#records.get(key);
    const parts = replace
      ? new Map(replace.map((p) => [p.id, p]))
      : new Map(old?.parts);
    if (part) parts.set(part.id, structuredClone(part));
    const header = info ?? old?.info;
    const value = header
      ? { info: header, parts: [...parts.values()] }
      : undefined;
    const bytes =
      new TextEncoder().encode(JSON.stringify([header, [...parts.values()]]))
        .length;
    if (old) {
      this.#bytes -= old.bytes;
      this.#records.delete(key);
    }
    if (bytes <= this.policy.replaybytes) {
      this.#records.set(key, { session, info: header, parts, bytes });
      this.#bytes += bytes;
      while (
        this.#records.size > this.policy.replayops ||
        this.#bytes > this.policy.replaybytes
      ) {
        const [first, record] = this.#records.entries().next().value!;
        this.#records.delete(first);
        this.#bytes -= record.bytes;
      }
    }
    return value;
  }
  header(info: Info): NativeMessage {
    return this.#store(info.sessionID, info.id, info)!;
  }
  seed(value: NativeMessage): void {
    this.#store(
      value.info.sessionID,
      value.info.id,
      value.info,
      undefined,
      value.parts.filter((part) => this.owns(value.info, part)),
    );
  }
  owns(info: Info | undefined, part: RawPart): boolean {
    return info?.role === "user" || info?.summary === true ||
      part.synthetic === true ||
      (part.type === "text" && part.time === undefined) ||
      (part.type !== "text" && part.type !== "reasoning");
  }
  part(raw: RawPart): NativeMessage | undefined {
    const info = this.#records.get(this.#key(raw.sessionID, raw.messageID))
      ?.info;
    if (!this.owns(info, raw)) return;
    return this.#store(raw.sessionID, raw.messageID, undefined, raw);
  }
  delta(
    session: string,
    message: string,
    id: string,
    field: string,
    delta: string,
  ): RawPart | undefined {
    const raw = this.#records.get(this.#key(session, message))?.parts.get(id);
    if (
      !raw || !Object.hasOwn(raw, field) ||
      typeof Reflect.get(raw, field) !== "string"
    ) return;
    const part = { ...raw, [field]: String(Reflect.get(raw, field)) + delta };
    this.#store(session, message, undefined, part);
    return part;
  }
  get(session: string, message: string): NativeMessage | undefined {
    const row = this.#records.get(this.#key(session, message));
    return row?.info
      ? { info: row.info, parts: [...row.parts.values()] }
      : undefined;
  }
  remove(
    session: string,
    message: string,
    part?: string,
  ): NativeMessage | undefined {
    const key = this.#key(session, message), row = this.#records.get(key);
    if (!row) return;
    if (part !== undefined) {
      const parts = [...row.parts.values()].filter((p) => p.id !== part);
      return this.#store(session, message, undefined, undefined, parts);
    }
    this.#bytes -= row.bytes;
    this.#records.delete(key);
  }
  release(session?: string, cutoff?: string): void {
    for (const [key, row] of this.#records) {
      if (
        (session === undefined || row.session === session) &&
        (cutoff === undefined || (row.info?.id ?? JSON.parse(key)[1]) >= cutoff)
      ) {
        this.#bytes -= row.bytes;
        this.#records.delete(key);
      }
    }
  }
}
