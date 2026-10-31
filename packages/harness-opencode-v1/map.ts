// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ContentSession,
  FileDiff,
  Message,
  Part,
  PermissionRequest,
  Tokens,
} from "@otk/protocol";
import type { SessionMetadata } from "@otk/protocol";
import { markdown, parseDiff } from "@otk/content";
import { mapTool } from "./map-tools.ts";
import { preview } from "./previews.ts";
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
const tokens = (value?: Tokens): Tokens =>
  value
    ? {
      input: value.input,
      output: value.output,
      reasoning: value.reasoning,
      cache: { read: value.cache.read, write: value.cache.write },
    }
    : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
export function mapMessage(
  info: Info,
  parts: RawPart[] = [],
  observed?: number,
  partMapper: (part: RawPart) => Part = mapPart,
): Message {
  const common = {
    id: info.id,
    sessionID: ids.encode(info.sessionID),
    parts: parts.map((part) => partMapper(part)),
  };
  if (info.role === "user") {
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
export function mapPart(part: RawPart, awaitingPermission = false): Part {
  const id = part.id;
  switch (part.type) {
    case "text":
    case "reasoning":
      return {
        ...mapStreamingShell(part),
        blocks: markdown(part.text || ""),
      };
    case "tool":
      return { kind: "tool", id, call: mapTool(part, awaitingPermission) };
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
      return { kind: "compaction", id };
    case "snapshot":
    case "patch":
      return { kind: "meta", id };
    case "step-start":
      return { kind: "step", id, phase: "start" };
    case "step-finish":
      return {
        kind: "step",
        id,
        phase: "finish",
        cost: part.cost,
        tokens: tokens(part.tokens),
      };
    default:
      return {
        kind: "external",
        id,
        name: part.type,
        data: preview(part).text,
      };
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
      path: diff.file || "unknown",
      status: diff.status || "modified",
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
