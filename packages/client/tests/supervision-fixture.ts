// SPDX-License-Identifier: LGPL-3.0-only
// Legacy scenario knobs describe the fake server's positive evidence. Production
// consumers receive only this server projection, never these status-based knobs.
import type { InboxSnapshot, IndexMetadata, Supervision } from "@otk/protocol";
import * as inbox from "../inbox.ts";
import { createTabs as tabs, type TabInput } from "../tabs.ts";
import { taskBreadcrumbs as crumbs } from "../task-breadcrumbs.ts";
export * from "../inbox.ts";
export type * from "../tabs.ts";
export type * from "../task-breadcrumbs.ts";

export function projected(
  entries: readonly IndexMetadata[],
  value: Pick<InboxSnapshot, "seen" | "finishes" | "supervision">,
) {
  return {
    ...value,
    supervision: Object.fromEntries(
      entries.map((entry): [string, Supervision] => {
        const terminal = value.finishes[entry.id] ?? 0;
        return [entry.id, {
          terminal,
          state: entry.deleted
            ? "none"
            : entry.attention.permissions + entry.attention.questions > 0 ||
                entry.attention.error
            ? "needsYou"
            : entry.status !== "idle"
            ? "working"
            : terminal > (value.seen[entry.id] ?? 0)
            ? "finishedUnseen"
            : "none",
        }];
      }),
    ),
  };
}
export const inboxStatus: typeof inbox.inboxStatus = (entry, value) =>
  inbox.inboxStatus(entry, projected([entry], value));
export const rollup: typeof inbox.rollup = (entries, value) =>
  inbox.rollup(entries, projected(entries, value));
export const inboxProjects: typeof inbox.inboxProjects = (
  entries,
  value,
  ...args
) =>
  inbox.inboxProjects(
    entries,
    { ...value, ...projected(entries, value) },
    ...args,
  );
export const createTabs: typeof tabs = (...args) => {
  const model = tabs(...args);
  return {
    ...model,
    update(input: TabInput) {
      model.update({
        ...input,
        inbox: { ...input.inbox, ...projected(input.entries, input.inbox) },
      });
    },
  };
};
export const taskBreadcrumbs: typeof crumbs = (
  task,
  entries,
  tasks,
  indexed,
  value = { seen: {}, finishes: {} },
  followParent,
  projection,
) =>
  crumbs(
    task,
    entries,
    tasks,
    indexed,
    projected(entries, value),
    followParent,
    projection,
  );
