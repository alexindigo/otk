// SPDX-License-Identifier: LGPL-3.0-only
import {
  entityKey,
  type InboxSnapshot,
  type ProjectRecord,
  type ProjectSummary,
  type TaskRecord,
} from "@otk/protocol";
import {
  emphasis,
  entityState,
  type EntityStateStore,
} from "./entity-state.ts";
import { createSessionTree } from "./session-tree.ts";
import type { TabInput } from "./tabs.ts";
import type { MergedMetadata } from "./index.ts";
import {
  type InboxChanges,
  type InboxProject,
  type InboxStatus,
  projectDirectory,
} from "./inbox.ts";
import { createState, type StateFactory } from "./state.ts";
import { checkoutLabel, projectLabel } from "./project-names.ts";
import { projectPlacement } from "./project-placement.ts";
import { sidebarTimer } from "./sidebar-timer.ts";

export interface ProjectProjectionRow extends InboxProject {
  sessionIDs: string;
  sessionCount: number | null;
  summary?: ProjectSummary;
}

/** One sidecar's keyed metadata contributions. Digests never enter this owner. */
export function createProjectProjection(o: {
  entry(id: string): MergedMetadata | undefined;
  inbox?(): InboxSnapshot;
  taskActivity?(): Readonly<Record<string, InboxStatus>>;
  factory?: StateFactory;
  labelChanged?(directory: string, label: string | undefined): void;
  /** The connection's entity states: the only source of row attention. */
  entities?(): EntityStateStore;
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
    directory: string;
  }>();
  const repoSessions = new Map<string, Set<string>>();
  const projects = new Map<string, {
    members: Map<string, MergedMetadata>;
    record?: ProjectRecord;
    summary?: ProjectSummary;
    discovered: boolean;
    ids?: string;
    row?: ProjectProjectionRow;
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
  let summaries: Readonly<Record<string, ProjectSummary>> = {};
  const resolve = (directory: string, repoID?: string): string => {
    void clock.state.revision;
    return projectDirectory(directory, summaries, repoID);
  };
  const facts = (directory: string) => {
    void clock.state.keys[directory];
    return summaries[directory];
  };
  const label = (directory: string) =>
    checkoutLabel(directory, facts(directory));
  const scopes = (directory: string): readonly string[] => {
    void clock.state.keys[directory];
    const p = projects.get(directory);
    return [
      ...new Set([
        directory,
        ...p?.summary?.scopes ?? [],
        ...[...p?.members.values() ?? []].map((e) => e.directory),
        ...p?.tasks.map((t) => t.directory) ?? [],
      ]),
    ].sort();
  };
  const visible = new Set<string>();
  const ensure = (directory: string) => {
    let p = projects.get(directory);
    if (!p) {
      p = {
        members: new Map(),
        discovered: false,
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
      const present =
        !!(p.members.size || p.tasks.length || p.record?.inactive ||
          p.discovered ||
          p.summary?.hasSessions || p.summary?.locationForms ||
          p.summary?.dependencies ||
          (p.summary?.sessionCount ?? 0) > 0 ||
          p.summary && p.summary.hasSessions === undefined);
      if (!present && !p.tasks.length) {
        projects.delete(directory);
      }
      if (visible.has(directory) !== present) {
        if (present) visible.add(directory);
        else visible.delete(directory);
      }
      o.labelChanged?.(
        directory,
        present ? checkoutLabel(directory, p.summary) : undefined,
      );
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
      const directory = entry && resolve(entry.directory, entry.projectID);
      if (before?.entry === entry && before?.directory === directory) continue;
      changed.add(id);
      if (before) {
        repoSessions.get(before.entry.projectID)?.delete(id);
        const p = ensure(before.directory);
        if (
          !entry || directory !== before.directory ||
          entry.directory !== before.entry.directory ||
          entry.parentID !== before.entry.parentID ||
          entry.title !== before.entry.title
        ) p.structure = undefined;
        if (!entry || directory !== before.directory) {
          p.members.delete(id);
          p.ids = undefined;
        }
        dirty.add(before.directory);
      }
      if (entry) {
        const repo = repoSessions.get(entry.projectID) ?? new Set<string>();
        repo.add(id);
        repoSessions.set(entry.projectID, repo);
        const p = ensure(directory!);
        if (
          !before || directory !== before.directory ||
          entry.directory !== before.entry.directory
        ) {
          p.structure = undefined;
        }
        if (!p.members.has(id)) p.ids = undefined;
        p.members.set(id, entry);
        sessions.set(id, { entry, directory: directory! });
        dirty.add(directory!);
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
  const activity = (directory: string) => {
    const p = ensure(directory), source = o.taskActivity?.() ?? {};
    if (p.activitySource !== source) {
      p.activitySource = source;
      const next: Record<string, InboxStatus> = {};
      for (const task of p.tasks) {
        if (source[task.id]) next[task.id] = source[task.id];
      }
      if (
        Object.keys({ ...p.activity, ...next }).some((id) =>
          p.activity[id] !== next[id]
        )
      ) {
        p.activity = next;
        p.input = undefined;
      }
    }
    return p.activity;
  };
  const projectIdentity = (directory: string, repoID?: string) => {
    const leaf = resolve(directory, repoID), summary = facts(leaf);
    const root = summary?.topology?.canonicalRoot;
    const canonical = root && root !== leaf ? facts(root) : undefined;
    const color = (canonical ?? summary)?.presentation?.color;
    return {
      name: canonical ? label(root!) : projectLabel(leaf, summary),
      ...(color && { color }),
    };
  };
  return {
    update,
    resolve,
    scopes,
    label(directory: string) {
      return label(resolve(directory));
    },
    projectLabel(directory: string) {
      return projectIdentity(directory).name;
    },
    projectIdentity,
    entry(id: string) {
      void entryClock.state.keys[id];
      return sessions.get(id)?.entry;
    },
    input(directory: string): TabInput {
      directory = resolve(directory);
      void clock.state.keys[directory];
      const p = ensure(directory);
      activity(directory);
      if (!p.input) {
        p.input = {
          version: clock.state.keys[directory] ?? 0,
          directory,
          directories: scopes(directory),
          get entries() {
            void clock.state.keys[directory];
            const current = ensure(directory);
            return current.metadata ??= [...current.members.values()];
          },
          get taskActivity() {
            void clock.state.keys[directory];
            return activity(directory);
          },
          get inbox() {
            return o.inbox?.() ?? inbox;
          },
          get entities() {
            return o.entities?.();
          },
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
        scopes(directory),
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
      const repos = new Set<string>();
      summaries = next.summaries ?? {};
      for (
        const directory of !changes || changes.baseline
          ? new Set([...projects.keys(), ...Object.keys(next.summaries ?? {})])
          : changes.projects
      ) {
        const p = ensure(directory), summary = next.summaries?.[directory];
        if (
          JSON.stringify([
            p.summary?.topology,
            p.summary?.scopes,
            p.summary?.memberships,
          ]) !==
            JSON.stringify([
              summary?.topology,
              summary?.scopes,
              summary?.memberships,
            ])
        ) {
          for (const topology of [p.summary?.topology, summary?.topology]) {
            if (topology) repos.add(topology.repoID);
          }
          for (
            const membership of [
              ...p.summary?.memberships ?? [],
              ...summary?.memberships ?? [],
            ]
          ) repos.add(membership.repoID);
        }
        if (JSON.stringify(p.summary) !== JSON.stringify(summary)) {
          p.summary = summary;
          dirty.add(directory);
        }
      }
      const reroute = repos.size > 0;
      if (!changes || changes.baseline || changes.tasks || reroute) {
        const tasks = new Map<string, TaskRecord[]>();
        for (const task of next.tasks) {
          const directory = resolve(task.directory);
          const list = tasks.get(directory) ?? [];
          list.push(task);
          tasks.set(directory, list);
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
        changes.projects.length || reroute
      ) {
        const records = new Map<string, ProjectRecord>();
        for (const record of next.projects) {
          const directory = resolve(record.directory);
          if (!records.has(directory) || directory === record.directory) {
            records.set(directory, { ...record, directory });
          }
        }
        const discovered = new Set(
          (next.discovered ?? []).map((d) => resolve(d)),
        );
        for (
          const directory
            of changes && !changes.baseline && !changes.discovery && !reroute
              ? changes.projects.map((d) => resolve(d))
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
      for (const repo of repos) {
        for (const id of repoSessions.get(repo) ?? []) ids.add(id);
      }
      if (!changes || changes.baseline) {
        for (const field of ["seen", "finishes"] as const) {
          for (
            const id of new Set([
              ...Object.keys(inbox[field] ?? {}),
              ...Object.keys(next[field] ?? {}),
            ])
          ) {
            if (inbox[field]?.[id] !== next[field]?.[id]) {
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
    /** Rows re-read the entity states the inbox accepted for them. */
    entities(keys: readonly string[] | "all") {
      const dirty = new Set<string>();
      const prefix = entityKey("project", "");
      for (const directory of projects.keys()) {
        if (keys === "all" || keys.includes(prefix + directory)) {
          dirty.add(directory);
        }
      }
      publish(dirty);
    },
    directories() {
      void clock.state.revision;
      return [...visible];
    },
    row(directory: string, now: number) {
      void clock.state.keys[directory];
      const p = projects.get(directory);
      if (!p) return undefined;
      const summary = p.summary;
      const parent = summary?.topology?.parentDirectory;
      const parentLabel = parent ? label(parent) : undefined;
      const summaryReady = summary !== undefined;
      // Decision 62: the project entity is the row's state; absent or stale
      // state is grey (D6).
      const store = o.entities?.(), key = entityKey("project", directory);
      const status = store ? entityState(store, key) : "none";
      const entity = store && !store.isStale ? store.get(key) : undefined;
      const dependencies = entity?.dependencies;
      const unread = store ? emphasis(store, key) : false;
      const record = p.record;
      const archived = summary?.archived === true;
      const inactive = !!record?.inactive && status === "none";
      const hasSessions = summary?.hasSessions ??
        (summary?.sessionCount != null
          ? summary.sessionCount > 0
          : p.members.size > 0 || summaryReady);
      const placement = projectPlacement({
        lifecycle: summary,
        status,
        dependencies,
        liveWork: entity?.liveWork,
        inactive: !!record?.inactive,
        hasSessions,
      });
      const timer = sidebarTimer(status, entity?.runStartedAt, now, record);
      if (
        !p.row || p.row.timer?.kind !== timer?.kind ||
        p.row.timer?.time.iso !== timer?.time.iso ||
        p.row.timer?.time.spoken !== timer?.time.spoken ||
        p.row.status !== status ||
        p.row.section !== placement.section ||
        p.row.unread !== unread || p.row.dependencies !== dependencies ||
        p.row.parentLabel !== parentLabel
      ) {
        p.ids ??= [...p.members.keys()].join(" ");
        p.row = {
          ...(record ?? {
            directory,
            added: false,
            inactive: false,
            lastVisit: 0,
          }),
          source: record ? "tracked" : p.summary?.hasSessions ||
              (p.summary?.sessionCount ?? p.members.size) > 0 ||
              (p.summary?.sessionCount === null && summaryReady)
            ? "index"
            : "template",
          ...placement,
          group: placement.section === "live" ? "active" : placement.section,
          inactive,
          archived,
          status,
          dependencies,
          unread,
          unseenCount: store && !store.isStale
            ? store.get(key)?.counts.unseen ?? 0
            : null,
          timer,
          sessionIDs: p.ids,
          sessionCount: p.summary ? p.summary.sessionCount : p.members.size,
          summary: p.summary,
          topology: p.summary?.topology,
          availability: p.summary?.availability,
          ...(parent ? { depth: 1, parentLabel } : {}),
        };
      }
      return p.row;
    },
  };
}
