// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ClientSession,
  loadHistory,
  type Selection,
  type ServerResources,
  type SessionActions,
} from "@otk/client";
import type { Preferences } from "@otk/protocol";
import type { SessionPorts } from "../registries/session.tsx";

/** Plain binding: capture identity once, delegate every live read and intent. */
export function sessionPorts(o: {
  target: Selection;
  resources: ServerResources;
  actions: SessionActions;
  session: ClientSession;
  guard: { mark(owner: string, dirty: boolean): void };
  prefs(): Preferences;
}): SessionPorts {
  const target = { ...o.target }, { resources, actions, session } = o;
  const connection = resources.sidecars.connection(target.sidecarId);
  return {
    supports: (c) =>
      c === "history"
        ? resources.anyAdvertised(c)
        : resources.declares(target.sidecarId, c),
    rpc: connection.rpc.call.bind(connection.rpc),
    connectionKey: () => resources.connectionKey(target.sidecarId),
    connected: () => resources.linked(target.sidecarId),
    onToolCompleted: (listener) => session.onToolCompleted(target, listener),
    modelCatalog: session.models,
    approvals: resources.approvals(target.sidecarId),
    sessionID: () => target.sessionID,
    directory: () => actions.directory(target),
    entry: (id) => resources.entry(target.sidecarId, id),
    location: (id) => actions.location(target, id),
    permissions: () => session.state.content.permissions,
    questions: () => session.state.content.questions,
    prefs: o.prefs,
    dirty: (owner, dirty) => o.guard.mark(owner, dirty),
    act: (action) => actions.act(target, action),
    submit: actions.submission(target),
    history: () => loadHistory(resources.historySources()),
    attachments: (parts) => actions.attachments(parts, target.sidecarId),
  };
}
