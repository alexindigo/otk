// SPDX-License-Identifier: LGPL-3.0-only
// Legacy scenario knobs describe the fake server's positive evidence. Production
// consumers receive only this server projection, never these status-based knobs.
import {
  entityKey,
  type InboxSnapshot,
  type IndexMetadata,
  type Supervision,
} from "@otk/protocol";
import * as inbox from "../inbox.ts";
import { createTabs as tabs, type TabInput } from "../tabs.ts";
import { taskBreadcrumbs as crumbs } from "../task-breadcrumbs.ts";
export * from "../inbox.ts";
export type * from "../tabs.ts";
export type * from "../task-breadcrumbs.ts";

/** Fake-server entity publication for legacy scenario knobs, not a client fallback. */
export function entitySnapshot(
  value: Pick<InboxSnapshot, "supervision">,
  entries: readonly IndexMetadata[] = [],
) {
  return Object.fromEntries(
    Object.entries(value.supervision ?? {}).map((
      [id, s],
    ) => [entityKey("session", id), {
      kind: "session" as const,
      id,
      state: inbox.inboxStatus({ id } as IndexMetadata, {
        seen: {},
        finishes: {},
        supervision: { [id]: s },
      }),
      previous: "none" as const,
      evidence: {
        awaitingDelivery: s.state === "finishedUnseen",
        work: entries.length
          ? !!entries.find((entry) => entry.id === id)?.activity?.work?.fresh &&
            !!entries.find((entry) => entry.id === id)?.activity?.work?.keys
              .length
          : s.state === "working",
        permissions: 0,
        questions: 0,
        descendants: { working: 0, blocked: 0, finished: 0, unseen: 0 },
      },
      counts: {
        working: Number(s.state === "working"),
        blocked: Number(s.state === "needsYou"),
        finished: Number(s.state === "finishedUnseen"),
        unseen: Number(s.unseen ?? false),
      },
    }]),
  );
}

export function projected(
  entries: readonly IndexMetadata[],
  value: Pick<InboxSnapshot, "seen" | "finishes" | "supervision">,
) {
  const result = {
    ...value,
    supervision: Object.fromEntries(
      entries.map((entry): [string, Supervision] => {
        const terminal = value.finishes[entry.id] ?? 0;
        return [entry.id, {
          terminal,
          unseen: !entry.deleted && terminal > (value.seen[entry.id] ?? 0),
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
  return { ...result, entities: entitySnapshot(result) };
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
