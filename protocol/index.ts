// SPDX-License-Identifier: LGPL-3.0-only
export interface IndexEntry {
  id: string;
  parentID?: string;
  directory: string;
  projectID: string;
  title: string;
  timeCreated: number;
  timeUpdated: number;
  archived: boolean;
  status: "idle" | "busy" | "retry";
  retry?: { attempt: number; message: string; next: number };
  attention: {
    permissions: number;
    questions: number;
    childPermissions: number;
    childQuestions: number;
    error?: string;
  };
}
export type IndexOp = { op: "upsert"; entry: IndexEntry } | {
  op: "remove";
  id: string;
};
