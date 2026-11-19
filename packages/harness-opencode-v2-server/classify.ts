// SPDX-License-Identifier: LGPL-3.0-only
import { markdown } from "@otk/content";
import type {
  Activity,
  ActivityParameter,
  ActivityState,
  Message,
  Part,
  ReportedTokens,
} from "@otk/protocol";
import type { NativeMessage, NativeSession } from "./messages.ts";
import { session } from "./metadata.ts";
import { mapTool, shellFailure } from "./tool-interpretation.ts";
import { nativeSource, sourceRef } from "./native-source.ts";
import { referenceSources } from "@otk/protocol";
import { subagentBody } from "./tool-results.ts";
import { opencodeV2SessionID as ids, optionalSessionID } from "./ids.ts";
import type { V2Event } from "./stream.ts";
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
  /** Explicit native message/step parent, never a newer prompt fallback. */
  nativeParent?: string;
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
/** Total native-record classifier. Snapshot, live, inbox and recovery use it. */
export function mapMessage(
  raw: NativeMessage,
  sessionID: string,
  context: MessageContext,
): Message {
  const common = {
    id: raw.id,
    sessionID,
    sourceOrder: context.order,
    time: { created: millis(raw.time.created) },
    source: nativeSource(raw.type, raw, "text" in raw ? raw.text : undefined),
  };
  const prose = (value: string, synthetic = false): Part => ({
    kind: "text",
    id: partID(raw.id, "text", 0),
    blocks: markdown(value),
    synthetic,
    source: nativeSource("text", { text: value }, value),
  });
  if (raw.type === "assistant") {
    const ordinals = { text: 0, reasoning: 0 };
    const parts: Part[] = [
      {
        kind: "step",
        id: `${raw.id}:start`,
        phase: "start",
        source: nativeSource("assistant", raw),
      },
      ...raw.content.map((p, index): Part => {
        if (p.type === "tool") {
          return {
            kind: "tool",
            id: partID(raw.id, "tool", p.id),
            call: mapTool(p),
            source: nativeSource("tool", p),
          };
        }
        if (p.type !== "text" && p.type !== "reasoning") {
          return {
            kind: "external",
            id: `${raw.id}:external:${index}`,
            name: text(record(p).type) ?? "content",
            data: preview(p),
            source: nativeSource(text(record(p).type) ?? "content", p),
          };
        }
        const id = partID(raw.id, p.type, ordinals[p.type]++);
        return p.type === "text"
          ? {
            kind: "text",
            id,
            synthetic: false,
            blocks: markdown(p.text),
            source: nativeSource(p.type, p, p.text),
          }
          : {
            kind: "reasoning",
            id,
            blocks: markdown(p.text),
            source: nativeSource(p.type, p, p.text),
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
        source: nativeSource("assistant", raw),
        ...(reported(raw.cost) !== null ? { cost: raw.cost } : {}),
        ...(completeTokens(raw.tokens)
          ? { tokens: completeTokens(raw.tokens) }
          : {}),
      });
    }
    if (raw.retry) {
      parts.push({
        kind: "external",
        id: `${raw.id}:retry`,
        name: "opencode-v2/active-retry",
        source: nativeSource("active-retry", raw.retry),
        activity: retryActivity(raw.retry, true),
      });
    }
    const interrupted = /abort|interrupt/i.test(
      text(record(raw.error).type) ?? "",
    );
    if (interrupted) {
      parts.push({
        kind: "external",
        id: `${raw.id}:interrupted`,
        name: "opencode-v2/interrupted",
        source: nativeSource("interrupted", raw.error),
        activity: {
          kindLabel: "Interruption",
          title: "Interrupted",
          layout: "boundary",
          category: "record",
          tone: "normal",
          body: markdown(errorText(raw.error)),
          state: {
            key: "interrupted",
            label: "Interrupted",
            facts: { active: false, terminal: true },
          },
        },
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
      source: nativeSource(
        "assistant",
        raw,
        raw.content.flatMap((p) => p.type === "text" ? [p.text] : []).join(
          "\n\n",
        ),
      ),
      agent: raw.agent,
      model: { provider: raw.model.providerID, model: raw.model.id },
      replyTo: text(record(raw.metadata).parentID) ?? context.nativeParent ??
        context.replyTo,
      cost: reported(raw.cost),
      tokens: tokens(raw.tokens),
      interrupted,
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
          source: nativeSource("file", f),
          url: f.mime.startsWith("image/")
            ? `data:${f.mime};base64,${f.data}`
            : undefined,
          path: f.source.type === "uri" ? f.source.uri : undefined,
        })),
        ...(raw.agents ?? []).map((a, i): Part => ({
          kind: "agent",
          id: `${raw.id}:agent:${i}`,
          name: a.name,
          source: nativeSource("agent", a),
        })),
        ...(raw.skills ?? []).map((s, i): Part => ({
          kind: "external",
          id: `${raw.id}:skill:${i}`,
          name: "skill",
          data: s.name,
          source: nativeSource("skill", s),
        })),
      ],
    };
  }
  if (raw.type === "shell") {
    return {
      ...common,
      role: "context",
      parts: [
        activityPart(
          raw,
          shellActivity(raw.status, raw.output?.output ?? "", {
            shellID: raw.shellID,
            command: raw.command,
            exit: raw.exit,
            size: raw.output?.size,
            truncated: raw.output?.truncated,
          }),
        ),
      ],
    };
  }
  if (raw.type === "compaction") {
    const failed = raw.status === "failed",
      running = raw.status === "running",
      error = failed ? record(raw.error) : {},
      outcome = error.type === "aborted"
        ? "cancelled"
        : error.type === "compaction.interrupted"
        ? "interrupted"
        : failed
        ? "failed"
        : running
        ? "running"
        : "completed",
      summary = failed ? errorText(raw.error) : raw.summary,
      title = running
        ? "Session compaction started"
        : outcome === "cancelled"
        ? "Session compaction cancelled"
        : outcome === "interrupted"
        ? "Session compaction interrupted"
        : failed
        ? "Session compaction failed"
        : record(Reflect.get(raw, "native")).messages
        ? "Session compacted by provider"
        : "Session compacted",
      t = !running ? record(Reflect.get(raw, "tokens")) : {},
      cache = record(t.cache),
      input = Number(t.input ?? 0) + Number(cache.read ?? 0) +
        Number(cache.write ?? 0),
      output = Number(t.output ?? 0) + Number(t.reasoning ?? 0),
      count = new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      });
    const part = activityPart(raw, {
      kindLabel: "Compaction",
      layout: "boundary",
      category: "compaction",
      title: input + output > 0
        ? `${title} - ${count.format(input)} in - ${count.format(output)} out`
        : title,
      tone: outcome === "failed" ? "error" : "normal",
      // A failure's cause stays on the row; cancellation and interruption
      // have no error card natively.
      ...(outcome === "failed" && summary ? { detail: summary } : {}),
      state: {
        key: outcome,
        label: outcome,
        facts: { active: running, terminal: !running },
      },
      parameters: parameters({
        status: raw.status,
        reason: raw.reason,
        model: Reflect.get(raw, "model"),
        error: failed ? raw.error : undefined,
        cost: Reflect.get(raw, "cost"),
        tokens: Reflect.get(raw, "tokens"),
      }),
      ...(summary ? { body: markdown(summary) } : {}),
    });
    // A summary is message content; lifecycle/error bookkeeping is not.
    if (!failed) {
      part.content = true;
      part.source = nativeSource("compaction", raw, raw.summary);
    }
    return {
      ...common,
      role: "context",
      parts: [part],
    };
  }
  if (
    raw.type === "agent-switched" || raw.type === "model-switched" ||
    raw.type === "location-switched"
  ) {
    const model = raw.type === "model-switched" ? raw.model : undefined,
      previous = raw.type === "model-switched" ? raw.previous : undefined,
      variantOnly = model && previous?.providerID === model.providerID &&
        previous?.id === model.id;
    return {
      ...common,
      role: "context",
      parts: [activityPart(raw, {
        kindLabel: "Switch",
        layout: "boundary",
        category: "record",
        tone: "normal",
        title: raw.type === "agent-switched"
          ? `Switched agent to ${raw.agent}`
          : raw.type === "location-switched"
          ? `Moved to ${raw.location.directory}`
          : variantOnly
          ? `Switched variant to ${model?.variant || "Default"}`
          : `Switched to ${model?.id}${
            model?.variant ? ` - ${model.variant}` : ""
          }`,
        parameters: parameters({
          previous: raw.previous,
          ...(raw.type === "model-switched"
            ? { model: raw.model }
            : raw.type === "agent-switched"
            ? { agent: raw.agent }
            : {
              location: raw.location,
              projectID: raw.projectID,
              subpath: raw.subpath,
            }),
        }),
      })],
    };
  }
  if (raw.type === "idle") {
    return {
      ...common,
      role: "context",
      parts: [activityPart(raw, {
        kindLabel: "Execution",
        title: `Execution ${raw.outcome}`,
        detail: raw.error ? errorText(raw.error) : undefined,
        layout: "row",
        category: "record",
        tone: raw.outcome === "failed" ? "error" : "normal",
        state: {
          key: raw.outcome,
          label: raw.outcome,
          facts: { active: false, terminal: true },
        },
        parameters: parameters({ outcome: raw.outcome }),
        ...(raw.error ? { body: markdown(errorText(raw.error)) } : {}),
      })],
    };
  }
  if (raw.type === "system") {
    return {
      ...common,
      role: "context",
      parts: [activityPart(raw, {
        kindLabel: "System",
        title: "System",
        layout: "row",
        category: "system",
        tone: "normal",
        detail: raw.description?.trim() ||
          raw.text.split(/\r?\n/).find((line) => line.trim())?.trim(),
        body: markdown(raw.text),
      })],
    };
  }
  if (raw.type === "skill") {
    return {
      ...common,
      role: "context",
      parts: [activityPart(raw, {
        kindLabel: "Skill",
        title: `Skill ${raw.name}`,
        layout: "row",
        category: "record",
        tone: "normal",
        parameters: parameters({ skill: raw.skill, name: raw.name }),
        body: markdown(raw.text),
      })],
    };
  }
  if (raw.type === "synthetic") {
    const meta = record(raw.metadata), state = text(meta.state) ?? "unknown";
    if (meta.source === "subagent") {
      const agent = text(meta.agent),
        childID = text(meta.childID),
        sessionID = optionalSessionID(childID),
        child = sessionID ? { sessionID, label: "Open task" } : undefined;
      const outcome = state === "error"
        ? "failed"
        : state === "cancelled"
        ? "cancelled"
        : "finished";
      const body = subagentBody(raw.text, childID, state, raw.description) ??
        raw.text;
      return {
        ...common,
        role: "context",
        parts: [activityPart(raw, {
          kindLabel: "Subagent result",
          entity: agent
            ? {
              label: agent[0].toUpperCase() + agent.slice(1),
              sessionID,
            }
            : undefined,
          title: `${
            agent ? agent[0].toUpperCase() + agent.slice(1) : "Subagent"
          } ${outcome}`,
          layout: "row",
          category: "delegation",
          tone: state === "error" ? "error" : "normal",
          detail: raw.description,
          state: resultState(state),
          child,
          icon: state === "error"
            ? { name: "warning", label: "Failed" }
            : undefined,
          parameters: [
            {
              key: "agent",
              label: "Agent",
              value: agent ?? "Unknown",
              entity: agent ? { label: agent, sessionID } : undefined,
            },
            { key: "state", label: "State", value: state },
            {
              key: "description",
              label: "Description",
              value: raw.description ?? "",
            },
            {
              key: "sessionID",
              label: "Session ID",
              value: childID ?? "Unknown",
              ...(child ? { child: { ...child, label: childID! } } : {}),
            },
          ],
          body: markdown(body),
        })],
      };
    }
    if (meta.source === "shell") {
      return {
        ...common,
        role: "context",
        parts: [
          activityPart(
            raw,
            shellActivity(state, raw.text, {
              ...meta,
              command: raw.description,
            }),
          ),
        ],
      };
    }
    return {
      ...common,
      role: "context",
      parts: [activityPart(raw, {
        kindLabel: "Context",
        title: raw.description?.trim() || "Context sent to model",
        layout: "row",
        category: raw.description?.trim() ? "record" : "outgoing",
        ...(!raw.description?.trim() ? { direction: "outgoing" as const } : {}),
        tone: meta.error ? "error" : "normal",
        body: markdown(raw.text),
        parameters: parameters(meta),
      })],
    };
  }
  // Future native tags stay visible through the same plugin-owned fallback.
  return {
    ...common,
    role: "context",
    parts: [activityPart(raw, {
      kindLabel: text(record(raw).type) ?? "Native record",
      title: text(record(raw).type) ?? "Native record",
      layout: "row",
      category: "record",
      tone: "normal",
      parameters: parameters({ type: record(raw).type }),
    })],
  };
}

function activityPart(
  raw: NativeMessage,
  activity: Activity,
): import("@otk/protocol").ExternalPart {
  return {
    kind: "external",
    id: `${raw.id}:record`,
    name: `opencode-v2/${raw.type}`,
    source: nativeSource(raw.type, raw, "text" in raw ? raw.text : undefined),
    // Native text is the record's message content; other kinds are bookkeeping.
    ...("text" in raw && typeof raw.text === "string" ? { content: true } : {}),
    activity,
  };
}
/** Inbox admission is not a prompt anchor for contextual payloads. Classification
 * is still mapMessage; queue presentation adds only the native admission facts. */
export function inboxMessage(
  id: string,
  item: Record<string, unknown>,
  created: number,
  sessionID: string,
  context: MessageContext,
): Message {
  return referenceSources(
    deriveInboxMessage(id, item, created, sessionID, context),
    (path) => sourceRef({ origin: "inbox", id, path }),
  );
}
export function deriveInboxMessage(
  id: string,
  item: Record<string, unknown>,
  created: number,
  sessionID: string,
  context: MessageContext,
): Message {
  const payload = record(item.payload), type = text(item.type) ?? "inbox";
  const raw = {
    ...payload,
    id,
    type: type === "move" ? "location-switched" : type,
    ...(type === "compaction"
      ? { status: "running", reason: "manual", summary: "" }
      : {}),
    time: { created },
  } as NativeMessage;
  const message = mapMessage(raw, sessionID, context);
  message.source = nativeSource(
    "inbox",
    { ...item, id, sessionID: ids.decode(sessionID), time: { created } },
    text(payload.text),
  );
  message.parts = message.parts.map((part) => {
    if (part.kind !== "external" || !part.activity) return part;
    return {
      ...part,
      ...(type === "compaction" ? { content: undefined } : {}),
      activity: {
        ...part.activity,
        ...(type === "compaction"
          ? { title: "Session compaction queued" }
          : {}),
        ...(type === "move"
          ? {
            title: `Move to ${
              text(record(payload.location).directory) ?? "location"
            }`,
          }
          : {}),
        state: {
          key: "queued",
          label: item.delivery === "steer" ? "Steered" : "Queued",
          facts: { active: false, terminal: false },
        },
        parameters: [
          ...part.activity.parameters ?? [],
          ...parameters({ delivery: item.delivery }),
        ],
      },
    };
  });
  return message;
}
function parameters(value: Record<string, unknown>): ActivityParameter[] {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).flatMap((
    [key, value],
  ) =>
    value === undefined ? [] : [{
      key,
      label: key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }]
  );
}
function retryActivity(
  retry: Record<string, unknown>,
  active: boolean,
): Activity {
  return {
    kindLabel: "Retry",
    title: `${
      active ? "Retrying" : "Retry scheduled"
    } - attempt ${retry.attempt}`,
    detail: errorText(retry.error),
    layout: "row",
    category: "record",
    tone: "error",
    state: {
      key: active ? "retrying" : "scheduled",
      label: active ? "Retrying" : "Scheduled",
      facts: { active, terminal: !active },
    },
    parameters: parameters({
      attempt: retry.attempt,
      at: retry.at,
      error: retry.error,
    }),
    body: markdown(errorText(retry.error)),
  };
}
/** Events native does not retain as messages are owned and stored by this plugin. */
export function lifecycleRecord(event: V2Event, sessionID: string): Message {
  const id = `record:${event.id}`,
    retry = event.type === "session.retry.scheduled",
    source = nativeSource(event.type, event);
  return {
    id,
    sessionID,
    role: "context",
    time: { created: event.created ?? Date.now() },
    source,
    parts: [{
      kind: "external",
      id: `${id}:record`,
      name: retry ? "opencode-v2/retry" : `opencode-v2/${event.type}`,
      source,
      activity: retry ? retryActivity(event.data, false) : {
        kindLabel: event.type,
        title: event.type,
        layout: "row",
        category: "record",
        tone: "normal",
        parameters: parameters({ event: event.type }),
      },
    }],
  };
}
function resultState(key: string): ActivityState {
  const terminal = [
    "completed",
    "error",
    "cancelled",
    "exited",
    "killed",
    "timeout",
  ].includes(key);
  return {
    key,
    label: key,
    facts: {
      active: key === "running" ? true : terminal ? false : null,
      terminal: key === "running" ? false : terminal ? true : null,
    },
  };
}
function shellActivity(
  state: string,
  output: string,
  facts: Record<string, unknown>,
): Activity {
  const cause = shellFailure({ ...facts, status: state }) ??
      (state === "error" ? "Shell failed" : undefined),
    failed = !!cause;
  return {
    kindLabel: "Shell result",
    title: cause ? `Shell: ${cause}` : "Shell",
    detail: text(facts.command),
    layout: "row",
    category: "record",
    tone: failed ? "error" : "normal",
    state: resultState(state),
    parameters: parameters({ state, ...facts }),
    body: [{ b: "code", text: output }],
  };
}
/** Ephemeral request outcomes are distinct from their associated tool result. */
export function requestOutcome(
  event: V2Event,
  sessionID: string,
  requestID: string,
  request: Record<string, unknown> | undefined,
): Message {
  const cancelled = event.type === "form.cancelled",
    permission = event.type === "permission.replied",
    state = cancelled
      ? "cancelled"
      : permission
      ? text(event.data.reply) ?? "settled"
      : "answered",
    actor = text(event.data.actor) ?? text(event.metadata?.actor),
    source = nativeSource("request-outcome", { event, request }),
    detail = text(request?.title) ?? text(request?.action),
    kindLabel = permission
      ? "Permission"
      : record(request?.metadata).kind === "question"
      ? "Question"
      : "Form";
  return {
    id: `request:${requestID}`,
    sessionID,
    role: "context",
    time: { created: event.created ?? Date.now() },
    source,
    parts: [{
      kind: "external",
      id: `request:${requestID}:outcome`,
      name: "opencode-v2/request-outcome",
      source,
      activity: {
        kindLabel,
        title: `${kindLabel} ${state}`,
        detail,
        layout: "row",
        category: "record",
        tone: "normal",
        state: {
          key: state,
          label: state,
          facts: { active: false, terminal: true },
        },
        parameters: parameters({
          requestID,
          outcome: state,
          ...(actor ? { actor } : {}),
          ...("answer" in event.data ? { answer: event.data.answer } : {}),
        }),
      },
    }],
  };
}
