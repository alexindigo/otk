// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  type BranchHistory,
  browserStorage,
  type ClientSession,
  connectBranchHistory,
  createCurrentClient,
  createDisclosures,
  createDrafts,
  createForkNotes,
  createInputGuard,
  createListScopes,
  createProjectRename,
  createReload,
  createServerResources,
  createSessionActions,
  createSessionRename,
  createSessionRevert,
  createShellNavigation,
  createTranscriptScopes,
  type CurrentClient,
  type Disclosures,
  type Drafts,
  type DurableStore,
  type ForkNotes,
  type InputGuard,
  keyedReload,
  type ListInteraction,
  type ProjectSelection,
  route,
  type Selection,
  type ServerResources,
  SESSION_TREE_DISCLOSURES,
  type SessionActions,
  sessionKey,
  type SessionRename,
  type SessionRevert,
  type ShellNavigation,
  type TranscriptOwner,
  WorkPanel,
} from "@otk/client";
import {
  projectLayoutKey,
  type SessionTreeKind,
  treeLayoutKey,
} from "@otk/protocol";
import { createToggles, type Toggles } from "../components/Toggles.ts";
import { createWorkModel } from "../components/work-log.ts";
import type { PartRegistry } from "../registries/renderers.ts";
import { solidState } from "./binding.ts";
import { createIndex } from "./index.ts";
import { createSession } from "./session.ts";
import { createSidecars } from "./sidecars.ts";

export interface ShellWork {
  panel: WorkPanel;
  model(session: Selection): ReturnType<typeof createWorkModel> | undefined;
  shows(session: Selection, turn: string): boolean;
}

export interface ShellState {
  reload: import("@otk/client").Reload;
  listInteraction(project: ProjectSelection, task?: string): ListInteraction;
  disclosures: Disclosures;
  work: ShellWork;
  toggles: Toggles;
  resources: ServerResources;
  session: ClientSession;
  drafts: Drafts;
  branchHistory: BranchHistory;
  current: CurrentClient;
  actions: SessionActions;
  rename: SessionRename;
  projectRename: import("@otk/client").ProjectRename;
  revert: SessionRevert;
  forkNotes: ForkNotes;
  guard: InputGuard;
  navigation: ShellNavigation;
  interact(): void;
}
/** Browser capabilities and split reactive effects bind the framework-free owners. */
export function createShellState(
  o: {
    api: URL;
    parts: PartRegistry;
    build?: string;
    policy?: import("@otk/protocol").ClientRequestPolicy;
    confirm(message: string): Promise<boolean>;
    promptCommitted?(message: import("@otk/protocol").UserMessage): void;
  },
): ShellState {
  const index = createIndex();
  const storage = browserStorage();
  const resources = createServerResources({
    index,
    factory: solidState,
    error: (error) => navigation.fail(error),
    sidecars: (receive) =>
      createSidecars(receive, {
        storage,
        connection: {
          api: o.api,
          page: { build: o.build },
          policy: o.policy,
          reload: () => reload.run(),
          retireRequestDisclosures: (scope) => disclosures.retire({ scope }),
        },
        sessionTitle: (sidecarId, sessionID) =>
          index.get(sidecarId, sessionID)?.title,
      }),
  });
  const { sidecars, entry } = resources;
  const listScopes = createListScopes();
  const toggles = createToggles(resources.setPreference);
  const layout = () => toggles.state.prefs.shellLayout;
  const expanded = (collapsed: boolean | undefined) =>
    collapsed === undefined ? undefined : !collapsed;
  const treeStore = (kind: SessionTreeKind): DurableStore => ({
    read: ({ scope: sidecarId, id }) =>
      expanded(
        layout().treeCollapsed?.[treeLayoutKey({ sidecarId, kind, id })],
      ),
    save: ({ scope: sidecarId, id }, open) =>
      resources.treeCollapse({ sidecarId, kind, id }, !open),
  });
  const disclosures = createDisclosures({
    factory: solidState,
    durable: {
      [SESSION_TREE_DISCLOSURES.session]: treeStore("session"),
      [SESSION_TREE_DISCLOSURES.task]: treeStore("task"),
      [SESSION_TREE_DISCLOSURES.ungrouped]: treeStore("ungrouped"),
      projectBranch: {
        read: ({ scope: sidecarId, id: directory }) =>
          expanded(
            layout().projectCollapsed
              ?.[projectLayoutKey({ sidecarId, directory })],
          ),
        save: ({ scope: sidecarId, id: directory }, open) =>
          resources.projectCollapse({ sidecarId, directory }, !open),
      },
      discovered: {
        read: () => expanded(layout().discoveredCollapsed),
        save: (_, open) => resources.layout({ discoveredCollapsed: !open }),
      },
    },
  });
  resources.observe({ removed: (id) => listScopes.remove(id) });
  const panel = new WorkPanel(solidState);
  const session = createSession(
    (id) => sidecars.connection(id),
    entry,
    (target) => ({
      key: resources.connectionKey(target.sidecarId),
      connected: resources.connected(target.sidecarId),
      available: resources.declares(target.sidecarId, "models"),
    }),
    (id) => resources.indexChanges(id),
    (target, directory) =>
      resources.declares(target.sidecarId, "catalogs")
        ? {
          directory: resources.directoryCatalog(target.sidecarId, directory),
          frecency: resources.frecencyCatalog(target.sidecarId, directory),
        }
        : undefined,
    (id) => resources.inbox(id).entities,
    disclosures,
    (scope) => panel.retire(scope),
  );
  const workModels = new WeakMap<
    TranscriptOwner,
    ReturnType<typeof createWorkModel>
  >();
  const workModel: ShellWork["model"] = (target) => {
    // Recheck the collection when the selected session binds its body.
    void session.state.content;
    const transcript = session.transcripts.get(target);
    if (!transcript) return;
    let model = workModels.get(transcript);
    if (!model) {
      const prefs = () => toggles.state.prefs;
      model = createWorkModel({
        reply: (key) => transcript.state.repliesByID[key],
        replyKeys: () => transcript.state.replyIDs,
        presentation: (part) => o.parts.presentation(part, prefs()),
        presentationRevision: prefs,
        now: Date.now,
      });
      workModels.set(transcript, model);
    }
    return model;
  };
  const work: ShellWork = {
    panel,
    model: workModel,
    shows(target, turn) {
      const { rightView, rightCollapsed } = layout();
      const selected = session.state.selection;
      if (
        rightView !== "work" || rightCollapsed ||
        selected?.sidecarId !== target.sidecarId ||
        selected.sessionID !== target.sessionID
      ) return false;
      const turns = workModel(target)?.turns() ?? [];
      return panel.shown(sessionKey(target.sidecarId, target.sessionID), turns)
        .turn === turn;
    },
  };
  const drafts = createDrafts(solidState);
  const hasServer = (id: string) =>
    sidecars.state.list.some((server) => server.id === id);
  let tabStorage: Storage | null = null;
  try {
    tabStorage = globalThis.sessionStorage;
  } catch { /* Reload will refuse visibly. */ }
  const reload = createReload({
    key: `otk.reload.v1:${o.api.href}`,
    storage: tabStorage,
    navigate: () => globalThis.location.reload(),
    reachable: () =>
      fetch(new URL("health", o.api), {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      }).then((response) => response.ok, () => false),
    owners: {
      drafts,
      connections: keyedReload({
        ids: () => sidecars.state.list.map(({ id }) => id),
        snapshot(id) {
          const { attention, requests } = sidecars.connection(id);
          return {
            id,
            attention: attention.snapshot(),
            requests: requests.snapshot(),
          };
        },
        restore({ id, attention, requests }) {
          const connection = sidecars.connection(id);
          connection.attention.restore(attention);
          connection.requests.restore(requests);
        },
      }),
    },
  });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    try {
      reload.checkpoint();
    } catch (cause) {
      console.error("Reload checkpoint diagnostic", cause);
      event.preventDefault();
      event.returnValue = "";
    }
  };
  globalThis.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => globalThis.removeEventListener("beforeunload", beforeUnload));
  const current = createCurrentClient(
    () => session.state.selection,
    (id) => sidecars.connection(id),
  );
  const forkNotes = createForkNotes(solidState);
  const branchHistory = connectBranchHistory({
    storage,
    drafts,
    factory: solidState,
    api: o.api,
    resources,
    transcripts: session.transcripts,
    attachments: (parts, origin) => actions.attachments(parts, origin),
  });
  const actions = createSessionActions({
    promptCommitted: o.promptCommitted,
    resources,
    session,
    current,
    branchHistory,
    revertReady: (target) => revert.ready(target),
    factory: solidState,
    submitted: (target, action) =>
      forkNotes.submission(
        sessionKey(target.sidecarId, target.sessionID),
        action,
      ),
  });
  const restoreSend = (
    target: import("@otk/client").Selection,
    saved: Parameters<ReturnType<typeof actions.delivery>["resume"]>[0],
    intent?: import("@otk/client").ClientIntent,
  ) => {
    const delivery = actions.delivery(target);
    const key = sessionKey(target.sidecarId, target.sessionID);
    const id = "message" in saved ? saved.message.id : saved.messageID;
    const outcome = drafts.resumeSend(key, id, () => void delivery.reload());
    const operation = intent && sidecars.connection(target.sidecarId).requests
      .operations(target.sessionID)
      .find(({ state }) =>
        state.ref.clientID === intent.clientID && state.ref.key === intent.key
      );
    delivery.resume(
      saved,
      operation?.result as
        | Promise<import("@otk/protocol").SubmissionReceipt | null>
        | undefined,
      outcome && { outcome },
    );
  };
  reload.register("transcripts", {
    snapshot: () => session.transcripts.snapshot(),
    restore(value) {
      const unavailable = session.transcripts.restore(
        value,
        (target, send) => restoreSend(target, send, send.intent),
        hasServer,
      );
      if (unavailable) {
        queueMicrotask(() =>
          navigation.fail(
            new Error(
              "Saved sends for removed servers are kept in this tab but cannot be checked.",
            ),
          )
        );
      }
    },
  });
  for (const { key, messageID, intent } of drafts.pendingSends()) {
    const separator = key.indexOf("/");
    const sidecarId = key.slice(0, separator);
    if (separator < 0 || !hasServer(sidecarId)) continue;
    restoreSend({ sidecarId, sessionID: key.slice(separator + 1) }, {
      messageID,
    }, intent);
  }
  const rename = createSessionRename({
    rename: actions.rename,
    title: (target) =>
      resources.entry(target.sidecarId, target.sessionID)?.title,
    factory: solidState,
  });
  reload.register("rename", rename);
  const projectRename = createProjectRename({
    update: (target, name) => resources.updateProject(target, { name }),
    label: (target) =>
      resources.checkoutLabel(target.sidecarId, target.directory),
    factory: solidState,
  });
  reload.register("project-rename", projectRename);
  reload.register("server-addition", {
    snapshot: () => sidecars.state.addition,
    restore(value) {
      if (value) sidecars.editAdd?.(value as { url: string; label: string });
    },
  });
  const revert = createSessionRevert({
    session,
    actions,
    drafts,
    branchHistory,
    storage,
    server: (target) =>
      new URL(resources.server(target.sidecarId)?.baseUrl || o.api.href, o.api)
        .href,
    status: {
      working: actions.working,
      subscribe: (listener) =>
        resources.observe({
          frame: () => listener(),
          removed: () => listener(),
        }),
    },
    factory: solidState,
  });
  createEffect(() => {
    const target = rename.state.editing;
    return target && resources.entry(target.sidecarId, target.sessionID)?.title;
  }, () => rename.observe());
  createEffect(() => {
    const target = projectRename.state.editing;
    return target &&
      resources.checkoutLabel(target.sidecarId, target.directory);
  }, () => projectRename.observe());
  const guard = createInputGuard({
    drafts,
    key: actions.key,
    retain: () =>
      session.state.view === "deleted" || !!actions.selectedEntry()?.deleted,
    retention: () => {
      const target = session.state.selection;
      if (!target) return;
      return sidecars.connection(target.sidecarId).attention.retention(
        target.sessionID,
        (id) => resources.entry(target.sidecarId, id),
      );
    },
    confirm: o.confirm,
  });
  // One presence owner: navigation reads it to gate finish acknowledgement,
  // and the view effect below tracks it, so regaining presence re-observes
  // the visible session and acknowledges a finish learned while away.
  const [visible, setVisible] = createSignal(
    document.visibilityState === "visible",
  );
  const [focused, setFocused] = createSignal(document.hasFocus());
  const observePresence = () => {
    setVisible(document.visibilityState === "visible");
    setFocused(document.hasFocus());
  };
  document.addEventListener("visibilitychange", observePresence);
  globalThis.addEventListener("focus", observePresence);
  globalThis.addEventListener("blur", observePresence);
  const navigation = createShellNavigation({
    resources,
    actions,
    guard,
    drafts,
    forkNotes,
    session,
    factory: solidState,
    presence: () => ({ focused: focused(), visible: visible() }),
    confirm: o.confirm,
  });
  const transcriptScopes = createTranscriptScopes({ resources, session });
  createEffect(() => {
    const { back, forward } = navigation.state.history;
    return [back, forward].flatMap((entry) => {
      const selection = entry && entry !== "unrecorded" && route(entry.hash);
      return selection ? [selection] : [];
    });
  }, resources.historyNeighbors);
  createEffect(
    () => session.state.selection,
    (target) => branchHistory.select(target),
  );
  onCleanup(() => {
    document.removeEventListener("visibilitychange", observePresence);
    globalThis.removeEventListener("focus", observePresence);
    globalThis.removeEventListener("blur", observePresence);
    transcriptScopes.stop();
    actions.dispose();
  });
  createEffect(() => ({
    project: navigation.state.project,
    selected: session.state.selection,
    screen: visible() && !navigation.state.settings,
  }), (value) => transcriptScopes.update(value));
  createEffect(() => {
    focused();
    visible();
    // Reading an earlier branch is not viewing the live session's terminal.
    // Resume this ordinary view intent with current facts when returning live.
    if (branchHistory.state.opened) return;
    const selected = session.state.selection, data = actions.info();
    const project = selected ? undefined : navigation.state.project;
    const sidecar = selected?.sidecarId ?? project?.sidecarId;
    return {
      selected,
      directory: selected ? data?.directory : project?.directory,
      loading: session.state.loading,
      settings: navigation.state.settings,
      connected: !!sidecar && resources.connected(sidecar),
      finish: selected
        ? resources.inbox(selected.sidecarId).state.inbox
          .finishes[selected.sessionID] ?? 0
        : 0,
    };
  }, (value) => {
    if (value) navigation.observeView(value);
  });
  createEffect(() => {
    const p = navigation.state.project;
    return p &&
      { p, input: resources.tabSnapshot(p), selected: session.state.selection };
  }, (value) => {
    if (value) resources.syncTabs(value.p, value.input, value.selected);
  });
  return {
    reload,
    interact: transcriptScopes.interact,
    listInteraction: listScopes.get,
    disclosures,
    work,
    toggles,
    resources,
    session,
    drafts,
    branchHistory,
    current,
    actions,
    rename,
    projectRename,
    revert,
    forkNotes,
    guard,
    navigation,
  };
}
