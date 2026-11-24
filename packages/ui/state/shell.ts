// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  type BranchHistory,
  browserStorage,
  type ClientSession,
  connectBranchHistory,
  createCurrentClient,
  createDrafts,
  createForkNotes,
  createInputGuard,
  createListScopes,
  createReload,
  createServerResources,
  createSessionActions,
  createSessionRename,
  createSessionRevert,
  createShellNavigation,
  createTranscriptScopes,
  type CurrentClient,
  type Drafts,
  type ForkNotes,
  type InputGuard,
  type ListInteraction,
  type ProjectSelection,
  type ServerResources,
  type SessionActions,
  sessionKey,
  type SessionRename,
  type SessionRevert,
  type ShellNavigation,
} from "@otk/client";
import { solidState } from "./binding.ts";
import { createIndex } from "./index.ts";
import { createSession } from "./session.ts";
import { createSidecars } from "./sidecars.ts";

export interface ShellState {
  reload: import("@otk/client").Reload;
  confirmCommand(message: string): boolean;
  listInteraction(project: ProjectSelection, task?: string): ListInteraction;
  resources: ServerResources;
  session: ClientSession;
  drafts: Drafts;
  branchHistory: BranchHistory;
  current: CurrentClient;
  actions: SessionActions;
  rename: SessionRename;
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
    policy?: import("@otk/protocol").ClientRequestPolicy;
    promptBlocks?(text: string): import("@otk/protocol").Block[];
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
          policy: o.policy,
          reload: () => reload.run(),
        },
        sessionTitle: (sidecarId, sessionID) =>
          index.get(sidecarId, sessionID)?.title,
      }),
  });
  const { sidecars, entry } = resources;
  const listScopes = createListScopes();
  resources.observe({ removed: (id) => listScopes.remove(id) });
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
  );
  const drafts = createDrafts(solidState);
  let tabStorage: Storage | null = null;
  try {
    tabStorage = globalThis.sessionStorage;
  } catch { /* Reload will refuse visibly. */ }
  const reload = createReload({
    key: `otk.reload.v1:${o.api.href}`,
    storage: tabStorage,
    navigate: () => globalThis.location.reload(),
    owners: {
      drafts,
      connections: {
        snapshot: () =>
          sidecars.state.list.map(({ id }) => ({
            id,
            attention: sidecars.connection(id).attention.snapshot(),
            requests: sidecars.connection(id).requests.snapshot(),
          })),
        restore(value) {
          for (
            const saved of value as {
              id: string;
              attention: unknown;
              requests: unknown;
            }[]
          ) {
            if (
              !sidecars.state.list.some(({ id }) => id === saved.id)
            ) continue;
            sidecars.connection(saved.id).attention.restore(saved.attention);
            sidecars.connection(saved.id).requests.restore(saved.requests);
          }
        },
      },
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
    promptBlocks: o.promptBlocks,
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
  reload.register("transcripts", {
    snapshot: () => session.transcripts.snapshot(),
    restore(value) {
      session.transcripts.restore(value, (target, send) => {
        const operation = sidecars.connection(target.sidecarId).requests
          .operations()
          .find(({ state }) =>
            state.ref.clientID === send.intent.clientID &&
            state.ref.key === send.intent.key
          );
        actions.delivery(target).resume(
          send,
          operation?.result as
            | Promise<import("@otk/protocol").PromptReceipt | null>
            | undefined,
        );
      });
    },
  });
  const rename = createSessionRename({
    rename: actions.rename,
    title: (target) =>
      resources.entry(target.sidecarId, target.sessionID)?.title,
    factory: solidState,
  });
  reload.register("rename", rename);
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
  const guard = createInputGuard({
    drafts,
    key: actions.key,
    retain: () =>
      session.state.view === "deleted" || !!actions.selectedEntry()?.deleted,
    retention: () => {
      const target = session.state.selection;
      if (
        !target ||
        !(session.state.view === "deleted" || actions.selectedEntry()?.deleted)
      ) return;
      return sidecars.connection(target.sidecarId).attention.retention(
        target.sessionID,
        (id) => resources.entry(target.sidecarId, id),
      );
    },
    confirm: (message) => globalThis.confirm(message),
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
    confirm: (message) => globalThis.confirm(message),
  });
  const transcriptScopes = createTranscriptScopes({ resources, session });
  createEffect(
    () => session.state.selection,
    (target) => branchHistory.select(target),
  );
  onCleanup(() => {
    document.removeEventListener("visibilitychange", observePresence);
    globalThis.removeEventListener("focus", observePresence);
    globalThis.removeEventListener("blur", observePresence);
    transcriptScopes.stop();
    actions.stop();
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
    confirmCommand: (message: string) => globalThis.confirm(message),
    interact: transcriptScopes.interact,
    listInteraction: listScopes.get,
    resources,
    session,
    drafts,
    branchHistory,
    current,
    actions,
    rename,
    revert,
    forkNotes,
    guard,
    navigation,
  };
}
