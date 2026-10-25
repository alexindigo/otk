// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect } from "solid-js";
import {
  type ClientSession,
  createCurrentClient,
  createDrafts,
  createInputGuard,
  createServerResources,
  createSessionActions,
  createSessionRename,
  createShellNavigation,
  type CurrentClient,
  type Drafts,
  type InputGuard,
  type ServerResources,
  type SessionActions,
  type SessionRename,
  type ShellNavigation,
} from "@otk/client";
import { solidState } from "./binding.ts";
import { createIndex } from "./index.ts";
import { createSession } from "./session.ts";
import { createSidecars } from "./sidecars.ts";

export interface ShellState {
  resources: ServerResources;
  session: ClientSession;
  drafts: Drafts;
  current: CurrentClient;
  actions: SessionActions;
  rename: SessionRename;
  guard: InputGuard;
  navigation: ShellNavigation;
}
/** Browser capabilities and split reactive effects bind the framework-free owners. */
export function createShellState(o: { api: URL }): ShellState {
  const index = createIndex();
  const resources = createServerResources({
    index,
    factory: solidState,
    error: (error) => navigation.fail(error),
    sidecars: (receive) =>
      createSidecars(receive, { connection: { api: o.api } }),
  });
  const { sidecars, entry } = resources;
  const session = createSession(
    (id) => sidecars.connection(id),
    entry,
    (target) => ({
      key: resources.connectionKey(target.sidecarId),
      connected: resources.connected(target.sidecarId),
      available: resources.declares(target.sidecarId, "models"),
    }),
  );
  const drafts = createDrafts(solidState);
  const current = createCurrentClient(
    () => session.state.selection,
    (id) => sidecars.connection(id),
  );
  const actions = createSessionActions({ resources, session, current });
  const rename = createSessionRename({
    rename: actions.rename,
    title: (target) =>
      resources.entry(target.sidecarId, target.sessionID)?.title,
    factory: solidState,
  });
  createEffect(() => {
    const target = rename.state.editing;
    return target && resources.entry(target.sidecarId, target.sessionID)?.title;
  }, () => rename.observe());
  const guard = createInputGuard({
    drafts,
    key: actions.key,
    confirm: (message) => globalThis.confirm(message),
  });
  const navigation = createShellNavigation({
    resources,
    actions,
    guard,
    session,
    factory: solidState,
    presence: () => ({
      focused: document.hasFocus(),
      visible: document.visibilityState === "visible",
    }),
    confirm: (message) => globalThis.confirm(message),
  });
  createEffect(() => {
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
  }, navigation.observeView);
  createEffect(() => {
    const p = navigation.state.project;
    return p &&
      { p, input: resources.tabSnapshot(p), selected: session.state.selection };
  }, (value) => {
    if (value) resources.syncTabs(value.p, value.input, value.selected);
  });
  return {
    resources,
    session,
    drafts,
    current,
    actions,
    rename,
    guard,
    navigation,
  };
}
