// SPDX-License-Identifier: LGPL-3.0-only
import { markdown } from "@otk/content";
import type { Message, Part, ReportedTokens } from "@otk/protocol";
import type { NativeMessage, NativeSession } from "./messages.ts";
import { session } from "./metadata.ts";
import { mapTool } from "./tool-interpretation.ts";
export {
  mapFileDiffs,
  mapTool,
  sharedToolName,
  toolTitle,
} from "./tool-interpretation.ts";
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
export interface MessageContext {
  terminal?: boolean;
  order: number;
  replyTo?: string;
  agent?: string;
  model?: { providerID: string; id: string; variant?: string };
}
/** Native termination evidence is separate from endpoint availability. */
export function assistantSettled(
  raw: { time: { completed?: unknown }; error?: unknown; finish?: unknown },
): boolean {
  return raw.time.completed != null || !!raw.error ||
    typeof raw.finish === "string" && !!raw.finish &&
      !["tool-calls", "unknown"].includes(raw.finish);
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
    if (raw.time.completed != null) {
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
    const outputs = raw.content.flatMap((p) =>
      "time" in p && p.time?.completed !== undefined
        ? [millis(p.time.completed)]
        : []
    );
    const lastRecordedOutput = outputs.length
      ? outputs.reduce((latest, time) => Math.max(latest, time), 0)
      : undefined;
    return {
      ...common,
      role: "assistant",
      ...(raw.time.completed === undefined &&
          (context.terminal === true || assistantSettled(raw))
        ? { terminal: true }
        : {}),
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
        ...(raw.time.completed != null
          ? { completed: millis(raw.time.completed) }
          : {}),
        lastOutput: millis(
          raw.time.streamed ?? lastRecordedOutput ?? raw.time.created,
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
    const summary = raw.status === "failed"
      ? errorText(raw.error)
      : raw.summary;
    return {
      ...common,
      role: "user",
      origin: "compaction",
      parts: [
        { kind: "compaction", id: `${raw.id}:compaction`, status: raw.status },
        ...(summary ? [prose(summary)] : []),
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
    // These are standalone native context messages, not hidden expansions
    // inside a real user prompt. Origin keeps them out of prompt anchors.
    parts: [prose(raw.text)],
  };
}
