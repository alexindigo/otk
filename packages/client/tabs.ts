// SPDX-License-Identifier: LGPL-3.0-only
import type {
  InboxSnapshot,
  IndexEntry,
  IndexMetadata,
  TaskRecord,
} from "@otk/protocol";
import {
  projectSessionHierarchy,
  type SessionHierarchyNode,
} from "@otk/protocol";
import {
  aggregateStatus,
  dependencyCount,
  INBOX_STATUS_PRIORITY,
  type InboxStatus,
  rollup,
} from "./inbox.ts";
import { createState, type StateFactory } from "./state.ts";
import type { RequestOptions } from "./requests.ts";
import { groupBreadcrumbs, type TaskCrumb } from "./task-breadcrumbs.ts";
import { projectTabGroups, type TabGroups } from "./tab-groups.ts";
import { attentionStatus, type OperationAttention } from "./inbox.ts";
export type TabSelection = { kind: "task"; id: string } | {
  kind: "session";
  id: string;
};
export interface InboxTab {
  kind: "task" | "phantom";
  id: string;
  title: string;
  sessions: string[];
  preview: boolean;
  status: InboxStatus;
  dependencies?: number;
}
export interface TabInput {
  /** Invalidation identity for source-free handles from the project projection. */
  version?: number;
  directory: string;
  /** Resolved checkout membership supplied by the shared project owner. */
  directories?: readonly string[];
  entries: readonly (IndexMetadata & OperationAttention)[];
  /** Borrowed cross-project ancestor context, never another metadata store. */
  context?: readonly (IndexMetadata & OperationAttention)[];
  followParent?: boolean;
  taskActivity?: Readonly<Record<string, InboxStatus>>;
  inbox: InboxSnapshot;
}
/** Promotion needs identity and naming metadata, not a replicated status row. */
export type TabSession = Pick<IndexEntry, "id" | "directory" | "title">;
export interface TabSources {
  /** Read owner-current inputs at invocation, independently of view effects. */
  input(): TabInput;
  /** Resolve a session not yet present in the streamed index. */
  session(sessionID: string): Promise<TabSession>;
}
export interface TabState {
  selected?: TabSelection;
  preview?: string;
  sessionID?: string;
  closed?: string[];
  revision: number;
}
export interface ClientTabs {
  state: TabState;
  subscribe(listener: (state: TabState) => void): () => void;
  tabs(): InboxTab[];
  /** Naming for the selected task/phantom, independent of the tab population. */
  selectedTitle(): string | undefined;
  tasks(): readonly TaskRecord[];
  crumbs(): TaskCrumb[];
  entry(id: string): (IndexMetadata & OperationAttention) | undefined;
  taskFor(id: string): TaskRecord | undefined;
  /** The same session membership used by this tab's supervision lamp. */
  belongsToTab(tabID: string, sessionID: string): boolean;
  sessionFor(taskID: string): string | undefined;
  update(input: TabInput): void;
  /** Join canonical publication; false if the owner or this borrower retires. */
  taskReady(id: string, signal?: AbortSignal): Promise<boolean>;
  select(selection: TabSelection, sessionID?: string): void;
  preview(sessionID: string): void;
  close(sessionID: string): void;
  pin(sessionID: string, options?: RequestOptions): Promise<TaskRecord>;
  rename<T>(
    sessionID: string,
    title: string,
    action: () => Promise<T>,
    options?: RequestOptions,
  ): Promise<T>;
  send<T>(
    sessionID: string,
    action: () => Promise<T>,
    options?: RequestOptions,
  ): Promise<T>;
  stop(): void;
}
/** The current idle/seen phantom is retained until selection moves elsewhere. */
export function createTabs(
  promote: (
    session: TabSession,
    options?: RequestOptions,
  ) => Promise<TaskRecord>,
  factory: StateFactory = createState,
  sources?: TabSources,
): ClientTabs {
  const store = factory<TabState>({ revision: 0 });
  const promotions = new Map<string, Promise<TaskRecord>>();
  const remembered = new Map<string, string>();
  const taskWaiters = new Map<string, Set<(ready: boolean) => void>>();
  let selectionRevision = 0, stopped = false;
  let input: TabInput = {
    directory: "",
    entries: [],
    inbox: {
      projects: [],
      tasks: [],
      seen: {},
      finishes: {},
      pathTemplates: [],
    },
  };
  const belongs = (directory: string) =>
    (input.directories ?? [input.directory]).includes(directory);
  const refresh = () => {
    if (stopped) throw new Error("Project tabs are stopped");
    if (sources) model.update(sources.input());
  };
  type Entry = IndexMetadata & OperationAttention;
  let byID = new Map<string, Entry>(), taskByID = new Map<string, TaskRecord>();
  let nodes: ReadonlyMap<string, SessionHierarchyNode> = new Map();
  let partition: TabGroups | undefined, partitionKey = "";
  let mandatory = new Set<string>();
  let entries: Entry[] = [], tasks: TaskRecord[] = [];
  let derived: TabInput | undefined;
  let cachedTabs: InboxTab[] | undefined, cachedSelection = "";
  let cachedCrumbs: TaskCrumb[] = [],
    crumbTabs: InboxTab[] | undefined,
    crumbID: string | undefined;
  const prepare = () => {
    if (derived === input) return;
    derived = input;
    const context = input.context ?? input.entries;
    const projected =
      context.every((entry) =>
          entry.hierarchy?.followParent === (input.followParent ?? false)
        )
        ? undefined
        : projectSessionHierarchy(context, input.inbox.tasks, {
          project: (directory) =>
            belongs(directory) ? input.directory : directory,
          followParent: input.followParent,
        });
    nodes = new Map(
      context.map((
        entry,
      ) => [
        entry.id,
        entry.hierarchy?.followParent === (input.followParent ?? false)
          ? entry.hierarchy
          : projected!.get(entry.id)!,
      ]),
    );
    entries = input.entries.filter((e) =>
      belongs(e.directory) ||
      nodes.get(e.id)?.projectDirectory === input.directory
    );
    const inherited = new Set(
      entries.map((entry) => nodes.get(entry.id)?.taskID),
    );
    tasks = input.inbox.tasks.filter((t) =>
      belongs(t.directory) ||
      input.followParent && inherited.has(t.id)
    );
    byID = new Map(context.map((e) => [e.id, e]));
    taskByID = new Map(tasks.map((t) => [t.id, t]));
    partition = undefined;
    mandatory = new Set(
      context.filter((entry) =>
        aggregateStatus(entry, input.inbox) !== "none" ||
        nodes.get(entry.id)?.mandatory
      ).map((entry) => entry.id),
    );
    cachedTabs = undefined;
  };
  const grouping = () => {
    prepare();
    const retained = [
      store.state.selected?.kind === "session"
        ? store.state.selected.id
        : undefined,
      store.state.preview,
    ]
      .filter((id): id is string => id !== undefined);
    const key = JSON.stringify(retained);
    if (!partition || key !== partitionKey) {
      partitionKey = key;
      partition = projectTabGroups([...byID.values()], tasks, {
        hierarchy: nodes,
        mandatory,
        retained: new Set(retained),
        directory: input.directory,
        directories: input.directories,
        followParent: input.followParent,
      });
      cachedTabs = undefined;
    }
    return partition;
  };
  function tabs(): InboxTab[] {
    // Inputs are not owned by the state factory; expose their invalidation too.
    void store.state.revision;
    // These are live resource getters, not cheap fields. Borrow one coherent
    // snapshot before walking the population or ancestry.
    const groups = grouping();
    const selection =
      `${store.state.selected?.kind}/${store.state.selected?.id}/${store.state.preview}`;
    if (cachedTabs && selection === cachedSelection) return cachedTabs;
    cachedSelection = selection;
    const { inbox, taskActivity } = input;
    const families = new Map(
      groups.groups.map((group) => [
        group.id,
        group.members.flatMap((id) => byID.has(id) ? [byID.get(id)!] : []),
      ]),
    );
    // Saved tasks and mandatory phantoms borrow the same disjoint partition.
    const activity = (id: string) =>
      byID.get(id)?.timeUpdated ?? (families.get(id) ?? []).reduce(
        (time, entry) => Math.max(time, entry.timeUpdated),
        0,
      );
    const result: InboxTab[] = tasks.map((task) => ({
      kind: "task",
      id: task.id,
      title: task.name,
      sessions: [
        ...groups.groups.find((group) =>
          group.kind === "task" && group.id === task.id
        )!.roots,
      ],
      preview: false,
      dependencies: (families.get(task.id) ?? []).reduce(
        (n, entry) => n + dependencyCount(entry, inbox),
        0,
      ),
      status: attentionStatus(
        taskActivity?.[task.id],
        rollup(
          families.get(task.id) ?? [],
          inbox,
        ),
      ),
    }));
    const candidates = new Map(entries.map((entry) => [entry.id, entry]));
    const selected = store.state.selected;
    if (selected?.kind === "session") {
      const root = byID.get(selected.id);
      if (root) candidates.set(root.id, root);
    }
    for (const entry of candidates.values()) {
      const owner = groups.owners.get(entry.id);
      if (owner?.kind !== "session" || owner.id !== entry.id) continue;
      // An ungrouped mandatory child has its own tab and its own lamp. A
      // parent's aggregate lamp is not a substitute for that visibility.
      const status = rollup([entry], inbox);
      if (
        status !== "none" || nodes.get(entry.id)?.mandatory ||
        store.state.preview === entry.id ||
        (store.state.selected?.kind === "session" &&
          store.state.selected.id === entry.id)
      ) {
        result.push({
          kind: "phantom",
          id: entry.id,
          title: entry.title,
          sessions: [entry.id],
          preview: store.state.preview === entry.id,
          status,
          dependencies: dependencyCount(entry, inbox),
        });
      }
    }
    return cachedTabs = result.sort((a, b) =>
      INBOX_STATUS_PRIORITY.indexOf(a.status) -
        INBOX_STATUS_PRIORITY.indexOf(b.status) ||
      activity(b.id) - activity(a.id) || a.id.localeCompare(b.id)
    );
  }
  const lookup = (id: string) => {
    prepare();
    return byID.get(id);
  };
  const rootFor = (id: string) => {
    return grouping().owners.get(id)?.id ?? id;
  };
  const taskFor = (id: string) => {
    const owner = grouping().owners.get(id);
    return owner?.kind === "task" ? taskByID.get(owner.id) : undefined;
  };
  const contains = (task: TaskRecord, id: string) =>
    taskFor(id)?.id === task.id;
  function sessionFor(taskID: string): string | undefined {
    const groups = grouping();
    const task = taskByID.get(taskID);
    const saved = remembered.get(taskID);
    if (task && saved && contains(task, saved)) return saved;
    const group = groups.groups.find((group) =>
      group.kind === "task" && group.id === taskID
    );
    return group?.roots[0] ?? group?.members[0];
  }
  function persist(
    sessionID: string,
    options?: RequestOptions,
    named?: TabSession,
    ready?: Promise<unknown>,
  ): Promise<TaskRecord> {
    const directories = input.directories ?? [input.directory];
    const entry = named ??
      input.entries.find((e) => e.id === sessionID && belongs(e.directory));
    const existing = input.inbox.tasks.find((t) =>
      belongs(t.directory) && t.sessions.includes(sessionID)
    );
    if (existing) return Promise.resolve(existing);
    if (!promotions.has(sessionID)) {
      // One reservation owns pin, send and rename, independently of index or
      // inbox publication. Rename supplies its captured name and native result.
      const pending = Promise.resolve().then(async () => {
        if (ready) await ready;
        const session = entry ?? await sources?.session(sessionID);
        if (stopped) throw new Error("Project tabs are stopped");
        if (
          session?.id !== sessionID || !directories.includes(session.directory)
        ) {
          throw new Error("Unknown project session");
        }
        return await promote(session, options);
      });
      promotions.set(sessionID, pending);
      void pending.catch(() => {
        if (promotions.get(sessionID) === pending) promotions.delete(sessionID);
      });
    }
    return promotions.get(sessionID)!;
  }
  const model: ClientTabs = {
    state: store.state,
    subscribe: store.subscribe,
    tabs,
    selectedTitle() {
      void store.state.revision;
      prepare();
      const selected = store.state.selected;
      return selected?.kind === "task"
        ? taskByID.get(selected.id)?.name
        : selected
        ? byID.get(selected.id)?.title
        : undefined;
    },
    tasks() {
      void store.state.revision;
      prepare();
      return tasks;
    },
    entry(id) {
      void store.state.revision;
      return lookup(id);
    },
    taskFor,
    belongsToTab(tabID, sessionID) {
      void store.state.revision;
      return grouping().owners.get(sessionID)?.id === tabID;
    },
    crumbs() {
      const rows = tabs(), id = store.state.selected?.id;
      const key = `${id}/${store.state.sessionID}`;
      if (rows === crumbTabs && key === crumbID) return cachedCrumbs;
      crumbTabs = rows;
      crumbID = key;
      const group = grouping().groups.find((group) => group.id === id);
      return cachedCrumbs = group
        ? groupBreadcrumbs(group, byID, mandatory, store.state.sessionID)
        : [];
    },
    sessionFor,
    update(next: TabInput): void {
      if (stopped) return;
      if (next.version !== undefined && input === next) return;
      const changedProject = next.directory !== input.directory;
      input = next;
      derived = undefined;
      prepare();
      if (changedProject) selectionRevision++;
      for (const task of input.inbox.tasks) {
        for (const id of task.sessions) promotions.delete(id);
      }
      store.update((draft) => {
        draft.revision++;
        const wasTask = draft.selected?.kind === "task";
        if (changedProject) {
          delete draft.selected;
          delete draft.preview;
          delete draft.sessionID;
          delete draft.closed;
        }
        if (
          draft.selected?.kind === "task" &&
          !input.inbox.tasks.some((t) =>
            t.id === draft.selected!.id &&
            tasks.some((task) => task.id === t.id)
          )
        ) delete draft.selected;
        // Metadata arrival and user preview use the same current family owner.
        // Keep the viewed identity when grouping/topology changes underneath it.
        const id = draft.sessionID;
        if (
          id &&
          input.entries.some((e) => e.id === id && belongs(e.directory))
        ) {
          const task = taskFor(id);
          draft.selected = {
            kind: task ? "task" : "session",
            // Fix 4.2 narrows D3: an independent phantom selects itself;
            // quiet children still select their nearest ancestor's group.
            id: task?.id ?? rootFor(id),
          };
          if (task) {
            remembered.set(task.id, id);
            delete draft.preview;
          } else if (draft.preview || wasTask) draft.preview = rootFor(id);
        }
        if (
          draft.selected?.kind === "session" &&
          !byID.has(draft.selected!.id)
        ) delete draft.selected;
        if (
          draft.preview &&
          !byID.has(draft.preview)
        ) delete draft.preview;
      });
      for (const [id, waiters] of taskWaiters) {
        if (!changedProject && !taskByID.has(id)) continue;
        taskWaiters.delete(id);
        for (const resolve of waiters) resolve(!changedProject);
      }
    },
    taskReady(id, signal) {
      if (stopped || signal?.aborted) return Promise.resolve(false);
      refresh();
      prepare();
      if (signal?.aborted) return Promise.resolve(false);
      if (taskByID.has(id)) return Promise.resolve(true);
      return new Promise((resolve) => {
        let waiters = taskWaiters.get(id);
        if (!waiters) taskWaiters.set(id, waiters = new Set());
        const owned = waiters;
        const finish = (ready: boolean) => {
          signal?.removeEventListener("abort", cancel);
          owned.delete(finish);
          if (!owned.size && taskWaiters.get(id) === owned) {
            taskWaiters.delete(id);
          }
          resolve(ready);
        };
        const cancel = () => finish(false);
        owned.add(finish);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
      });
    },
    select(selection: TabSelection, sessionID?: string): void {
      refresh();
      if (
        !tabs().some((tab) =>
          tab.id === selection.id &&
          (selection.kind === "task"
            ? tab.kind === "task"
            : tab.kind === "phantom")
        )
      ) throw new Error("Unknown tab");
      const task = selection.kind === "task"
        ? input.inbox.tasks.find((t) => t.id === selection.id)
        : undefined;
      const selectedID = sessionID ??
        (task ? sessionFor(task.id) : selection.id);
      if (
        selectedID &&
        (task
          ? !contains(task, selectedID)
          : rootFor(selectedID) !== selection.id)
      ) {
        throw new Error("Unknown task session");
      }
      if (task && selectedID) remembered.set(task.id, selectedID);
      selectionRevision++;
      store.update((draft) => {
        draft.selected = selection.kind === "task" ? { ...selection } : {
          kind: "session",
          id: rootFor(selectedID ?? selection.id),
        };
        draft.sessionID = selectedID;
        draft.closed = draft.closed?.filter((id) => id !== selectedID);
        delete draft.preview;
      });
    },
    preview(sessionID: string): void {
      refresh();
      if (
        !input.entries.some((e) => e.id === sessionID && belongs(e.directory))
      ) throw new Error("Unknown project session");
      const task = taskFor(sessionID);
      selectionRevision++;
      store.update((draft) => {
        draft.selected = {
          kind: task ? "task" : "session",
          id: task?.id ?? rootFor(sessionID),
        };
        draft.sessionID = sessionID;
        draft.closed = draft.closed?.filter((id) => id !== sessionID);
        if (task) remembered.set(task.id, sessionID);
        if (task) delete draft.preview;
        else draft.preview = rootFor(sessionID);
      });
    },
    async pin(
      sessionID: string,
      options?: RequestOptions,
    ): Promise<TaskRecord> {
      refresh();
      const revision = selectionRevision;
      const task = await persist(sessionID, options);
      if (!stopped && revision === selectionRevision) {
        selectionRevision++;
        store.update((draft) => {
          draft.selected = { kind: "task", id: task.id };
          draft.sessionID = sessionID;
          draft.closed = draft.closed?.filter((id) => id !== sessionID);
          delete draft.preview;
        });
      }
      return task;
    },
    async rename<T>(
      sessionID: string,
      title: string,
      action: () => Promise<T>,
      options?: RequestOptions,
    ): Promise<T> {
      refresh();
      const phantom = tabs().some((tab) =>
        tab.kind === "phantom" && tab.id === sessionID
      );
      if (!phantom) return await action();
      const named = {
        id: sessionID,
        directory: lookup(sessionID)!.directory,
        title,
      };
      const renamed = Promise.resolve().then(action);
      const promoting = persist(sessionID, options, named, renamed);
      const result = await renamed;
      await promoting;
      // Only authoritative membership reconciles selection. A late rename must
      // not select a task after the reader has moved to another session.
      return result;
    },
    close(sessionID) {
      refresh();
      selectionRevision++;
      for (const [task, id] of remembered) {
        if (id === sessionID) remembered.delete(task);
      }
      store.update((draft) => {
        draft.closed = [...new Set([...(draft.closed ?? []), sessionID])];
        if (draft.preview === sessionID) delete draft.preview;
        if (draft.sessionID === sessionID) {
          delete draft.selected;
          delete draft.sessionID;
          delete draft.preview;
        }
      });
    },
    async send<T>(
      sessionID: string,
      action: () => Promise<T>,
      options?: RequestOptions,
    ): Promise<T> {
      await this.pin(sessionID, options);
      if (stopped) throw new Error("Project tabs are stopped");
      return await action();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      selectionRevision++;
      for (const waiters of taskWaiters.values()) {
        for (const resolve of waiters) resolve(false);
      }
      taskWaiters.clear();
      promotions.clear();
      remembered.clear();
      input = {
        directory: "",
        entries: [],
        inbox: {
          projects: [],
          tasks: [],
          seen: {},
          finishes: {},
          pathTemplates: [],
        },
      };
      store.update((draft) => {
        delete draft.selected;
        delete draft.preview;
        delete draft.sessionID;
        delete draft.closed;
        draft.revision++;
      });
    },
  };
  return model;
}
