// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ContentSession,
  FileDiff,
  Message,
  Part,
  PermissionRequest,
} from "@otk/protocol";
import type { SessionMetadata } from "@otk/protocol";
import { markdown, parseDiff } from "@otk/content";
import { mapTool } from "./map-tools.ts";
import { isPrompt, nativeSource, recordPart } from "./records.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import type {
  Info,
  RawDiff,
  RawPart,
  RawPermission,
  Session,
} from "./types.ts";
export function mapSession(session: Session): ContentSession {
  return {
    id: ids.encode(session.id),
    parentID: session.parentID == null
      ? undefined
      : ids.encode(session.parentID),
    projectID: session.projectID,
    directory: session.directory,
    title: session.title,
    time: { created: session.time.created, updated: session.time.updated },
    archived: session.time.archived !== undefined,
  };
}
export function mapIndex(session: Session): SessionMetadata {
  return {
    id: ids.encode(session.id),
    parentID: session.parentID == null
      ? undefined
      : ids.encode(session.parentID),
    projectID: session.projectID,
    directory: session.directory,
    title: session.title,
    timeCreated: session.time.created,
    timeUpdated: session.time.updated,
    archived: session.time.archived !== undefined,
    status: "idle",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
}
import { reportedNumber, reportedTokens } from "./usage-values.ts";
/** Native termination evidence is separate from endpoint availability. */
export function assistantSettled(
  info: Pick<Info, "time" | "error" | "finish">,
): boolean {
  return info.time.completed !== undefined || !!info.error ||
    !!info.finish && !["tool-calls", "unknown"].includes(info.finish);
}
export function mapMessage(
  info: Info,
  parts: RawPart[] = [],
  observed?: number,
  partMapper: (part: RawPart) => Part = mapPart,
  evidence: readonly RawPart[] = parts,
): Message {
  const mappedParts = parts.map((part) => partMapper(part));
  const common = {
    id: info.id,
    sessionID: ids.encode(info.sessionID),
    parts: mappedParts,
    source: nativeSource(
      "message",
      info,
      mappedParts.flatMap((part) => {
        const source = "source" in part ? part.source : undefined;
        return source?.payload !== undefined &&
            ["opencode-v1/text", "opencode-v1/reasoning"].includes(source.kind)
          ? [source.payload]
          : [];
      }).join("\n"),
    ),
  };
  if (info.role === "user") {
    if (!isPrompt(info, evidence)) {
      return {
        ...common,
        role: "context",
        time: { created: info.time.created },
      };
    }
    return {
      ...common,
      role: "user",
      agent: info.agent ?? undefined,
      time: { created: info.time.created },
      model: info.model
        ? { provider: info.model.providerID, model: info.model.modelID }
        : undefined,
      variant: info.model?.variant ?? undefined,
    };
  }
  if (info.summary === true) {
    const summaryParts = parts.some((part) => part.type === "text")
      ? parts
      : [...parts, {
        id: `${info.id}:summary`,
        sessionID: info.sessionID,
        messageID: info.id,
        type: "text",
        text: info.error?.data.message ?? "",
      }];
    common.parts = summaryParts.map((part) => {
      if (part.type !== "text") return partMapper(part);
      const row = recordPart(part);
      const state = info.error
        ? "failed"
        : info.time.completed === undefined
        ? "running"
        : "completed";
      row.activity = {
        kindLabel: "compaction",
        layout: "boundary",
        category: "compaction",
        // The running summary is active work: it carries its own progress.
        state: {
          key: state,
          label: state,
          facts: {
            active: state === "running",
            terminal: state !== "running",
          },
        },
        title: info.error
          ? "Session compaction failed"
          : info.time.completed === undefined
          ? "Session compaction"
          : "Session compacted",
        tone: info.error ? "error" : "normal",
        body: markdown(part.text ?? ""),
        parameters: [
          { key: "state", label: "State", value: state },
          { key: "summary", label: "Summary message", value: info.id },
          ...(info.parentID
            ? [{
              key: "marker",
              label: "Compaction message",
              value: info.parentID,
            }]
            : []),
        ],
      };
      row.name = "opencode-v1/compaction-summary";
      return row;
    });
    return { ...common, role: "context", time: { created: info.time.created } };
  }
  if (info.error?.name === "MessageAbortedError") {
    common.parts.push({
      kind: "external",
      id: `${info.id}:interrupted`,
      name: "opencode-v1/interrupted",
      source: nativeSource("interrupted", info),
      activity: {
        kindLabel: "interruption",
        layout: "boundary",
        category: "record",
        title: "Interrupted",
        tone: "error",
        body: markdown(info.error.data.message ?? info.error.name),
      },
    });
  }
  const ends = parts.flatMap((part) =>
    part.type === "text" || part.type === "reasoning"
      ? [part.time?.end || 0]
      : part.type === "tool"
      ? [part.state?.time?.end || 0]
      : []
  ).filter((end) => end > 0);
  const recorded = ends.length
    ? ends.reduce((latest, end) => Math.max(latest, end), 0)
    : undefined;
  return {
    ...common,
    role: "assistant",
    ...(info.time.completed === undefined && assistantSettled(info)
      ? { terminal: true }
      : {}),
    agent: info.agent,
    replyTo: info.parentID ?? undefined,
    time: {
      created: info.time.created,
      completed: info.time.completed,
      lastOutput: info.time.completed !== undefined
        ? recorded ?? observed ?? info.time.completed
        : observed ?? recorded ?? info.time.created,
    },
    model: { provider: info.providerID!, model: info.modelID! },
    tokens: reportedTokens(info.tokens),
    cost: reportedNumber(info.cost, false),
    interrupted: info.error?.name === "MessageAbortedError",
    error: info.error
      ? {
        kind: info.error.name,
        message: info.error.data.message || info.error.name,
      }
      : undefined,
  };
}
export function mapPart(part: RawPart): Part {
  part = { ...part };
  // Non-image uploads retain their existing on-intent attachment reference,
  // not a second embedded byte copy in transcript metadata.
  const raw = part.type === "file" && !part.mime?.startsWith("image/") &&
      part.url?.startsWith("data:")
    ? {
      ...part,
      url: undefined,
      attachment: {
        sessionID: ids.encode(part.sessionID),
        messageID: part.messageID,
        partID: part.id,
      },
    }
    : part;
  return Object.assign(mapTypedPart(part), {
    source: nativeSource(
      part.type,
      raw,
      part.type === "text" || part.type === "reasoning" ? part.text : undefined,
    ),
  });
}
function mapTypedPart(part: RawPart): Part {
  const id = part.id;
  switch (part.type) {
    case "text":
      if (part.synthetic === true) return recordPart(part);
      return { ...mapStreamingShell(part), blocks: markdown(part.text || "") };
    case "reasoning":
      return {
        ...mapStreamingShell(part),
        blocks: markdown(part.text || ""),
      };
    case "tool":
      return { kind: "tool", id, call: mapTool(part) };
    case "file":
      return {
        kind: "file",
        id,
        name: part.filename || part.source?.path || "file",
        mime: part.mime!,
        url: part.mime?.startsWith("image/") ? part.url : undefined,
        path: part.source?.path ?? undefined,
        range: part.source?.range
          ? {
            start: part.source.range.start.line,
            end: part.source.range.end.line,
          }
          : undefined,
      };
    case "agent":
      return { kind: "agent", id, name: part.name! };
    case "compaction":
    case "snapshot":
    case "patch":
    case "step-start":
    case "step-finish":
    default:
      return recordPart(part);
  }
}
/** Identity/time metadata only; the stream producer owns text parsing. */
export function mapStreamingShell(
  part: RawPart,
): Extract<Part, { kind: "text" | "reasoning" }> {
  if (part.type === "text") {
    return {
      kind: "text",
      id: part.id,
      blocks: [],
      synthetic: part.synthetic ?? false,
    };
  }
  if (part.type !== "reasoning") throw new Error("Not a streaming text part");
  return {
    kind: "reasoning",
    id: part.id,
    blocks: [],
    time: { start: part.time!.start, end: part.time?.end },
    title: typeof part.metadata?.title === "string"
      ? part.metadata.title
      : undefined,
  };
}
export function mapDiffs(diffs: RawDiff[]): FileDiff[] {
  return diffs.flatMap((diff) => {
    if (diff.patch) {
      return parseDiff(diff.patch).map((file) => ({
        ...file,
        path: diff.file || file.path,
        status: diff.status || file.status,
      }));
    }
    return [{
      path: diff.file || undefined,
      status: diff.status || "unknown",
      additions: diff.additions,
      deletions: diff.deletions,
      hunks: [],
    }];
  });
}
export function mapPermission(
  request: RawPermission,
  now: number = Date.now(),
): PermissionRequest {
  const metadata = request.metadata;
  const text = (key: string) =>
    typeof metadata[key] === "string" ? metadata[key] as string : undefined;
  return {
    id: request.id,
    sessionID: ids.encode(request.sessionID),
    kind: request.permission,
    title: request.permission,
    patterns: [...request.patterns],
    toolCall: request.tool?.callID,
    alwaysPatterns: [...request.always],
    time: now,
    detail: request.permission === "bash"
      ? {
        kind: "bash",
        command: text("command") || request.patterns.join("\n"),
        cwd: text("cwd"),
      }
      : request.permission === "edit" && text("diff")
      ? { kind: "edit", files: parseDiff(text("diff")!) }
      : { kind: "generic", summary: request.patterns.join(", ") },
  };
}
