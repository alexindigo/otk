// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentSession, SessionMetadata } from "@otk/protocol";
import type { OpenCodeClient } from "./client.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { sessionRecency } from "./recency.ts";
export type NativeSession =
  & Awaited<
    ReturnType<OpenCodeClient["session"]["get"]>
  >
  & { activity?: number };
export type SessionFacts = Pick<
  NativeSession,
  | "id"
  | "location"
  | "projectID"
  | "title"
  | "parentID"
  | "time"
  | "outcome"
  | "activity"
>;
export function millis(value: unknown): number {
  return typeof value === "number"
    ? value
    : typeof value === "string"
    ? Date.parse(value)
    : 0;
}
export function session(raw: SessionFacts): ContentSession {
  return {
    id: ids.encode(raw.id),
    directory: raw.location.directory,
    projectID: raw.projectID,
    title: raw.title ?? "Untitled session",
    ...(raw.parentID ? { parentID: ids.encode(raw.parentID) } : {}),
    time: {
      created: millis(raw.time.created),
      updated: sessionRecency(raw.time, raw.activity),
    },
    archived: !!raw.time.archived,
  };
}
/** Scalar acquisition cannot certify activity or erase live attention. */
export function metadata(raw: SessionFacts): SessionMetadata {
  const mapped = session(raw);
  return {
    id: mapped.id,
    directory: mapped.directory,
    projectID: mapped.projectID,
    title: mapped.title,
    parentID: mapped.parentID,
    archived: mapped.archived,
    timeCreated: mapped.time.created,
    timeUpdated: mapped.time.updated,
    status: "idle",
    activityAuthority: "unknown",
    activity: {
      terminal: raw.outcome && millis(raw.time.idle) > 0
        ? millis(raw.time.idle)
        : undefined,
    },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
}
