// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ClientSession,
  type ClientTabs,
  inboxStatus,
  loadHistory,
  runningWork,
  type Selection,
  type ServerResources,
  type SessionActions,
} from "@otk/client";
import {
  belongsToSession,
  type PermissionRequest,
  type Preferences,
} from "@otk/protocol";
import type { SessionPorts } from "../registries/session.tsx";

/** Plain binding: capture identity once, delegate every live read and intent. */
export function sessionPorts(o: {
  target: Selection;
  resources: ServerResources;
  actions: SessionActions;
  session: ClientSession;
  guard: { mark(owner: string, dirty: boolean, input?: string): void };
  prefs(): Preferences;
  tabs?(): ClientTabs | undefined;
  permissionVisible?(sidecar: string, request: PermissionRequest): boolean;
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
    failureTarget: () => ({
      ...target,
      label: resources.entry(target.sidecarId, target.sessionID)?.title,
    }),
    directory: () => actions.directory(target),
    entry: (id) => resources.entry(target.sidecarId, id),
    status: (id) => {
      const entry = resources.entry(target.sidecarId, id);
      return entry
        ? inboxStatus(entry, resources.inbox(target.sidecarId).state.inbox)
        : undefined;
    },
    location: (id) => actions.location(target, id),
    runningWork: () => {
      const tabs = o.tabs?.();
      return tabs
        ? runningWork({
          tabs,
          inbox: resources.inbox(target.sidecarId).state.inbox,
          sessionID: target.sessionID,
          entry: (id) => resources.entry(target.sidecarId, id),
          messages: Object.values(session.transcript?.state.messagesByID ?? {}),
          connected: resources.linked(target.sidecarId),
        })
        : [];
    },
    stopHelper: (id) => actions.abort({ ...target, sessionID: id }),
    requests: connection.attention,
    permissions: () => {
      void session.state.content;
      return connection.attention.permissions(
        target.sessionID,
        (id) => resources.entry(target.sidecarId, id),
        true,
      );
    },
    permissionVisible: o.permissionVisible
      ? (request) => o.permissionVisible!(target.sidecarId, request)
      : undefined,
    questions: () => {
      void session.state.content;
      return connection.attention.questions(
        target.sessionID,
        (id) => resources.entry(target.sidecarId, id),
        true,
      );
    },
    forms: () =>
      resources.forms(target.sidecarId).filter((f) =>
        !connection.attention.get("form", f.id)?.dismissed &&
        f.owner.kind === "session" &&
        f.presentation !== "question" &&
        !session.state.content.questions.some((question) =>
          question.id === f.id
        ) &&
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
