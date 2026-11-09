// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentSession, SessionMetadata } from "@otk/protocol";
import type { OpenCodeClient } from "./client.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
export type NativeSession = Awaited<
  ReturnType<OpenCodeClient["session"]["get"]>
>;
export type SessionFacts = Pick<
  NativeSession,
  "id" | "location" | "projectID" | "title" | "parentID" | "time" | "outcome"
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
      updated: millis(raw.time.updated),
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
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
}
