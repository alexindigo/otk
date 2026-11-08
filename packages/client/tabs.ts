// SPDX-License-Identifier: LGPL-3.0-only
import type {
  InboxSnapshot,
  IndexEntry,
  IndexMetadata,
  TaskRecord,
} from "@otk/protocol";
import { INBOX_STATUS_PRIORITY, type InboxStatus, rollup } from "./inbox.ts";
import { createState, type StateFactory } from "./state.ts";
import { sessionFamily } from "./session-tree.ts";
import type { RequestOptions } from "./requests.ts";
import { taskBreadcrumbs, type TaskCrumb } from "./task-breadcrumbs.ts";
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
}
export interface TabInput {
  /** Invalidation identity for source-free handles from the project projection. */
  version?: number;
  directory: string;
  entries: readonly (IndexMetadata & OperationAttention)[];
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
  crumbs(): TaskCrumb[];
  entry(id: string): (IndexMetadata & OperationAttention) | undefined;
  taskFor(id: string): TaskRecord | undefined;
  sessionFor(taskID: string): string | undefined;
  update(input: TabInput): void;
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
  const refresh = () => {
    if (stopped) throw new Error("Project tabs are stopped");
    if (sources) model.update(sources.input());
  };
  type Entry = IndexMetadata & OperationAttention;
  let byID = new Map<string, Entry>(), taskByID = new Map<string, TaskRecord>();
  let explicit = new Map<string, TaskRecord>(),
    ancestry = new Map<string, string[]>();
  let ownership = new Map<string, TaskRecord | undefined>();
  let familyKeys = new Map<string, string>();
  let children = new Map<string, Entry[]>(),
    families = new Map<string, Entry[]>();
  let entries: Entry[] = [], tasks: TaskRecord[] = [];
  let derived: TabInput | undefined;
  let cachedTabs: InboxTab[] | undefined, cachedSelection = "";
  let cachedCrumbs: TaskCrumb[] = [],
    crumbTabs: InboxTab[] | undefined,
    crumbID: string | undefined;
  const prepare = () => {
    if (derived === input) return;
    derived = input;
    entries = input.entries.filter((e) => e.directory === input.directory);
    tasks = input.inbox.tasks.filter((t) => t.directory === input.directory);
    byID = new Map(entries.map((e) => [e.id, e]));
    taskByID = new Map(tasks.map((t) => [t.id, t]));
    explicit = new Map();
    ancestry = new Map();
    ownership = new Map();
    familyKeys = new Map();
    children = new Map();
    families = new Map();
    for (const task of tasks) {
      for (const id of task.sessions) {
        if (!explicit.has(id)) explicit.set(id, task);
      }
    }
    for (const entry of entries) {
      if (entry.parentID) {
        const list = children.get(entry.parentID) ?? [];
        list.push(entry);
        children.set(entry.parentID, list);
      }
    }
    const resolve = (start: string) => {
      const path: string[] = [], seen = new Set<string>();
      let id: string | undefined = start, task: TaskRecord | undefined;
      while (id && !familyKeys.has(id) && !seen.has(id)) {
        path.push(id);
        seen.add(id);
        task = explicit.get(id);
        if (task) break;
        id = byID.get(id)?.parentID;
      }
      task ??= id ? ownership.get(id) : undefined;
      const key = task?.id ?? (id && familyKeys.get(id)) ?? path.at(-1)!;
      for (const id of path) {
        ownership.set(id, task);
        familyKeys.set(id, key);
      }
      return key;
    };
    for (const entry of entries) {
      const key = familyKeys.get(entry.id) ?? resolve(entry.id);
      const list = families.get(key) ?? [];
      list.push(entry);
      families.set(key, list);
    }
    cachedTabs = undefined;
  };
  function tabs(): InboxTab[] {
    // Inputs are not owned by the state factory; expose their invalidation too.
    void store.state.revision;
    // These are live resource getters, not cheap fields. Borrow one coherent
    // snapshot before walking the population or ancestry.
    prepare();
    const selection =
      `${store.state.selected?.kind}/${store.state.selected?.id}/${store.state.preview}`;
    if (cachedTabs && selection === cachedSelection) return cachedTabs;
    cachedSelection = selection;
    const { inbox, taskActivity } = input;
    const grouped = explicit;
    // Nearest explicit membership owns the whole inherited family. Helpers can
    // contribute work/attention, but cannot create a competing phantom tab.
    const activity = (id: string) =>
      (families.get(id) ?? []).reduce(
        (time, entry) => Math.max(time, entry.timeUpdated),
        0,
      );
    const result: InboxTab[] = tasks.map((task) => ({
      kind: "task",
      id: task.id,
      title: task.name,
      sessions: [...task.sessions],
      preview: false,
      status: attentionStatus(
        taskActivity?.[task.id],
        rollup(
          families.get(task.id) ?? [],
          inbox,
        ),
      ),
    }));
    for (const entry of entries) {
      if (entry.parentID || grouped.has(entry.id)) continue;
      const status = rollup(families.get(entry.id) ?? [entry], inbox);
      if (
        status !== "idle" || store.state.preview === entry.id ||
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
    prepare();
    let path = ancestry.get(id);
    if (!path) ancestry.set(id, path = sessionFamily(id, (id) => byID.get(id)));
    return path.at(-1)!;
  };
  const taskFor = (id: string) => {
    prepare();
    return ownership.get(id) ?? explicit.get(id);
  };
  const contains = (task: TaskRecord, id: string) =>
    taskFor(id)?.id === task.id;
  function sessionFor(taskID: string): string | undefined {
    prepare();
    const task = taskByID.get(taskID);
    const saved = remembered.get(taskID);
    if (task && saved && contains(task, saved)) return saved;
    return task?.sessions[0];
  }
  function persist(
    sessionID: string,
    options?: RequestOptions,
    named?: TabSession,
    ready?: Promise<unknown>,
  ): Promise<TaskRecord> {
    const directory = named?.directory ?? input.directory;
    const entry = named ??
      input.entries.find((e) =>
        e.id === sessionID && e.directory === directory
      );
    const existing = input.inbox.tasks.find((t) =>
      t.directory === directory && t.sessions.includes(sessionID)
    );
    if (existing) return Promise.resolve(existing);
    if (!promotions.has(sessionID)) {
      // One reservation owns pin, send and rename, independently of index or
      // inbox publication. Rename supplies its captured name and native result.
      const pending = Promise.resolve().then(async () => {
        if (ready) await ready;
        const session = entry ?? await sources?.session(sessionID);
        if (stopped) throw new Error("Project tabs are stopped");
        if (session?.id !== sessionID || session.directory !== directory) {
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
    entry(id) {
      void store.state.revision;
      return lookup(id);
    },
    taskFor,
    crumbs() {
      const rows = tabs(), id = store.state.selected?.id;
      if (rows === crumbTabs && id === crumbID) return cachedCrumbs;
      crumbTabs = rows;
      crumbID = id;
      const tab = rows.find((t) => t.id === id);
      const task = taskByID.get(id ?? "") ??
        (tab &&
          { id: tab.id, directory: input.directory, sessions: tab.sessions });
      return cachedCrumbs = task
        ? taskBreadcrumbs(task, entries, tasks, children)
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
            t.id === draft.selected!.id && t.directory === input.directory
          )
        ) delete draft.selected;
        // Metadata arrival and user preview use the same current family owner.
        // Keep the viewed identity when grouping/topology changes underneath it.
        const id = draft.sessionID;
        if (
          id &&
          input.entries.some((e) =>
            e.id === id && e.directory === input.directory
          )
        ) {
          const task = taskFor(id);
          draft.selected = {
            kind: task ? "task" : "session",
            id: task?.id ?? rootFor(id),
          };
          if (task) {
            remembered.set(task.id, id);
            delete draft.preview;
          } else if (draft.preview || wasTask) draft.preview = rootFor(id);
        }
        if (
          draft.selected?.kind === "session" &&
          !input.entries.some((e) =>
            e.id === draft.selected!.id && e.directory === input.directory
          )
        ) delete draft.selected;
        if (
          draft.preview &&
          !input.entries.some((e) =>
            e.id === draft.preview && e.directory === input.directory
          )
        ) delete draft.preview;
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
        draft.selected = { ...selection };
        draft.sessionID = selectedID;
        draft.closed = draft.closed?.filter((id) => id !== selectedID);
        delete draft.preview;
      });
    },
    preview(sessionID: string): void {
      refresh();
      if (
        !input.entries.some((e) =>
          e.id === sessionID && e.directory === input.directory
        )
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
      const named = { id: sessionID, directory: input.directory, title };
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
