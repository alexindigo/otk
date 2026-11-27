// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ContentSession,
  latestTerminal,
  type SessionMetadata,
  type TerminalEvidence,
  type TerminalOutcome,
} from "@otk/protocol";
import type { OpenCodeClient } from "./client.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { sessionRecency } from "./recency.ts";
import { recordedCheckout } from "./project-topology.ts";
import { terminalFailure } from "./request-failure.ts";
export type NativeSession =
  & Awaited<
    ReturnType<OpenCodeClient["session"]["get"]>
  >
  & {
    activity?: number;
    terminal?: number;
    terminalError?: unknown;
    runID?: string;
  };
export type SessionFacts = Pick<
  NativeSession,
  | "id"
  | "location"
  | "projectID"
  | "title"
  | "agent"
  | "parentID"
  | "time"
  | "outcome"
  | "activity"
  | "terminal"
  | "terminalError"
  | "runID"
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
export function terminalFacts(
  idle: unknown,
  outcome: unknown,
  shell?: number,
): TerminalEvidence {
  const end = terminalEvidence(idle, outcome);
  return latestTerminal(
    end
      ? {
        terminal: end,
        outcome: outcome as TerminalOutcome,
        terminalOrigin: "historical",
      }
      : undefined,
    shell ? { terminal: shell, terminalOrigin: "historical" } : undefined,
  );
}
/** Scalar acquisition cannot certify activity or erase live attention. */
export function metadata(raw: SessionFacts): SessionMetadata {
  const mapped = session(raw);
  // A top-level user shell can contribute its own completion history. A
  // helper terminal is the model execution covered by a parent's receipt.
  const terminal = terminalFacts(
    raw.time.idle,
    raw.outcome,
    raw.parentID ? undefined : raw.terminal,
  );
  if (raw.parentID && raw.runID && terminal.terminal) {
    terminal.runID = raw.runID;
  }
  const failure =
    terminal.outcome === "failed" && terminal.terminal === millis(raw.time.idle)
      ? terminalFailure(
        raw.terminalError,
        mapped.id,
        terminal.terminal,
        mapped.title,
      )
      : undefined;
  return {
    id: mapped.id,
    directory: mapped.directory,
    projectID: mapped.projectID,
    ...(recordedCheckout(mapped.directory, raw.subpath) === undefined
      ? {}
      : { checkoutRoot: recordedCheckout(mapped.directory, raw.subpath) }),
    title: mapped.title,
    ...(raw.agent ? { agent: raw.agent } : {}),
    parentID: mapped.parentID,
    archived: mapped.archived,
    timeCreated: mapped.time.created,
    timeUpdated: mapped.time.updated,
    status: "idle",
    activityAuthority: "unknown",
    activity: {
      ...terminal,
      ...(failure ? { terminalFailure: failure } : {}),
    },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
}
