// SPDX-License-Identifier: LGPL-3.0-only
// Legacy scenario knobs describe the fake server's positive evidence. Production
// consumers receive only this server projection, never these status-based knobs.
import type {
  EntityState,
  InboxSnapshot,
  IndexMetadata,
  Supervision,
} from "@otk/protocol";
import {
  entityKey,
  projectTabGroups,
  rollupStatus,
  taskEntityID,
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
  entries?: readonly (IndexMetadata & inbox.OperationAttention)[],
) {
  const byID = new Map(entries?.map((entry) => [entry.id, entry]));
  return Object.fromEntries(
    Object.entries(value.supervision ?? {}).map(
      ([id, verdict]): [string, EntityState] => {
        const entry = byID.get(id);
        const activity = entry?.activity?.work;
        const state = entry?.deleted
          ? "none"
          : entry?.operationStatus ?? inbox.supervisionStatus(id, value);
        return [entityKey("session", id), {
          kind: "session",
          id,
          state,
          previous: state,
          evidence: {
            awaitingDelivery: verdict.state === "finishedUnseen",
            work: activity
              ? activity.fresh && activity.keys.length > 0
              : verdict.state === "working",
            permissions: 0,
            questions: 0,
            descendants: { working: 0, blocked: 0, finished: 0, unseen: 0 },
          },
          counts: {
            blocked: Number(state === "blocked"),
            working: Number(state === "working"),
            finished: Number(state === "finished"),
            unseen: Number(verdict.unseen ?? false),
          },
        }];
      },
    ),
  );
}

export function projected(
  entries: readonly (IndexMetadata & inbox.OperationAttention)[],
  value: Pick<InboxSnapshot, "seen" | "finishes" | "supervision" | "entities">,
) {
  const supervision = Object.fromEntries(
    entries.map((entry): [string, Supervision] => {
      const terminal = value.finishes[entry.id] ?? 0;
      return [
        entry.id,
        value.supervision?.[entry.id] ?? {
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
        },
      ];
    }),
  );
  return {
    ...value,
    supervision,
    entities: {
      ...entitySnapshot({ supervision }, entries),
      ...value.entities,
    },
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
        inbox: fixtureSnapshot(input.context ?? input.entries, input.inbox, [
          input,
        ]),
      });
    },
  };
};

/** The fake server publishes the wire contract consumed by real client models. */
export function fixtureSnapshot(
  entries: readonly (IndexMetadata & inbox.OperationAttention)[],
  value: InboxSnapshot,
  projections?: readonly Pick<
    TabInput,
    "directory" | "directories" | "followParent"
  >[],
): InboxSnapshot {
  const projection = projected(entries, value);
  const directories = new Set([
    ...entries.map((e) => e.directory),
    ...value.tasks.map((t) => t.directory),
    ...Object.keys(value.summaries ?? {}),
  ]);
  for (
    const input of projections ??
      [...directories].flatMap((directory) =>
        [false, true].map((followParent) => ({
          directory,
          directories: value.summaries?.[directory]?.scopes,
          followParent,
        }))
      )
  ) {
    const partition = projectTabGroups(entries, value.tasks, input);
    for (const group of partition.groups) {
      const id = taskEntityID(
        group.id,
        input.followParent,
        input.directory,
        group.kind,
      );
      const members = group.members.map((id) =>
        projection.entities[entityKey("session", id)]
      ).filter(Boolean);
      const state = rollupStatus(...members.map((v) => v.state));
      projection.entities[entityKey("task", id)] =
        value.entities?.[entityKey("task", id)] ?? {
          kind: "task",
          id,
          state,
          previous: state,
          counts: members.reduce(
            (counts, v) => ({
              blocked: counts.blocked + v.counts.blocked,
              working: counts.working + v.counts.working,
              finished: counts.finished + v.counts.finished,
              unseen: counts.unseen + v.counts.unseen,
            }),
            { blocked: 0, working: 0, finished: 0, unseen: 0 },
          ),
        };
    }
  }
  return { ...value, ...projection };
}
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
