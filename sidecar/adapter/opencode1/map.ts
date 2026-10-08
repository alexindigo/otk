// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ContentSession,
  FileDiff,
  Message,
  Part,
  PermissionRequest,
  Tokens,
} from "../../../protocol/content.ts";
import type { IndexEntry } from "../../../protocol/index.ts";
import { parseDiff } from "../../content/diff.ts";
import { markdown } from "../../content/markdown.ts";
import { mapTool } from "./map-tools.ts";
import type {
  Info,
  RawDiff,
  RawPart,
  RawPermission,
  Session,
} from "./types.ts";
export function mapSession(session: Session): ContentSession {
  return {
    id: session.id,
    parentID: session.parentID,
    projectID: session.projectID,
    directory: session.directory,
    title: session.title,
    time: { created: session.time.created, updated: session.time.updated },
    archived: session.time.archived !== undefined,
  };
}
export function mapIndex(session: Session): IndexEntry {
  return {
    id: session.id,
    parentID: session.parentID,
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
const tokens = (value?: Tokens): Tokens =>
  value
    ? {
      input: value.input,
      output: value.output,
      reasoning: value.reasoning,
      cache: { read: value.cache.read, write: value.cache.write },
    }
    : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
export function mapMessage(info: Info, parts: RawPart[] = []): Message {
  const common = {
    id: info.id,
    sessionID: info.sessionID,
    parts: parts.map((p) => mapPart(p)),
    agent: info.agent,
  };
  if (info.role === "user") {
    return {
      ...common,
      role: "user",
      time: { created: info.time.created },
      model: info.model
        ? { provider: info.model.providerID, model: info.model.modelID }
        : undefined,
    };
  }
  return {
    ...common,
    role: "assistant",
    time: { created: info.time.created, completed: info.time.completed },
    model: { provider: info.providerID!, model: info.modelID! },
    tokens: tokens(info.tokens),
    cost: info.cost ?? 0,
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
      return {
        kind: "text",
        id,
        blocks: markdown(part.text || ""),
        synthetic: part.synthetic ?? false,
      };
    case "reasoning":
      return {
        kind: "reasoning",
        id,
        blocks: markdown(part.text || ""),
        time: { start: part.time!.start, end: part.time?.end },
        title: typeof part.metadata?.title === "string"
          ? part.metadata.title
          : undefined,
      };
    case "tool":
      return { kind: "tool", id, call: mapTool(part, awaitingPermission) };
    case "file":
      return {
        kind: "file",
        id,
        name: part.filename || part.source?.path || "file",
        mime: part.mime!,
        path: part.source?.path,
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
      return { kind: "unknown", id, label: part.type };
  }
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
  now = Date.now(),
): PermissionRequest {
  const metadata = request.metadata;
  const text = (key: string) =>
    typeof metadata[key] === "string" ? metadata[key] as string : undefined;
  return {
    id: request.id,
    sessionID: request.sessionID,
    kind: request.permission,
    title: request.permission,
    patterns: [...request.patterns],
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
