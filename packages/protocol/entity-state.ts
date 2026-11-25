// SPDX-License-Identifier: LGPL-3.0-only
import type { ProjectStatus } from "./inbox.ts";
import type { PublicFailure } from "./requests.ts";
import type { TerminalOutcome } from "./supervision.ts";

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
export type HelperDisposition = "running" | "needsYou" | "notReturned";
export interface TaskHelpers {
  counts: Record<HelperDisposition, number>;
  ids: string[];
}
export interface SessionEvidence {
  /** D66: a proven helper terminal not covered by its parent's result receipt. */
  awaitingDelivery?: boolean;
  helper?: HelperDisposition;
  /** Wall-clock time when the entity owner first observed this needs-you interval. */
  waitingSince?: number;
  /** Positive native execution clock, retained across its terminal transition. */
  run?: { startedAt: number; endedAt?: number };
  /** Positive fresh work evidence, including when a blocker wins. */
  work: boolean;
  permissions: number;
  questions: number;
  descendants: EntityCounts;
  requests?: {
    permissions: readonly EntityRequestEvidence[];
    questions: readonly EntityRequestEvidence[];
  };
  liveWork?: readonly {
    id: string;
    kind: "shell" | "execution" | "helper";
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
  /** Running PTYs; separate from the session's own native activity. */
  dependencies?: number;
  terminal?: number;
  outcome?: TerminalOutcome;
  terminalOrigin?: "live" | "historical";
  evidence?: SessionEvidence;
  /** D66/D58: ordered helpers belonging to this task. */
  helpers?: TaskHelpers;
  /** Aggregates blocked only by permissions: those requests' identities, so
   * the client derives the same per-request grace as for each member. */
  requests?: readonly EntityRequestEvidence[];
}
/** IDs are opaque and connection-local. No path or session identity is rewritten. */
export const entityKey = (kind: EntityKind, id: string): string =>
  `${kind}:${id}`;

/** Keep attention and undelivered helper results reachable (D62/D66). */
export function entityRequiresVisibility(
  value: EntityState | undefined,
): boolean {
  return !!value && (value.state !== "none" ||
    (value.dependencies ?? 0) > 0 ||
    value.evidence?.awaitingDelivery === true);
}

/** D69/D70: a task's identity is independent of checkout and view. */
export const taskEntityID = (kind: "task" | "session", id: string): string =>
  `${kind}/${id}`;
