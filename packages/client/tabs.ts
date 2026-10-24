// SPDX-License-Identifier: LGPL-3.0-only
import type { InboxSnapshot, IndexEntry, TaskRecord } from "@otk/protocol";
import { belongsToSession } from "@otk/protocol";
import { type InboxStatus, inboxStatus, rollup } from "./inbox.ts";
import { createState, type StateFactory } from "./state.ts";
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
  directory: string;
  entries: readonly IndexEntry[];
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
  revision: number;
}
export interface ClientTabs {
  state: TabState;
  subscribe(listener: (state: TabState) => void): () => void;
  tabs(): InboxTab[];
  sessionFor(taskID: string): string | undefined;
  update(input: TabInput): void;
  select(selection: TabSelection, sessionID?: string): void;
  preview(sessionID: string): void;
  pin(sessionID: string): Promise<TaskRecord>;
  send<T>(sessionID: string, action: () => Promise<T>): Promise<T>;
  stop(): void;
}
/** The current idle/seen phantom is retained until selection moves elsewhere. */
export function createTabs(
  promote: (session: TabSession) => Promise<TaskRecord>,
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
  function tabs(): InboxTab[] {
    // Inputs are not owned by the state factory; expose their invalidation too.
    void store.state.revision;
    const tasks = input.inbox.tasks.filter((task) =>
      task.directory === input.directory
    ).sort((a, b) => a.order - b.order);
    const grouped = new Set(tasks.flatMap((task) => task.sessions));
    const entries = input.entries.filter((e) =>
      e.directory === input.directory
    );
    const result: InboxTab[] = tasks.map((task) => ({
      kind: "task",
      id: task.id,
      title: task.name,
      sessions: [...task.sessions],
      preview: false,
      status: rollup(
        entries.filter((e) => task.sessions.includes(e.id)),
        input.inbox,
      ),
    }));
    for (const entry of entries) {
      if (grouped.has(entry.id)) continue;
      const status = inboxStatus(entry, input.inbox);
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
    return result;
  }
  const contains = (task: TaskRecord, id: string) =>
    task.sessions.some((root) =>
      belongsToSession(
        id,
        root,
        (id) =>
          input.entries.find((e) =>
            e.id === id && e.directory === task.directory
          ),
      )
    );
  function sessionFor(taskID: string): string | undefined {
    const task = input.inbox.tasks.find((t) => t.id === taskID);
    const saved = remembered.get(taskID);
    if (task && saved && contains(task, saved)) return saved;
    return task?.sessions[0];
  }
  const model: ClientTabs = {
    state: store.state,
    subscribe: store.subscribe,
    tabs,
    sessionFor,
    update(next: TabInput): void {
      if (stopped) return;
      const changedProject = next.directory !== input.directory;
      input = next;
      if (changedProject) selectionRevision++;
      for (const task of input.inbox.tasks) {
        for (const id of task.sessions) promotions.delete(id);
      }
      store.update((draft) => {
        draft.revision++;
        if (changedProject) {
          delete draft.selected;
          delete draft.preview;
          delete draft.sessionID;
        }
        if (draft.selected?.kind === "session") {
          const task = input.inbox.tasks.find((t) =>
            t.directory === input.directory &&
            t.sessions.includes(draft.selected!.id)
          );
          if (task) {
            draft.selected = { kind: "task", id: task.id };
            delete draft.preview;
          }
        }
        if (
          draft.selected?.kind === "task" &&
          !input.inbox.tasks.some((t) =>
            t.id === draft.selected!.id && t.directory === input.directory
          )
        ) delete draft.selected;
        if (draft.selected?.kind === "task" && draft.sessionID) {
          const task = input.inbox.tasks.find((t) =>
            t.id === draft.selected!.id
          )!;
          if (!contains(task, draft.sessionID)) {
            draft.selected = { kind: "session", id: draft.sessionID };
          }
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
      if (task && selectedID && !contains(task, selectedID)) {
        throw new Error("Unknown task session");
      }
      if (task && selectedID) remembered.set(task.id, selectedID);
      selectionRevision++;
      store.update((draft) => {
        draft.selected = { ...selection };
        draft.sessionID = selectedID;
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
      const task =
        input.inbox.tasks.find((t) =>
          t.directory === input.directory && t.sessions.includes(sessionID)
        ) ?? input.inbox.tasks.find((t) =>
          t.directory === input.directory && contains(t, sessionID)
        );
      selectionRevision++;
      store.update((draft) => {
        draft.selected = {
          kind: task ? "task" : "session",
          id: task?.id ?? sessionID,
        };
        draft.sessionID = sessionID;
        if (task) remembered.set(task.id, sessionID);
        if (task) delete draft.preview;
        else draft.preview = sessionID;
      });
    },
    async pin(sessionID: string): Promise<TaskRecord> {
      refresh();
      const directory = input.directory;
      const entry = input.entries.find((e) =>
        e.id === sessionID && e.directory === directory
      );
      const revision = selectionRevision;
      const existing = input.inbox.tasks.find((t) =>
        t.directory === directory && t.sessions.includes(sessionID)
      );
      if (!existing && !promotions.has(sessionID)) {
        // Index delivery and UI projection are not command acknowledgements.
        // Share the whole resolution/promotion, retaining its invocation scope.
        const pending = Promise.resolve().then(async () => {
          const session = entry ?? await sources?.session(sessionID);
          if (stopped) throw new Error("Project tabs are stopped");
          if (session?.id !== sessionID || session.directory !== directory) {
            throw new Error("Unknown project session");
          }
          return await promote(session);
        });
        promotions.set(sessionID, pending);
        void pending.catch(() => {
          if (promotions.get(sessionID) === pending) {
            promotions.delete(sessionID);
          }
        });
      }
      const task = existing ?? await promotions.get(sessionID)!;
      if (!stopped && revision === selectionRevision) {
        selectionRevision++;
        store.update((draft) => {
          draft.selected = { kind: "task", id: task.id };
          draft.sessionID = sessionID;
          delete draft.preview;
        });
      }
      return task;
    },
    async send<T>(sessionID: string, action: () => Promise<T>): Promise<T> {
      await this.pin(sessionID);
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
        ...input,
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
        draft.revision++;
      });
    },
  };
  return model;
}
