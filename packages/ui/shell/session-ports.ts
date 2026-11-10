// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ClientSession,
  loadHistory,
  type Selection,
  type ServerResources,
  type SessionActions,
} from "@otk/client";
import { belongsToSession, type Preferences } from "@otk/protocol";
import type { SessionPorts } from "../registries/session.tsx";

/** Plain binding: capture identity once, delegate every live read and intent. */
export function sessionPorts(o: {
  target: Selection;
  resources: ServerResources;
  actions: SessionActions;
  session: ClientSession;
  guard: { mark(owner: string, dirty: boolean, input?: string): void };
  prefs(): Preferences;
}): SessionPorts {
  const target = { ...o.target }, { resources, actions, session } = o;
  const connection = resources.sidecars.connection(target.sidecarId);
  return {
    supports: (c) =>
      c === "history"
        ? resources.anyAdvertised(c)
        : resources.declares(target.sidecarId, c),
    rpc: actions.rpc(target),
    connectionKey: () => resources.connectionKey(target.sidecarId),
    connected: () => resources.linked(target.sidecarId),
    onToolCompleted: (listener) => session.onToolCompleted(target, listener),
    modelCatalog: session.models,
    directoryCatalog: session.directoryCatalog,
    frecencyCatalog: session.frecencyCatalog,
    approvals: resources.approvals(target.sidecarId),
    feedback: connection.rpc.feedback(target.sessionID),
    sessionID: () => target.sessionID,
    directory: () => actions.directory(target),
    entry: (id) => resources.entry(target.sidecarId, id),
    location: (id) => actions.location(target, id),
    permissions: () => session.state.content.permissions,
    questions: () => session.state.content.questions,
    forms: () =>
      resources.forms(target.sidecarId).filter((f) =>
        f.owner.kind === "session" &&
        belongsToSession(
          f.owner.sessionID,
          target.sessionID,
          (id) => resources.entry(target.sidecarId, id),
        )
      ),
    prefs: o.prefs,
    dirty: (owner, dirty, input) => o.guard.mark(owner, dirty, input),
    act: (action) => actions.act(target, action),
    submit: actions.submission(target),
    history: () => loadHistory(resources.historySources()),
    attachments: (parts) => actions.attachments(parts, target.sidecarId),
    compact: (model) => actions.compact(target, model),
  };
}
