// SPDX-License-Identifier: LGPL-3.0-only
import {
  errorFeedback,
  type FailureValue,
  failureValue,
} from "./failure-features.ts";
import type { ProjectLocation, TaskRecord } from "@otk/protocol";
import { entityKey, entityRequiresVisibility } from "@otk/protocol";
import type { InputGuard } from "./input-guard.ts";
import type { Drafts } from "./drafts.ts";
import type { ForkNotes } from "./fork-notes.ts";
import { sessionKey } from "./index.ts";
import {
  createNavigation,
  type NavigationEnvironment,
  type NavigationHistory,
} from "./navigation.ts";
import {
  projectHash,
  projectRoute,
  type ProjectSelection,
} from "./project-navigation.ts";
import { folderName } from "./project-names.ts";
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
  selectionNotice?: string;
  settings: boolean;
  error: FailureValue;
  history: NavigationHistory;
}

export interface HistoryTarget {
  enabled: boolean;
  label: string;
  state: "live" | "deleted" | "unavailable" | "page" | "unknown";
}

export function historyTarget(
  history: NavigationHistory,
  direction: "back" | "forward",
  lookup: (
    selection: Selection,
  ) => { title: string; project: string; deleted?: boolean } | undefined,
  label: (selection: ProjectSelection) => string = (p) =>
    folderName(p.directory),
): HistoryTarget {
  const entry = history[direction];
  if (!entry) {
    return {
      enabled: false,
      label: `No ${
        direction === "back" ? "earlier" : "later"
      } session in this tab`,
      state: "unknown",
    };
  }
  const to = direction === "back" ? "Back to" : "Forward to";
  const target = (
    destination: string,
    state: HistoryTarget["state"],
  ): HistoryTarget => ({ enabled: true, label: `${to} ${destination}`, state });
  if (entry === "unrecorded") return target("the previous page", "unknown");
  if (!entry.hash) return target("the start page", "page");
  const project = projectRoute(entry.hash);
  if (project) {
    return target(`the ${label(project)} project page`, "page");
  }
  const selection = route(entry.hash);
  const live = selection && lookup(selection);
  if (live) {
    const name = `${live.title} in ${live.project}`;
    return live.deleted
      ? target(`${name} (deleted)`, "deleted")
      : target(name, "live");
  }
  const name = entry.title &&
    [entry.title, entry.project].filter(Boolean).join(" in ");
  return target(
    name ? `${name} (unavailable)` : "an unavailable session",
    "unavailable",
  );
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
  back(): boolean;
  forward(): boolean;
  traverse(direction: "back" | "forward"): Promise<boolean>;
  openProject(project: ProjectSelection): void;
  openAttention(project: ProjectSelection): void;
  /** False when the guarded navigation refused the transition. */
  openChild(id: string): boolean;
  projectHome(): boolean;
  preview(target: Selection): boolean;
  pin(target: Selection): Promise<boolean>;
  close(target?: Selection): Promise<boolean>;
  remove(target: Selection): Promise<boolean>;
  fork(target: Selection & { title?: string }, through?: string): Promise<void>;
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
  forkNotes?: ForkNotes;
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
    history: { at: 0 },
  });
  let revision = 0, viewed = "", viewedFinish = 0;
  const pendingProject = (): ProjectSelection | undefined => {
    const entry = navigation.current();
    return entry && !entry.page ? projectRoute(entry.hash) : undefined;
  };
  const fail = (error: unknown): void => {
    if (resources.ownsFailure?.(error)) return;
    store.update((draft) => {
      draft.error = failureValue(error);
    });
  };
  const clearError = (): void =>
    store.update((draft) => {
      draft.error = "";
    });
  let locations: readonly ProjectLocation[] = [];
  let locationsReady = false;
  let resolution: {
    at: number;
    connection: number;
    outcome: "pending" | "failed" | "complete";
  } | undefined;
  let projectIntent: {
    at: number;
    target: ProjectSelection;
    attention?: boolean;
  } | undefined;
  const presentation = (
    p: ProjectSelection,
    repoID?: string,
  ): ProjectSelection => ({
    ...p,
    directory: resources.projectDirectory?.(p.sidecarId, p.directory, repoID) ??
      p.directory,
  });
  // This browser's accepted choices remain authoritative across older preference
  // broadcasts, RPC completion and reconnect. Persistence restores them on reload.
  const acceptedLocations = new Map<string, {
    location: ProjectLocation;
    persistence: "pending" | "saved" | "failed";
  }>();
  const locationKey = (p: ProjectSelection) =>
    JSON.stringify([p.sidecarId, presentation(p).directory]);
  const persistedLocation = (p: ProjectSelection) =>
    locations.toReversed().find((location) =>
      location.sidecarId === p.sidecarId &&
      presentation(location).directory === presentation(p).directory
    );
  const lastLocation = (p: ProjectSelection) =>
    acceptedLocations.get(locationKey(p))?.location ?? persistedLocation(p);
  const remember = (p: ProjectSelection, sessionID?: string) => {
    const key = locationKey(p), location = { ...p, sessionID };
    const previous = acceptedLocations.get(key);
    if (
      previous && previous.location.sessionID === sessionID &&
      previous.persistence !== "failed"
    ) return;
    const record = {
      location,
      persistence: "pending" as "pending" | "saved" | "failed",
    };
    acceptedLocations.set(key, record);
    if (persistedLocation(p)?.sessionID === sessionID) {
      record.persistence = "saved";
      return;
    }
    void resources.rememberLocation(location).then(() => {
      record.persistence = "saved";
    }).catch((error) => {
      record.persistence = "failed";
      fail(error);
    });
  };
  const releaseLocations = resources.observe({
    frame(id, frame) {
      if (id === LOCAL_SIDECAR && frame.t === "prefs") {
        locations = frame.prefs.shellLayout.projectLocations ?? [];
        locationsReady = true;
      }
      if (id === LOCAL_SIDECAR && frame.t === "welcome") {
        for (const record of acceptedLocations.values()) {
          if (record.persistence === "failed") {
            remember(record.location, record.location.sessionID);
          }
        }
      }
      if (frame.t === "prefs" || frame.t === "welcome") resolveProject();
    },
  });
  const project = (value?: ProjectSelection): void => {
    value = value && presentation(value);
    // Observing a view is not a new navigation intent. TranscriptScopes owns
    // membership/demand; navigation publishes only a changed project identity.
    const current = store.state.project;
    if (
      current?.sidecarId === value?.sidecarId &&
      current?.directory === value?.directory
    ) return;
    store.update((draft) => {
      draft.project = value;
    });
  };
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
    apply(hash, entry) {
      store.update((draft) => {
        delete draft.selectionNotice;
        draft.settings = false;
      });
      const target = route(hash),
        projectTarget = projectRoute(hash),
        previous = session.state.selection;
      const changes = target?.sidecarId !== previous?.sidecarId ||
        target?.sessionID !== previous?.sessionID;
      const server = target?.sidecarId ?? projectTarget?.sidecarId;
      if (!target && !projectTarget && /^#\/[^/]+\//.test(hash)) {
        store.update((draft) => {
          draft.error = errorFeedback(
            "This session link is from an older version. Open Sessions to choose a session.",
            { actionLabel: "Opening session link" },
          )!;
        });
        session.open();
        project();
      } else if (server && !resources.server(server)) {
        store.update((draft) => {
          draft.error = errorFeedback(
            "The URL refers to an unknown server. Add it in Settings.",
            { actionLabel: "Opening session link" },
          )!;
        });
        session.open();
        project();
      } else {
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
        const directory = target &&
          resources.entry(target.sidecarId, target.sessionID)?.directory;
        if (target && directory) {
          remember(
            { sidecarId: target.sidecarId, directory },
            target.sessionID,
          );
        }
        if (projectTarget) {
          observeProject(
            projectTarget,
            resources.connected(projectTarget.sidecarId),
          );
          if (!entry.page) resolveProject(projectTarget);
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
  const releaseHistory = navigation.subscribe(() => {
    const history = navigation.history();
    store.update((draft) => {
      draft.history = history;
    });
  });
  const setOpened = (target: Selection, opened: boolean) =>
    resources.sidecars.connection(target.sidecarId).rpc.call(
      "sessions.opened",
      {
        sessionID: target.sessionID,
        opened,
      },
    );
  const navigate = (
    input: Selection,
    mode?: "push" | "replace",
    explicit = false,
  ): boolean => {
    const selection = actions.family(input), previous = session.state.selection;
    if (!navigation.open(hashFor(selection), mode)) return false;
    closeSettings();
    if (
      explicit &&
      !resources.entry(selection.sidecarId, selection.sessionID)?.deleted
    ) {
      void setOpened(selection, true).catch(fail);
    }
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
  const resolveProject = (
    input?: ProjectSelection,
    attention?: boolean,
  ): void => {
    if (input) {
      projectIntent = { at: revision, target: { ...input }, attention };
    }
    const value = projectIntent?.at === revision
      ? projectIntent.target
      : pendingProject();
    const target = value &&
      { sidecarId: value.sidecarId, directory: value.directory };
    if (
      !target || !locationsReady ||
      (!input && store.state.settings) ||
      !resources.connected(target.sidecarId)
    ) return;
    const connection = resources.server(target.sidecarId)?.connectionVersion ??
      0;
    if (
      resolution?.at === revision &&
      (resolution.outcome !== "failed" || resolution.connection === connection)
    ) return;
    const attempt: NonNullable<typeof resolution> = {
      at: revision,
      connection,
      outcome: "pending",
    };
    resolution = attempt;
    const preferred = lastLocation(target)?.sessionID;
    const explicitAttention = projectIntent?.attention;
    void resources.projectSession(
      target,
      preferred,
      explicitAttention,
    ).then(
      (id) => {
        attempt.outcome = "complete";
        if (revision === attempt.at) {
          clearError();
          if (id) {
            const pending = pendingProject();
            const mode = pending && projectHash(pending) === projectHash(target)
              ? "replace"
              : "push";
            if (
              navigate({ sidecarId: target.sidecarId, sessionID: id }, mode) &&
              !explicitAttention && id !== preferred
            ) {
              const title = resources.entry(target.sidecarId, id)?.title ?? id;
              store.update((draft) => {
                draft.selectionNotice = preferred
                  ? `The remembered session is no longer available. Selected "${title}".`
                  : `No remembered session for this project. Selected "${title}".`;
              });
            }
          } else if (preferred && !explicitAttention) {
            store.update((draft) => {
              draft.selectionNotice =
                "The remembered session is no longer available. Choose a session.";
            });
          }
        }
      },
    ).catch((error) => {
      attempt.outcome = "failed";
      if (revision === attempt.at) {
        fail(error);
        // A reconnect may have arrived while this older lookup was pending.
        resolveProject();
      }
    });
  };
  // Home/close are explicit project-page intents, not default-selection intents.
  const projectPage = (
    target: ProjectSelection,
    mode?: "push" | "replace",
  ): boolean => navigation.open(projectHash(target), mode, { page: true });
  const createIn = async (
    sidecarId: string,
    directory: string,
    task?: TaskRecord,
  ): Promise<void> => {
    directory = task?.directory ?? directory;
    const rpc = resources.sidecars.connection(sidecarId).rpc;
    return await rpc.intents.run(
      JSON.stringify(["create-session", directory, task?.id]),
      async (group) => {
        const create = group.options("create", directory);
        const add = group.options("add", directory);
        if (!guard.release()) return;
        const intent = ++revision;
        const taskActions = resources.taskActions({ sidecarId, directory });
        try {
          const created = await rpc.call(
            "session.create",
            { directory },
            create,
          );
          if (task) await taskActions.add(task, created.id, add);
          if (intent === revision) {
            navigate({ sidecarId, sessionID: created.id });
          }
        } catch (error) {
          if (intent === revision) fail(error);
        }
      },
    );
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
    const p = presentation({ sidecarId: target.sidecarId, directory });
    const entries = resources.projectEntries(p);
    const entry = entries.find((entry) => entry.id === target.sessionID);
    if (!entry) return false;
    const inbox = resources.inbox(target.sidecarId).state.inbox;
    const states = resources.entities(target.sidecarId);
    if (
      disposition === "kept" && !states.isStale &&
      entityRequiresVisibility(states.get(entityKey("session", entry.id))) &&
      !o.confirm(
        `Close "${entry.title}"? Its task will stay visible while it has known activity or an unseen finish. The session remains in Sessions and in the agent service.`,
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
    if (disposition === "kept" && !entry.deleted) {
      await setOpened(target, false);
    }
    if (ids.includes(lastLocation(p)?.sessionID ?? "")) remember(p);
    if (intent === revision && shown()) {
      // This captured release was already accepted, and its metadata mutation
      // succeeded. Consume only that owner's marks before guarded routing.
      guard.clear();
      const next = entry.parentID ?? remaining;
      if (next) {
        navigate({ sidecarId: target.sidecarId, sessionID: next }, "replace");
      } else projectPage(p, "replace");
    }
    for (const id of ids) model.close(id);
    return true;
  };
  return {
    state: store.state,
    subscribe: store.subscribe,
    navigate: (target) => navigate(target, undefined, true),
    back: () => navigation.go(-1),
    forward: () => navigation.go(1),
    traverse: (direction) => navigation.traverse(direction === "back" ? -1 : 1),
    createIn,
    fail,
    clearError,
    closeSettings,
    openAttention(target) {
      // Capture a distinct explicit intent without letting a project-route
      // default race it. The accepted session route still owns the input guard.
      revision++;
      closeSettings();
      resolveProject(target, true);
    },
    openProject(target) {
      target = presentation(target);
      if (
        store.state.project?.sidecarId === target.sidecarId &&
        store.state.project.directory === target.directory &&
        session.state.selection && resources.connected(target.sidecarId)
      ) {
        revision++;
        closeSettings();
        void resources.inbox(target.sidecarId).openProject(target.directory)
          .catch(fail);
        resolveProject(target);
        return;
      }
      if (navigation.open(projectHash(target))) {
        closeSettings();
        resolveProject(target);
      }
    },
    openChild: (id) => navigate(actions.child(id), undefined, true),
    projectHome: () =>
      !!store.state.project &&
      projectPage(store.state.project),
    preview(target) {
      if (!navigate(target, undefined, true)) return false;
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
      if (!actions.eligibility(target).live) return false;
      if (!navigate(target, undefined, true)) return false;
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
    async fork(input, through) {
      const target = { ...input };
      if (!guard.release({ draft: "kept" })) return;
      const intent = ++revision;
      const title = target.title ??
        resources.entry(target.sidecarId, target.sessionID)?.title ??
        target.sessionID;
      const created = await actions.fork(target, through);
      o.forkNotes?.add(sessionKey(target.sidecarId, created.id), title);
      if (intent === revision) {
        navigate({ sidecarId: target.sidecarId, sessionID: created.id });
      }
    },
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
          store.state.project?.sidecarId === id) &&
        !navigation.open("", "replace")
      ) {
        return false;
      }
      resources.remove(id);
      return true;
    },
    observeView(value) {
      // View effects may publish late. Only the accepted route can own memory.
      if (
        value.selected &&
        (value.selected.sidecarId !== session.state.selection?.sidecarId ||
          value.selected.sessionID !== session.state.selection?.sessionID)
      ) return;
      if (!value.selected) {
        const target = store.state.project;
        if (
          projectRoute(navigation.current()?.hash ?? "") && target &&
          value.directory === target.directory &&
          !value.settings
        ) {
          observeProject(target, value.connected);
          resolveProject();
        } else viewed = "";
        return;
      }
      // Scope/row readiness belongs to the accepted metadata index. Transcript
      // hydration gates seen bookkeeping below, never mounting the project list.
      const indexed = resources.entry(
        value.selected.sidecarId,
        value.selected.sessionID,
      );
      const directory = indexed?.directory ??
        (!value.loading ? value.directory : undefined);
      if (directory && !value.settings && value.connected) {
        const location = { sidecarId: value.selected.sidecarId, directory };
        const presented = presentation(location, indexed?.projectID);
        project(presented);
        remember(location, value.selected.sessionID);
        if (indexed) {
          navigation.describe(hashFor(value.selected), {
            title: indexed.title,
            project: resources.checkoutLabel(
              presented.sidecarId,
              presented.directory,
            ),
          });
        }
      }
      if (
        !value.directory || value.loading ||
        value.settings || !value.connected
      ) {
        return;
      }
      const target = value.selected,
        key = sessionKey(target.sidecarId, target.sessionID);
      if (viewed !== key) {
        viewed = key;
        viewedFinish = value.finish;
        void resources.inbox(target.sidecarId).openSession(
          target.sessionID,
          value.directory,
          value.finish,
        ).catch(fail);
      } else if (value.finish > viewedFinish) {
        const presence = o.presence();
        if (presence.focused && presence.visible) {
          viewedFinish = value.finish;
          void resources.sidecars.connection(target.sidecarId).rpc.call(
            "sessions.seen",
            { sessionID: target.sessionID, terminal: value.finish },
          ).catch(fail);
        }
      }
    },
    start: navigation.start,
    stop() {
      revision++;
      navigation.stop();
      releaseHistory();
      releaseLocations();
      acceptedLocations.clear();
    },
  };
}
