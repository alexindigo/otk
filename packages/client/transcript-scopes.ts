// SPDX-License-Identifier: LGPL-3.0-only
import type { ServerResources } from "./server-resources.ts";
import type { ClientSession, Selection } from "./session.ts";
import type { ProjectSelection } from "./project-navigation.ts";
import { familyTask, sessionFamily, sessionTree } from "./session-tree.ts";
import { inboxStatus } from "./inbox.ts";
import type { ScopeRef } from "./transcripts.ts";
import { sessionKey } from "./index.ts";

export interface TranscriptScopes {
  update(
    value: {
      project?: ProjectSelection;
      selected?: Selection;
      screen: boolean;
    },
  ): void;
  interact(): void;
  stop(): void;
}
/** Metadata determines membership/attention; views supply only accepted scope and visibility. */
export function createTranscriptScopes(
  o: { resources: ServerResources; session: ClientSession },
): TranscriptScopes {
  const { resources, session } = o;
  let project: ProjectSelection | undefined,
    selected: Selection | undefined,
    screen = true;
  let active: ScopeRef | undefined, stopped = false;
  const edges = new Map<
    string,
    {
      kind: string;
      finish?: number;
      permissions: number;
      questions: number;
      error?: string;
    }
  >();
  const membership = (server: string, directory: string, id?: string) => {
    const entries = resources.projectEntries({ sidecarId: server, directory })
      .filter((e) => !e.deleted);
    const tasks = resources.inbox(server).state.inbox.tasks;
    const task = id
      ? familyTask(
        tasks,
        sessionFamily(id, (id) => resources.entry(server, id)),
        directory,
      )
      : undefined;
    const members = task
      ? sessionTree(entries, tasks, directory).find((group) =>
        group.id === task.id
      )?.rows.map((row) => row.session) ?? []
      : entries;
    return {
      scope: {
        sidecarId: server,
        directory,
        ...(task ? { taskID: task.id } : {}),
      },
      sessions: members.map((e) => ({ sidecarId: server, sessionID: e.id })),
    };
  };
  const update = () => {
    if (stopped) return;
    const value = project && resources.inbox(project.sidecarId).state.ready
      ? membership(project.sidecarId, project.directory, selected?.sessionID)
      : undefined;
    active = value?.scope;
    session.demand({
      scope: active,
      sessions: value?.sessions ?? [],
      selected: screen ? selected : undefined,
    });
    if (project) {
      resources.scope(
        project,
        value?.sessions.map((t) => t.sessionID),
      );
    }
  };
  const attention = (server: string, changed?: readonly string[]) => {
    if (!resources.inbox(server).state.ready) return;
    const inbox = resources.inbox(server).state.inbox;
    const present = new Set<string>();
    const entries = changed
      ? changed.flatMap((id) => {
        const entry = resources.entry(server, id);
        return entry ? [entry] : [];
      })
      : resources.indexEntries(server);
    for (const entry of resources.attention(server).entries(entries)) {
      const id = sessionKey(server, entry.id);
      present.add(id);
      const kind = entry.deleted ? "idle" : inboxStatus(entry, inbox);
      const edge = {
        kind,
        finish: kind === "finished" ? inbox.finishes[entry.id] : undefined,
        permissions: entry.attention.permissions +
          entry.attention.childPermissions,
        questions: entry.attention.questions + entry.attention.childQuestions,
        error: entry.attention.error,
      };
      const previous = edges.get(id);
      edges.set(id, edge);
      if (
        kind === "idle" || (previous && previous.kind === edge.kind &&
          previous.finish === edge.finish &&
          edge.permissions <= previous.permissions &&
          edge.questions <= previous.questions &&
          (!edge.error || edge.error === previous.error))
      ) continue;
      const value = membership(server, entry.directory, entry.id);
      session.transcripts.preload(
        { sidecarId: server, sessionID: entry.id },
        value.scope,
        value.sessions,
      );
    }
    if (changed) {
      for (const id of changed) {
        if (!resources.entry(server, id)) {
          edges.delete(sessionKey(server, id));
        }
      }
    } else {for (const id of edges.keys()) {
        if (id.startsWith(server + "/") && !present.has(id)) edges.delete(id);
      }}
  };
  const release = resources.observe({
    frame(server, frame, accepted) {
      if (!accepted) return;
      if (
        frame.t === "index.snapshot" || frame.t === "index.patch" ||
        frame.t === "inbox" || frame.t === "approvals"
      ) {
        const indexed = frame.t === "index.snapshot" ||
          frame.t === "index.patch";
        const reduced = indexed ? resources.indexChanges(server) : undefined;
        const changes = indexed && reduced?.revision === frame.rev
          ? reduced
          : undefined;
        attention(
          server,
          changes && !changes.structural ? changes.ids : undefined,
        );
        if (project?.sidecarId === server && (!changes || changes.structural)) {
          update();
        }
      }
    },
    removed(server) {
      for (const id of edges.keys()) {
        if (id.startsWith(server + "/")) edges.delete(id);
      }
    },
  });
  return {
    update(
      value: {
        project?: ProjectSelection;
        selected?: Selection;
        screen: boolean;
      },
    ) {
      project = value.project;
      selected = value.selected;
      screen = value.screen;
      update();
    },
    interact() {
      if (active) session.transcripts.interact(active);
    },
    stop() {
      stopped = true;
      release();
      edges.clear();
    },
  };
}
