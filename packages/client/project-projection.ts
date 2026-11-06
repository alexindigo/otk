// SPDX-License-Identifier: LGPL-3.0-only
import type { InboxSnapshot, ProjectRecord, TaskRecord } from "@otk/protocol";
import { createSessionTree } from "./session-tree.ts";
import type { TabInput } from "./tabs.ts";
import type { MergedMetadata } from "./index.ts";
import {
  ageing,
  attentionStatus,
  INBOX_STATUS_PRIORITY,
  type InboxChanges,
  type InboxProject,
  type InboxStatus,
  inboxStatus,
  unread,
  visitTime,
} from "./inbox.ts";
import { createState, type StateFactory } from "./state.ts";

export interface ProjectProjectionRow extends InboxProject {
  sessionIDs: string;
  sessionCount: number;
}

/** One sidecar's keyed metadata contributions. Digests never enter this owner. */
export function createProjectProjection(o: {
  entry(id: string): MergedMetadata | undefined;
  factory?: StateFactory;
  membership?(directory: string, present: boolean): void;
}) {
  const clock = (o.factory ?? createState)({
    revision: 0,
    keys: {} as Record<string, number>,
  });
  const entryClock = (o.factory ?? createState)({
    keys: {} as Record<string, number>,
  });
  const sessions = new Map<string, {
    entry: MergedMetadata;
    status: InboxStatus;
    unread: boolean;
  }>();
  const projects = new Map<string, {
    members: Map<string, MergedMetadata>;
    counts: Record<InboxStatus, number>;
    unread: number;
    record?: ProjectRecord;
    discovered: boolean;
    operation?: InboxStatus;
    ids?: string;
    row?: ProjectProjectionRow;
    time?: string;
    metadata?: MergedMetadata[];
    structure?: MergedMetadata[];
    tasks: TaskRecord[];
    input?: TabInput;
    activitySource?: Readonly<Record<string, InboxStatus>>;
    activity: Record<string, InboxStatus>;
    tree: ReturnType<typeof createSessionTree>;
  }>();
  let inbox: InboxSnapshot = {
    projects: [],
    tasks: [],
    seen: {},
    finishes: {},
    pathTemplates: [],
  };
  let catalog: readonly MergedMetadata[] | undefined;
  let operationStates: ReadonlyMap<string, InboxStatus> = new Map();
  const visible = new Set<string>();
  const ensure = (directory: string) => {
    let p = projects.get(directory);
    if (!p) {
      p = {
        members: new Map(),
        counts: Object.fromEntries(
          INBOX_STATUS_PRIORITY.map((status) => [status, 0]),
        ) as Record<InboxStatus, number>,
        unread: 0,
        discovered: false,
        operation: operationStates.get(directory),
        tasks: [],
        tree: createSessionTree(),
        activity: {},
      };
      projects.set(directory, p);
    }
    return p;
  };
  const publish = (dirty: Set<string>) => {
    if (!dirty.size) return;
    for (const directory of dirty) {
      const p = projects.get(directory)!;
      p.row = undefined;
      p.metadata = undefined;
      p.input = undefined;
      const present = !!(p.members.size || p.record || p.discovered);
      if (!present && !p.tasks.length) {
        projects.delete(directory);
      }
      if (visible.has(directory) !== present) {
        if (present) visible.add(directory);
        else visible.delete(directory);
        o.membership?.(directory, present);
      }
    }
    clock.update((draft) => {
      draft.revision++;
      for (const directory of dirty) {
        draft.keys[directory] = (draft.keys[directory] ?? 0) + 1;
      }
    });
  };
  const update = (ids: Iterable<string>, dirty = new Set<string>()) => {
    const changed = new Set<string>();
    for (const id of ids) {
      const before = sessions.get(id), entry = o.entry(id);
      const status = entry && inboxStatus(entry, inbox);
      const unseen = !!entry && !entry.parentID && unread(id, inbox);
      if (
        before?.entry === entry && before?.status === status &&
        before?.unread === unseen
      ) continue;
      changed.add(id);
      if (before) {
        const p = ensure(before.entry.directory);
        if (
          !entry || entry.directory !== before.entry.directory ||
          entry.parentID !== before.entry.parentID ||
          entry.title !== before.entry.title
        ) p.structure = undefined;
        p.counts[before.status]--;
        p.unread -= Number(before.unread);
        if (!entry || entry.directory !== before.entry.directory) {
          p.members.delete(id);
          p.ids = undefined;
        }
        dirty.add(before.entry.directory);
      }
      if (entry) {
        const p = ensure(entry.directory);
        if (!before || entry.directory !== before.entry.directory) {
          p.structure = undefined;
        }
        if (!p.members.has(id)) p.ids = undefined;
        p.members.set(id, entry);
        p.counts[status!]++;
        p.unread += Number(unseen);
        sessions.set(id, { entry, status: status!, unread: unseen });
        dirty.add(entry.directory);
      } else sessions.delete(id);
      catalog = undefined;
    }
    publish(dirty);
    if (changed.size) {
      entryClock.update((draft) => {
        for (const id of changed) draft.keys[id] = (draft.keys[id] ?? 0) + 1;
      });
    }
  };
  return {
    update,
    entry(id: string) {
      void entryClock.state.keys[id];
      return sessions.get(id)?.entry;
    },
    input(
      directory: string,
      taskActivity: Readonly<Record<string, InboxStatus>>,
    ): TabInput {
      void clock.state.keys[directory];
      const p = ensure(directory);
      const entries = p.metadata ??= [...p.members.values()];
      if (p.activitySource !== taskActivity) {
        p.activitySource = taskActivity;
        const activity: Record<string, InboxStatus> = {};
        for (const task of p.tasks) {
          if (taskActivity[task.id]) {
            activity[task.id] = taskActivity[task.id];
          }
        }
        if (
          Object.keys({ ...p.activity, ...activity }).some((id) =>
            p.activity[id] !== activity[id]
          )
        ) {
          p.activity = activity;
          p.input = undefined;
        }
      }
      if (!p.input) {
        p.input = {
          version: clock.state.keys[directory] ?? 0,
          directory,
          entries,
          taskActivity: p.activity,
          inbox: { ...inbox, tasks: p.tasks },
        };
      }
      return p.input;
    },
    rows(directory: string, query = "") {
      void clock.state.keys[directory];
      const p = ensure(directory);
      return p.tree.rows(
        p.structure ??= [...p.members.values()],
        p.tasks,
        directory,
        query,
      );
    },
    get revision() {
      return clock.state.revision;
    },
    metadata() {
      void clock.state.revision;
      return catalog ??= [...sessions.values()].map((s) => s.entry);
    },
    inbox(next: InboxSnapshot, changes?: InboxChanges) {
      const dirty = new Set<string>();
      if (!changes || changes.baseline || changes.tasks) {
        const tasks = new Map<string, TaskRecord[]>();
        for (const task of next.tasks) {
          const list = tasks.get(task.directory) ?? [];
          list.push(task);
          tasks.set(task.directory, list);
        }
        for (
          const directory of new Set([...projects.keys(), ...tasks.keys()])
        ) {
          const p = ensure(directory), values = tasks.get(directory) ?? [];
          if (JSON.stringify(p.tasks) === JSON.stringify(values)) continue;
          p.tasks = structuredClone(values);
          p.activitySource = undefined;
          dirty.add(directory);
        }
      }
      if (
        !changes || changes.baseline || changes.discovery ||
        changes.projects.length
      ) {
        const records = new Map(next.projects.map((p) => [p.directory, p]));
        const discovered = new Set(next.discovered ?? []);
        for (
          const directory of changes && !changes.baseline && !changes.discovery
            ? changes.projects
            : new Set([
              ...projects.keys(),
              ...records.keys(),
              ...discovered,
            ])
        ) {
          const p = ensure(directory), record = records.get(directory);
          if (
            JSON.stringify(p.record) !== JSON.stringify(record) ||
            p.discovered !== discovered.has(directory)
          ) dirty.add(directory);
          p.record = record && { ...record };
          p.discovered = discovered.has(directory);
        }
      }
      const ids = new Set<string>(changes?.sessions);
      if (!changes || changes.baseline) {
        for (const field of ["seen", "finishes"] as const) {
          for (
            const id of new Set([
              ...Object.keys(inbox[field]),
              ...Object.keys(next[field]),
            ])
          ) {
            if (inbox[field][id] !== next[field][id]) {
              ids.add(id);
            }
          }
        }
      }
      // Retain detached scalar marks: framework stores reconcile in place.
      if (!changes || changes.baseline) {
        inbox = {
          ...next,
          seen: { ...next.seen },
          finishes: { ...next.finishes },
        };
      } else {for (const id of ids) {
          for (const field of ["seen", "finishes"] as const) {
            if (next[field][id] === undefined) delete inbox[field][id];
            else inbox[field][id] = next[field][id];
          }
        }}
      update(ids, dirty);
    },
    operations(states: ReadonlyMap<string, InboxStatus>) {
      const dirty = new Set<string>();
      for (
        const directory of new Set([
          ...operationStates.keys(),
          ...states.keys(),
        ])
      ) {
        const p = projects.get(directory), next = states.get(directory);
        if (!p) continue;
        if (p.operation !== next) {
          p.operation = next;
          dirty.add(directory);
        }
      }
      operationStates = states;
      publish(dirty);
    },
    directories() {
      void clock.state.revision;
      return [...visible];
    },
    row(directory: string, now: number, thresholds?: readonly number[]) {
      void clock.state.keys[directory];
      const p = projects.get(directory);
      if (!p) return undefined;
      const status = attentionStatus(
        p.operation,
        ...INBOX_STATUS_PRIORITY.filter((s) => p.counts[s] > 0),
      );
      const record = p.record;
      const inactive = !!record?.inactive && status === "idle";
      const time = inactive ? record?.inactiveAt ?? record!.lastVisit : now;
      const text = record ? visitTime(record.lastVisit, time) : "";
      const age = record ? ageing(record.lastVisit, time, thresholds) : 0;
      const key = `${text}/${age}`;
      if (!p.row || p.time !== key) {
        p.time = key;
        p.ids ??= [...p.members.keys()].join(" ");
        p.row = {
          ...(record ?? {
            directory,
            added: false,
            inactive: false,
            lastVisit: 0,
            order: p.members.size
              ? -Math.max(...[...p.members.values()].map((e) => e.timeUpdated))
              : 0,
          }),
          source: record ? "tracked" : p.members.size ? "index" : "template",
          inactive,
          status,
          unread: p.unread > 0,
          visitText: text,
          ageing: age,
          sessionIDs: p.ids,
          sessionCount: p.members.size,
        };
      }
      return p.row;
    },
  };
}
