// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexMetadata } from "./index.ts";
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
