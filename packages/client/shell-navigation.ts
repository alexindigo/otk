// SPDX-License-Identifier: LGPL-3.0-only
import { errorMessage } from "@otk/protocol";
import type { ProjectLocation, TaskRecord } from "@otk/protocol";
import type { InputGuard } from "./input-guard.ts";
import type { Drafts } from "./drafts.ts";
import { sessionKey } from "./index.ts";
import { inboxStatus } from "./inbox.ts";
import { createNavigation, type NavigationEnvironment } from "./navigation.ts";
import {
  projectHash,
  projectRoute,
  type ProjectSelection,
} from "./project-navigation.ts";
import type { ServerResources } from "./server-resources.ts";
import type { SessionActions } from "./session-actions.ts";
import {
  type ClientSession,
  hashFor,
  route,
  type Selection,
} from "./session.ts";
import { createState, type StateFactory } from "./state.ts";
import { LOCAL_SIDECAR } from "./sidecars.ts";

export interface ShellNavigationState {
  project?: ProjectSelection;
  settings: boolean;
  error: string;
}
export interface ShellView {
  selected?: Selection;
  directory?: string;
  loading: boolean;
  settings: boolean;
  connected: boolean;
  finish: number;
}
export interface ShellNavigation {
  state: ShellNavigationState;
  subscribe(listener: (state: ShellNavigationState) => void): () => void;
  navigate(selection: Selection): boolean;
  openProject(project: ProjectSelection): void;
  openChild(id: string): void;
  projectHome(): boolean;
  preview(target: Selection): boolean;
  pin(target: Selection): Promise<boolean>;
  close(target?: Selection): Promise<boolean>;
  remove(target: Selection): Promise<boolean>;
  available(input?: ProjectSelection): boolean;
  create(input?: ProjectSelection): Promise<void>;
  createIn(
    sidecarId: string,
    directory: string,
    task?: TaskRecord,
  ): Promise<void>;
  showSettings(): void;
  closeSettings(): void;
  fail(error: unknown): void;
  clearError(): void;
  removeServer(id: string): boolean;
  observeView(view: ShellView): void;
  start(): void;
  stop(): void;
}
/** One owner for accepted routes, creation intents and viewed-session bookkeeping. */
export function createShellNavigation(o: {
  resources: ServerResources;
  actions: SessionActions;
  guard: InputGuard;
  drafts: Drafts;
  session: Pick<ClientSession, "state" | "open">;
  presence(): { focused: boolean; visible: boolean };
  confirm(message: string): boolean;
  environment?: NavigationEnvironment;
  factory?: StateFactory;
}): ShellNavigation {
  const { resources, actions, guard, session } = o;
  const store = (o.factory ?? createState)<ShellNavigationState>({
    settings: false,
    error: "",
  });
  let revision = 0, viewed = "", viewedFinish = 0, projectOnly = false;
  const fail = (error: unknown): void =>
    store.update((draft) => {
      draft.error = errorMessage(error);
    });
  const clearError = (): void =>
    store.update((draft) => {
      draft.error = "";
    });
  let locations: readonly ProjectLocation[] = [];
  const pendingLocations = new Map<string, ProjectLocation>();
  const locationKey = (p: ProjectSelection) =>
    JSON.stringify([p.sidecarId, p.directory]);
  const lastLocation = (p: ProjectSelection) =>
    pendingLocations.get(locationKey(p)) ??
      locations.find((location) =>
        location.sidecarId === p.sidecarId && location.directory === p.directory
      );
  const remember = (p: ProjectSelection, sessionID?: string) => {
    if (lastLocation(p)?.sessionID === sessionID) return;
    const key = locationKey(p), location = { ...p, sessionID };
    pendingLocations.set(key, location);
    void resources.rememberLocation(location).catch(fail).finally(() => {
      if (pendingLocations.get(key) === location) pendingLocations.delete(key);
    });
  };
  const releaseLocations = resources.observe({
    frame(id, frame) {
      if (id === LOCAL_SIDECAR && frame.t === "prefs") {
        locations = frame.prefs.shellLayout.projectLocations ?? [];
      }
    },
  });
  const project = (value?: ProjectSelection): void =>
    store.update((draft) => {
      draft.project = value;
    });
  const closeSettings = (): void =>
    store.update((draft) => {
      draft.settings = false;
    });
  const observeProject = (target: ProjectSelection, ready: boolean): void => {
    const key = `project/${target.sidecarId}/${target.directory}`;
    if (!ready || viewed === key) return;
    viewed = key;
    void resources.inbox(target.sidecarId).openProject(target.directory).catch(
      fail,
    );
  };
  const navigation = createNavigation({
    intent: () => {
      revision++;
    },
    apply(hash) {
      projectOnly = false;
      const target = route(hash),
        projectTarget = projectRoute(hash),
        previous = session.state.selection;
      const changes = target?.sidecarId !== previous?.sidecarId ||
        target?.sessionID !== previous?.sessionID;
      const server = target?.sidecarId ?? projectTarget?.sidecarId;
      if (server && !resources.server(server)) {
        store.update((draft) => {
          draft.error =
            "The URL refers to an unknown server. Add it in Settings.";
        });
        session.open();
        project();
      } else {
        projectOnly = !!projectTarget;
        clearError();
        session.open(target);
        project(
          projectTarget ??
            (target && resources.entry(target.sidecarId, target.sessionID)
              ? {
                sidecarId: target.sidecarId,
                directory: resources.entry(target.sidecarId, target.sessionID)!
                  .directory,
              }
              : undefined),
        );
        if (projectTarget) {
          observeProject(
            projectTarget,
            resources.connected(projectTarget.sidecarId),
          );
        }
      }
      if (changes) guard.clear();
    },
    accept(hash) {
      const target = route(hash), previous = session.state.selection;
      return (target?.sidecarId === previous?.sidecarId &&
        target?.sessionID === previous?.sessionID) || guard.release();
    },
  }, o.environment);
  const navigate = (input: Selection): boolean => {
    const selection = actions.family(input), previous = session.state.selection;
    if (!navigation.open(hashFor(selection))) return false;
    closeSettings();
    if (
      previous?.sidecarId === selection.sidecarId &&
      previous.sessionID === selection.sessionID && !session.state.loading
    ) {
      void actions.directory(selection).then((directory) =>
        resources.inbox(selection.sidecarId).openSession(
          selection.sessionID,
          directory,
        )
      ).catch(fail);
    }
    return true;
  };
  const createIn = async (
    sidecarId: string,
    directory: string,
    task?: TaskRecord,
  ): Promise<void> => {
    if (!guard.release()) return;
    const intent = ++revision,
      rpc = resources.sidecars.connection(sidecarId).rpc;
    const taskActions = resources.taskActions({ sidecarId, directory });
    try {
      const created = await rpc.call("session.create", { directory });
      if (task) await taskActions.add(task, created.id);
      if (intent === revision) navigate({ sidecarId, sessionID: created.id });
    } catch (error) {
      if (intent === revision) fail(error);
    }
  };
  const creationTarget = (
    input?: ProjectSelection,
  ): ProjectSelection | Selection | undefined =>
    input ?? session.state.selection ?? store.state.project;
  /** Close and native deletion share captured view-release and routing policy.
   * The disposition tells the guard whether the stored draft survives. */
  const releaseSession = async (
    input: Selection | undefined,
    disposition: "kept" | "dropped",
  ): Promise<boolean> => {
    const selected = input ?? session.state.selection;
    if (!selected || !resources.connected(selected.sidecarId)) return false;
    const target = { ...selected }, intent = revision;
    const directory = await actions.directory(target);
    if (intent !== revision) return false;
    const p = { sidecarId: target.sidecarId, directory };
    const entries = resources.projectEntries(p);
    const entry = entries.find((entry) => entry.id === target.sessionID);
    if (!entry) return false;
    const inbox = resources.inbox(target.sidecarId).state.inbox;
    if (
      disposition === "kept" && inboxStatus(entry, inbox) !== "idle" &&
      !o.confirm(
        `Close “${entry.title}”? It will stay visible as a phantom tab until it is idle and seen. The session remains in Sessions and in the agent service.`,
      )
    ) return false;
    const ids = disposition === "kept"
      ? [target.sessionID]
      : actions.familyEntries(target).map((entry) => entry.id);
    const keys = ids.map((id) => sessionKey(target.sidecarId, id));
    const shown = () =>
      session.state.selection?.sidecarId === target.sidecarId &&
      ids.includes(session.state.selection.sessionID);
    if (
      (shown() || disposition === "dropped") &&
      !guard.release({ draft: disposition, keys })
    ) return false;
    const model = resources.tabs(p);
    const task = inbox.tasks.find((task) =>
      task.directory === directory && task.sessions.includes(target.sessionID)
    );
    const remaining = task?.sessions.find((id) => !ids.includes(id));
    if (disposition === "dropped") {
      await actions.remove(target);
      for (const key of keys) o.drafts.drop(key);
      if (shown()) guard.clear();
    } else if (task) {
      await resources.taskActions(p).remove(task, target.sessionID);
    }
    if (ids.includes(lastLocation(p)?.sessionID ?? "")) remember(p);
    if (intent === revision && shown()) {
      const next = entry.parentID ?? remaining;
      if (next) navigate({ sidecarId: target.sidecarId, sessionID: next });
      else navigation.open(projectHash(p));
    }
    for (const id of ids) model.close(id);
    return true;
  };
  return {
    state: store.state,
    subscribe: store.subscribe,
    navigate,
    createIn,
    fail,
    clearError,
    closeSettings,
    openProject(target) {
      if (
        store.state.project?.sidecarId === target.sidecarId &&
        store.state.project?.directory === target.directory
      ) {
        closeSettings();
        void resources.inbox(target.sidecarId).openProject(target.directory)
          .catch(fail);
        if (session.state.selection) return;
      }
      const remembered = lastLocation(target)?.sessionID;
      const saved = remembered && resources.entry(target.sidecarId, remembered);
      const existing = saved && saved.directory === target.directory
        ? saved
        : resources.entries().find((entry) =>
          entry.sidecarId === target.sidecarId &&
          entry.directory === target.directory && !entry.parentID
        );
      if (existing) {
        navigate({ sidecarId: target.sidecarId, sessionID: existing.id });
        return;
      }
      if (navigation.open(projectHash(target))) closeSettings();
    },
    openChild: (id) => {
      navigate(actions.child(id));
    },
    projectHome: () =>
      !!store.state.project &&
      navigation.open(projectHash(store.state.project)),
    preview(target) {
      if (!navigate(target)) return false;
      const directory = resources.entry(target.sidecarId, target.sessionID)
        ?.directory;
      if (directory) {
        resources.tabs({ sidecarId: target.sidecarId, directory }).preview(
          target.sessionID,
        );
      }
      return true;
    },
    async pin(target) {
      if (!navigate(target)) return false;
      const directory = resources.entry(target.sidecarId, target.sessionID)
        ?.directory;
      if (!directory) return false;
      const model = resources.tabs({ sidecarId: target.sidecarId, directory });
      model.preview(target.sessionID);
      if (model.state.selected?.kind === "task") return true;
      await model.pin(target.sessionID);
      return true;
    },
    close: (target) => releaseSession(target, "kept"),
    remove: (target) => releaseSession(target, "dropped"),
    available(input) {
      const target = creationTarget(input);
      return !!target && resources.connected(target.sidecarId);
    },
    async create(input) {
      const target = creationTarget(input);
      if (!target) return;
      const sidecarId = target.sidecarId, intent = revision;
      const directory = "directory" in target
        ? target.directory
        : await actions.directory(target);
      if (intent === revision) await createIn(sidecarId, directory);
    },
    showSettings() {
      revision++;
      store.update((draft) => {
        draft.settings = true;
      });
    },
    removeServer(id) {
      if (
        (session.state.selection?.sidecarId === id ||
          store.state.project?.sidecarId === id) && !navigation.open("")
      ) {
        return false;
      }
      resources.remove(id);
      return true;
    },
    observeView(value) {
      if (!value.selected) {
        const target = store.state.project;
        if (
          projectOnly && target && value.directory === target.directory &&
          !value.settings
        ) {
          observeProject(target, value.connected);
        } else viewed = "";
        return;
      }
      if (
        !value.directory || value.loading ||
        value.settings || !value.connected
      ) {
        return;
      }
      const target = value.selected,
        key = sessionKey(target.sidecarId, target.sessionID);
      project({ sidecarId: target.sidecarId, directory: value.directory });
      remember(
        { sidecarId: target.sidecarId, directory: value.directory },
        target.sessionID,
      );
      if (viewed !== key) {
        viewed = key;
        viewedFinish = value.finish;
        void resources.inbox(target.sidecarId).openSession(
          target.sessionID,
          value.directory,
        ).catch(fail);
      } else if (value.finish > viewedFinish) {
        const presence = o.presence();
        if (presence.focused && presence.visible) {
          viewedFinish = value.finish;
          void resources.sidecars.connection(target.sidecarId).rpc.call(
            "sessions.seen",
            { sessionID: target.sessionID },
          ).catch(fail);
        }
      }
    },
    start: navigation.start,
    stop() {
      navigation.stop();
      releaseLocations();
      pendingLocations.clear();
    },
  };
}
