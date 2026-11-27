// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ClientSession,
  type ClientTabs,
  createLiveWork,
  entityFacts,
  lamp,
  liveWork as entityLiveWork,
  loadHistory,
  permissionVisible,
  type Selection,
  type ServerResources,
  type SessionActions,
  sessionShells,
} from "@otk/client";
import {
  belongsToSession,
  derivedValue,
  entityKey,
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
}): SessionPorts {
  const target = { ...o.target }, { resources, actions, session } = o;
  const connection = resources.sidecars.connection(target.sidecarId);
  const entities = () => resources.inbox(target.sidecarId).entities;
  const sessionKey = entityKey("session", target.sessionID);
  const shells = () => sessionShells(entities(), sessionKey);
  const rpc = actions.rpc(target);
  const liveWork = createLiveWork({
    items: () => [
      ...(entityLiveWork(entities(), sessionKey) ?? []).flatMap((item) =>
        item.kind === "helper"
          ? [{
            ...item,
            kind: item.kind,
            sessionID: item.id,
            label: derivedValue(
              resources.entry(target.sidecarId, item.id)?.digest.last,
            )?.agent ?? item.label,
          }]
          : []
      ),
      ...(shells()?.items ?? []).map((item) => ({
        ...item,
        kind: "shell" as const,
        sessionID: target.sessionID,
      })),
    ],
    stopHelper: () =>
      resources.linked(target.sidecarId) &&
        resources.declares(target.sidecarId, "prompt")
        ? (id) => actions.abort({ ...target, sessionID: id })
        : undefined,
    stopShell: () =>
      resources.linked(target.sidecarId) &&
        resources.declares(target.sidecarId, "shell.terminate")
        ? async (shellID) => {
          await rpc("shell.terminate", {
            sessionID: target.sessionID,
            shellID,
          });
        }
        : undefined,
  });
  return {
    supports: (c) =>
      c === "history"
        ? resources.anyAdvertised(c)
        : resources.declares(target.sidecarId, c),
    rpc,
    connectionKey: () => resources.connectionKey(target.sidecarId),
    connected: () => resources.linked(target.sidecarId),
    onToolCompleted: (listener) => session.onToolCompleted(target, listener),
    modelCatalog: session.models,
    directoryCatalog: session.directoryCatalog,
    frecencyCatalog: session.frecencyCatalog,
    approvals: resources.approvals(target.sidecarId),
    feedback: connection.rpc.feedback(target.sessionID),
    sessionID: () => target.sessionID,
    composerTarget: () => {
      const title =
        resources.entry(target.sidecarId, target.sessionID)?.title ??
          (session.state.info?.id === target.sessionID
            ? session.state.info.title
            : target.sessionID);
      const task = o.tabs?.()?.taskFor(target.sessionID);
      return {
        task: task && task.name !== title ? task.name : undefined,
        session: title,
      };
    },
    failureTarget: () => ({
      ...target,
      label: resources.entry(target.sidecarId, target.sessionID)?.title,
    }),
    directory: () => actions.directory(target),
    entry: (id) => resources.entry(target.sidecarId, id),
    entities,
    entityFacts: (identity) =>
      entityFacts(identity, {
        entities: entities(),
        session: (id) => ({
          title: resources.entry(target.sidecarId, id)?.title,
        }),
      }),
    status: (id) => lamp(entities(), entityKey("session", id)),
    location: (id) => actions.location(target, id),
    liveWork,
    delivery: actions.delivery(target),
    shells,
    trail: () => o.tabs?.()?.trail(),
    stopHelper: (id) => actions.abort({ ...target, sessionID: id }),
    clearFinished: (task) =>
      resources.inbox(target.sidecarId).clearAttention({
        scope: "helpers",
        task,
      }),
    requests: connection.attention,
    permissions: () => {
      void session.state.content;
      return connection.attention.permissions(
        target.sessionID,
        (id) => resources.entry(target.sidecarId, id),
        true,
      );
    },
    permissionVisible: (request) =>
      permissionVisible(
        entities(),
        request.sessionID,
        request.id,
        !resources.linked(target.sidecarId) &&
          connection.attention.draft("permission", request.id)
          ? "cached-draft"
          : "fresh",
      ),
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
