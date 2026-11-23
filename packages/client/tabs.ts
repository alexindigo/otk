// SPDX-License-Identifier: LGPL-3.0-only
import type {
  InboxSnapshot,
  IndexEntry,
  IndexMetadata,
  SessionListRow,
  TaskRecord,
} from "@otk/protocol";
import {
  entityKey,
  sessionAncestors,
  type SessionHierarchyNode,
  taskEntityID,
} from "@otk/protocol";
import type { InboxStatus } from "./inbox.ts";
import {
  createEntityStateStore,
  entityState,
  type EntityStateStore,
  lamp,
} from "./entity-state.ts";
import { createStableOrder } from "./stable-order.ts";
import { createState, type StateFactory } from "./state.ts";
import type { RequestOptions } from "./requests.ts";
import { groupBreadcrumbs, type TaskCrumb } from "./task-breadcrumbs.ts";
import {
  projectTabGroups,
  resolveTabHierarchy,
  type TabGroups,
} from "./tab-groups.ts";
import type { OperationAttention } from "./inbox.ts";
import { runningDescendants } from "./live-work.ts";
export interface FamilyCrumb extends TaskCrumb {
  status: InboxStatus;
}
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
}
export interface TabInput {
  /** Invalidation identity for source-free handles from the project projection. */
  version?: number;
  /** Source availability for standalone snapshots. Live callers borrow the
   * entity replica's freshness; native work inventory also uses this hint. */
  connected?: boolean;
  directory: string;
  /** Resolved checkout membership supplied by the shared project owner. */
  directories?: readonly string[];
  entries: readonly (IndexMetadata & OperationAttention)[];
  /** Borrowed cross-project ancestor context, never another metadata store. */
  context?: readonly (IndexMetadata & OperationAttention)[];
  followParent?: boolean;
  taskActivity?: Readonly<Record<string, InboxStatus>>;
  entities?: EntityStateStore;
  inbox: InboxSnapshot;
}
/** Promotion needs identity and naming metadata, not a replicated status row. */
export type TabSession = Pick<
  IndexEntry,
  "id" | "directory" | "title" | "parentID"
>;
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
  entities(): EntityStateStore;
  tabEntityKey(tab: Pick<InboxTab, "id" | "kind">): string;
  subscribe(listener: (state: TabState) => void): () => void;
  tabs(): InboxTab[];
  /** Naming for the selected task/phantom, independent of the tab population. */
  selectedTitle(): string | undefined;
  tasks(): readonly TaskRecord[];
  orderRows(rows: readonly SessionListRow[]): SessionListRow[];
  /** Pointer, keyboard and portalled interactions share this ordering lifetime. */
  holdOrder(): () => void;
  crumbs(): TaskCrumb[];
  /** Open-session identity and known ancestor links, independent of activity. */
  path(): TaskCrumb[];
  /** Explicit members and mandatory descendants, with their own session state. */
  family(): FamilyCrumb[];
  /** Canonical running helpers shared by the breadcrumb trail and composer. */
  working(): TaskCrumb[];
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
  let standaloneSnapshot: InboxSnapshot["entities"];
  const standalone = createEntityStateStore({
    read: () => standaloneSnapshot,
    factory,
  });
  const entities = () => input.entities ?? standalone;
  const sessionState = (id: string) =>
    lamp(entities(), entityKey("session", id), { now: performance.now() });
  const groupKey = (id: string, kind: "task" | "session") =>
    entityKey(
      "task",
      taskEntityID(id, input.followParent, input.directory, kind),
    );
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
  let derivedEntities = -1;
  let cachedTabs: InboxTab[] | undefined, cachedSelection = "";
  const ordering = createStableOrder<InboxTab>(() => {
    cachedTabs = undefined;
    store.update((s) => s.revision++);
  });
  let cachedCrumbs: TaskCrumb[] = [],
    cachedPath: TaskCrumb[] = [],
    cachedFamily: FamilyCrumb[] = [],
    cachedWorking: TaskCrumb[] = [],
    crumbTabs: InboxTab[] | undefined,
    crumbID: string | undefined;
  const prepare = () => {
    const revision = entities().revision;
    if (derived === input && derivedEntities === revision) return;
    derived = input;
    derivedEntities = revision;
    const context = input.context ?? input.entries;
    nodes = resolveTabHierarchy(context, input.inbox.tasks, {
      project: (directory) => belongs(directory) ? input.directory : directory,
      followParent: input.followParent,
    });
    entries = input.entries.filter((e) =>
      belongs(e.directory) ||
      nodes.get(e.id)?.projectDirectory === input.directory
    );
    const inherited = new Set(
      entries.map((entry) => nodes.get(entry.id)?.taskID),
    );
    const roots = new Set(entries.map((entry) => nodes.get(entry.id)?.rootID));
    tasks = input.inbox.tasks.filter((t) =>
      belongs(t.directory) ||
      input.followParent &&
        (inherited.has(t.id) || t.sessions.some((id) => roots.has(id)))
    );
    byID = new Map(context.map((e) => [e.id, e]));
    taskByID = new Map(tasks.map((t) => [t.id, t]));
    partition = undefined;
    mandatory = new Set(
      context.filter((entry) => {
        const status = entityState(entities(), entityKey("session", entry.id));
        return status !== "none" || nodes.get(entry.id)?.mandatory;
      }).map((entry) => entry.id),
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
    // Saved tasks and mandatory phantoms borrow the same disjoint partition.
    const result: InboxTab[] = tasks.filter((task) =>
      groups.groups.some((group) =>
        group.kind === "task" && group.id === task.id
      )
    ).map((task) => ({
      kind: "task",
      id: task.id,
      title: task.name,
      sessions: [
        ...groups.groups.find((group) =>
          group.kind === "task" && group.id === task.id
        )!.roots,
      ],
      preview: false,
      status: lamp(entities(), groupKey(task.id, "task"), {
        now: performance.now(),
      }),
    }));
    for (const owner of groups.groups) {
      if (owner.kind !== "session") continue;
      const entry = byID.get(owner.id);
      if (!entry) continue;
      const status = lamp(entities(), groupKey(owner.id, "session"), {
        now: performance.now(),
      });
      if (
        status !== "none" || owner.members.some((id) => mandatory.has(id)) ||
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
        });
      }
    }
    return cachedTabs = ordering.order(
      result,
      (tab) => ({
        position: taskByID.get(tab.id)?.order,
        created: tab.kind === "phantom"
          ? byID.get(tab.id)?.timeCreated
          : undefined,
      }),
    );
  }
  const lookup = (id: string) => {
    prepare();
    return byID.get(id);
  };
  const rootFor = (id: string) => {
    return grouping().owners.get(id)?.id;
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
    const owner = taskFor(sessionID);
    if (owner) return Promise.resolve(owner);
    const root = nodes.get(sessionID)?.rootID;
    if (root && root !== sessionID) return persist(root, options);
    const directories = input.directories ?? [input.directory];
    const entry = named ??
      input.entries.find((e) => e.id === sessionID && belongs(e.directory));
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
        if (session.parentID) {
          throw new Error("Task ancestry is not available yet");
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
    entities,
    tabEntityKey: (tab) =>
      groupKey(tab.id, tab.kind === "task" ? "task" : "session"),
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
      const order = new Map(tabs().map((tab, i) => [tab.id, i]));
      return tasks.filter((task) => order.has(task.id)).sort((a, b) =>
        order.get(a.id)! - order.get(b.id)!
      );
    },
    holdOrder() {
      tabs();
      return ordering.hold();
    },
    orderRows(rows) {
      void store.state.revision;
      return ordering.sequence("sessions", rows, (row) => row.key);
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
      const key = `${id}/${store.state.sessionID}/${input.connected !== false}`;
      if (rows === crumbTabs && key === crumbID) return cachedCrumbs;
      crumbTabs = rows;
      crumbID = key;
      const group = grouping().groups.find((group) => group.id === id);
      const current = store.state.sessionID;
      const path = current
        ? [
          ...sessionAncestors(current, (id) => byID.get(id)).toReversed(),
          current,
        ].filter((id) => byID.has(id))
        : [];
      const local = group
        ? groupBreadcrumbs(group, byID, mandatory, store.state.sessionID)
        : path.map((id, depth): TaskCrumb => ({
          id,
          kind: "member",
          helper: !!byID.get(id)?.parentID,
          depth,
        }));
      const familyState = sessionState;
      cachedFamily = local.filter((crumb) => crumb.kind !== "ancestor").map((
        crumb,
      ) => ({
        ...crumb,
        status: familyState(crumb.id),
      })).filter((crumb) =>
        !crumb.helper || crumb.status !== "none" || mandatory.has(crumb.id)
      );
      cachedWorking = runningDescendants(
        current,
        [...byID.values()],
        input.connected !== false,
      );
      cachedPath = path.flatMap((id) =>
        local.filter((crumb) => crumb.id === id)
      );
      return cachedCrumbs = [
        ...cachedPath,
        ...local.filter((crumb) =>
          !path.includes(crumb.id) &&
          (!current || mandatory.has(crumb.id) ||
            familyState(crumb.id) !== "none")
        ),
      ];
    },
    path() {
      this.crumbs();
      return cachedPath;
    },
    family() {
      this.crumbs();
      return cachedFamily;
    },
    working() {
      this.crumbs();
      return cachedWorking;
    },
    sessionFor,
    update(next: TabInput): void {
      if (stopped) return;
      if (next.version !== undefined && input === next) return;
      const changedProject = next.directory !== input.directory;
      if (changedProject) ordering.reset();
      input = next;
      if (!input.entities) {
        standaloneSnapshot = input.inbox.entities;
        standalone.stale(input.connected === false);
        standalone.observe("all", "historical");
      }
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
          const root = rootFor(id);
          draft.selected = root
            ? {
              kind: task ? "task" : "session",
              id: root,
            }
            : undefined;
          if (task) {
            remembered.set(task.id, id);
            delete draft.preview;
          } else if (draft.preview || wasTask) draft.preview = root;
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
        ) || selection.kind === "task" && !taskByID.has(selection.id)
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
          id: rootFor(selectedID ?? selection.id)!,
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
        const root = rootFor(sessionID);
        draft.selected = root
          ? {
            kind: task ? "task" : "session",
            id: root,
          }
          : undefined;
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
      ordering.stop();
      standalone.stop();
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
