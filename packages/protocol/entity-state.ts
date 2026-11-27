// SPDX-License-Identifier: LGPL-3.0-only
import type { ProjectStatus } from "./inbox.ts";
import type { PublicFailure } from "./requests.ts";
import type { SessionSettlement, TerminalOutcome } from "./supervision.ts";

export type EntityKind =
  | "session"
  | "task"
  | "checkout"
  | "project"
  | "archive"
  | "global";
export type BlockedCause =
  | "permission"
  | "question"
  | "form"
  | "operation"
  | "failure"
  | "failedHelper";
export interface EntityCounts {
  blocked: number;
  working: number;
  finished: number;
  unseen: number;
}
/** Body-free request evidence. The client request-lifetime owner alone supplies
 * arrivedAt in its local clock domain; server evidence never invents that clock. */
export interface EntityRequestEvidence {
  id: string;
  arrivedAt?: number;
}
export type HelperDisposition = "running" | "needsYou" | "finished" | "opened";
export type ComposerLinkState = "none" | "idle" | "running";
export interface EntityLamp {
  state: ProjectStatus;
}
export interface TaskHelpers {
  counts: Record<Exclude<HelperDisposition, "opened">, number> & {
    opened?: number;
  };
  ids: string[];
  /** The counted helpers only, not the entire ancestry task. */
  lamps?: {
    all: EntityLamp;
    groups: Record<Exclude<HelperDisposition, "opened">, EntityLamp> & {
      opened?: EntityLamp;
    };
  };
}
/** The session's own currently running shells. No session verdict on a row. */
export interface RunningShells extends EntityLamp {
  state: "working" | "none";
  count: number;
  items: readonly {
    id: string;
    label: string;
    title: string;
    startedAt?: number;
  }[];
}
export interface SessionEvidence {
  settlement?: SessionSettlement;
  /** Admitted input or result work owned by this session, not descendants. */
  continuation?: true;
  helper?: HelperDisposition;
  /** Wall-clock time when the entity owner first observed this needs-you interval. */
  waitingSince?: number;
  /** Positive native execution clock, retained across its terminal transition. */
  run?: { startedAt: number; endedAt?: number };
  /** Positive fresh work evidence, including when a blocker wins. */
  work: boolean;
  /** Fresh own native execution, separate from shells and OTK operations. */
  nativeRun?: true;
  permissions: number;
  questions: number;
  descendants: EntityCounts;
  requests?: {
    permissions: readonly EntityRequestEvidence[];
    questions: readonly EntityRequestEvidence[];
  };
  liveWork?: readonly {
    id: string;
    kind: "execution" | "helper";
    label: string;
    title: string;
    startedAt?: number;
    state: ProjectStatus;
  }[];
  retry?: { attempt: number; message?: string; next?: number };
  failure?: PublicFailure;
  /** A current diagnostic observation, not proof that a native run failed. */
  error?: true;
}
export interface EntityState {
  kind: EntityKind;
  id: string;
  state: ProjectStatus;
  cause?: BlockedCause;
  previous: ProjectStatus;
  counts: EntityCounts;
  /** D76: explicit open retains the view without affecting the attention lamp. */
  opened?: true;
  /** Running PTYs; separate from the session's own native activity. */
  dependencies?: number;
  /** Aggregate work evidence, even when another state wins the lamp (D78). */
  liveWork?: true;
  terminal?: number;
  outcome?: TerminalOutcome;
  terminalOrigin?: "live" | "historical";
  evidence?: SessionEvidence;
  /** Published only for the socket's selected session; independent of its lamp. */
  composerLink?: ComposerLinkState;
  /** D66/D58: ordered helpers belonging to this task. */
  helpers?: TaskHelpers;
  /** Fresh shell inventory belonging only to this session. */
  shells?: RunningShells;
  /** Aggregates blocked only by permissions: those requests' identities, so
   * the client derives the same per-request grace as for each member. */
  requests?: readonly EntityRequestEvidence[];
}
/** IDs are opaque and connection-local. No path or session identity is rewritten. */
export const entityKey = (kind: EntityKind, id: string): string =>
  `${kind}:${id}`;

/** Keep attention and published helpers reachable (D62/D72). */
export function entityRequiresVisibility(
  value: EntityState | undefined,
): boolean {
  return !!value && (value.state !== "none" ||
    (value.dependencies ?? 0) > 0 ||
    (value.evidence?.helper !== undefined &&
      value.evidence.helper !== "opened"));
}

/** A view keeps both mandatory sessions and sessions explicitly opened (D76). */
export function entityRetainsVisibility(
  value: EntityState | undefined,
): boolean {
  return value?.opened === true || entityRequiresVisibility(value);
}

/** D69/D70: a task's identity is independent of checkout and view. */
export const taskEntityID = (kind: "task" | "session", id: string): string =>
  `${kind}/${id}`;
