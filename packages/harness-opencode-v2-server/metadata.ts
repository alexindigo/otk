// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentSession, SessionMetadata } from "@otk/protocol";
import type { OpenCodeClient } from "./client.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { sessionRecency } from "./recency.ts";
import { recordedCheckout } from "./project-topology.ts";
export type NativeSession =
  & Awaited<
    ReturnType<OpenCodeClient["session"]["get"]>
  >
  & { activity?: number; terminal?: number };
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
  | "terminal"
  | "subpath"
>;
export function millis(value: unknown): number {
  return typeof value === "number"
    ? value
    : typeof value === "string"
    ? Date.parse(value)
    : 0;
}
/** Durable execution and shell endpoints are evidence, never work ownership. */
export function terminalEvidence(
  idle: unknown,
  outcome: unknown,
  shell?: number,
): number | undefined {
  const end = ["succeeded", "failed", "interrupted"].includes(String(outcome))
    ? millis(idle)
    : 0;
  return Math.max(
    Number.isFinite(end) && end > 0 ? end : 0,
    typeof shell === "number" && Number.isFinite(shell) && shell > 0
      ? shell
      : 0,
  ) || undefined;
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
    ...(recordedCheckout(mapped.directory, raw.subpath) === undefined
      ? {}
      : { checkoutRoot: recordedCheckout(mapped.directory, raw.subpath) }),
    title: mapped.title,
    parentID: mapped.parentID,
    archived: mapped.archived,
    timeCreated: mapped.time.created,
    timeUpdated: mapped.time.updated,
    status: "idle",
    activityAuthority: "unknown",
    activity: {
      terminal: terminalEvidence(raw.time.idle, raw.outcome, raw.terminal),
    },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
}
