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
export interface SessionEvidence {
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
  terminal?: number;
  outcome?: TerminalOutcome;
  terminalOrigin?: "live" | "historical";
  evidence?: SessionEvidence;
  /** Aggregates blocked only by permissions: those requests' identities, so
   * the client derives the same per-request grace as for each member. */
  requests?: readonly EntityRequestEvidence[];
}
/** IDs are opaque and connection-local. No path or session identity is rewritten. */
export const entityKey = (kind: EntityKind, id: string): string =>
  `${kind}:${id}`;

/** Task membership is a view projection (D8), not a different state rule. */
export const taskEntityID = (
  id: string,
  followParent = false,
  directory = "",
  kind: "task" | "session" = "task",
): string => JSON.stringify([kind, id, directory, followParent]);

/** Decode only the projection identity, never state or membership. */
export function taskEntityProjection(id: string): {
  directory: string;
  followParent: boolean;
} | undefined {
  try {
    const value: unknown = JSON.parse(id);
    if (
      Array.isArray(value) && value.length === 4 &&
      (value[0] === "task" || value[0] === "session") &&
      typeof value[1] === "string" && typeof value[2] === "string" &&
      typeof value[3] === "boolean"
    ) {
      return { directory: value[2], followParent: value[3] };
    }
  } catch { /* Not a task projection identity. */ }
}
