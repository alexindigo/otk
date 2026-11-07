// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexMetadata } from "./index.ts";
import type { IntentIdentity } from "./requests.ts";
export const SESSION_LIST_SIZE = 20;
export const MAX_SESSION_LIST_SIZE = 200;
export interface SessionListInput {
  directory: string;
  /** null selects roots; absence selects all project sessions. */
  parentID?: string | null;
  query?: string;
  before?: string;
  limit?: number;
}
export type LoadScope =
  | {
    kind: "project-sessions";
    directory: string;
    query?: string;
    parentID?: null;
  }
  | { kind: "parent-children"; directory: string; parentID: string }
  | { kind: "session-metadata" | "session-messages"; sessionID: string };
/** All owners distinguish root-only demand from an unfiltered parent scope. */
export function sessionListKey(input: SessionListInput): string {
  return JSON.stringify([
    input.directory,
    input.parentID === undefined
      ? ["all"]
      : input.parentID === null
      ? ["roots"]
      : ["parent", input.parentID],
    input.query ?? "",
    input.limit ?? SESSION_LIST_SIZE,
    input.before ?? null,
  ]);
}
export type LoadBoundary =
  | { kind: "page"; before?: string; limit: number }
  | { kind: "metadata"; oldest: string };
export interface LoadCoverage {
  id: string;
  scope: LoadScope;
  boundary: LoadBoundary;
  generation: string;
  revision: number;
  state: "loading" | "complete";
}
export interface SessionListPage {
  items: SessionStructure[];
  older: string | null;
  load: LoadCoverage;
}
export interface LoadChunk {
  t: "load.chunk";
  request: IntentIdentity;
  epoch: number;
  load: LoadCoverage;
  data: {
    kind: "session-list";
    items: SessionStructure[];
    older: string | null;
    offset: number;
  };
}
/** Current-project row discovery has no status, marks, digests or history. */
export type SessionStructure = Pick<
  IndexMetadata,
  "id" | "directory" | "parentID" | "title"
>;
export type SessionListRow =
  | { key: string; kind: "heading"; group: string; title: string }
  | {
    key: string;
    kind: "session";
    group: string;
    title: string;
    id: string;
    depth: number;
    parentID?: string;
    position: number;
    size: number;
  };
