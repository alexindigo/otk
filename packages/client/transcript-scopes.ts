// SPDX-License-Identifier: LGPL-3.0-only
import type { ServerResources } from "./server-resources.ts";
import type { ClientSession, Selection } from "./session.ts";
import type { ProjectSelection } from "./project-navigation.ts";
import type { ScopeRef } from "./transcripts.ts";

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
/** Shared family metadata owns orientation; only selected/visible demand admits bodies. */
export function createTranscriptScopes(
  o: { resources: ServerResources; session: ClientSession },
): TranscriptScopes {
  const { resources, session } = o;
  let project: ProjectSelection | undefined,
    selected: Selection | undefined,
    screen = true;
  let active: ScopeRef | undefined, stopped = false;
  let previous: unknown,
    previousProject: ProjectSelection | undefined,
    previousSelected: Selection | undefined,
    previousScreen: boolean | undefined;
  const update = () => {
    if (stopped) return;
    const input = project && resources.inbox(project.sidecarId).state.ready
      ? resources.tabSnapshot(project)
      : undefined;
    if (
      input === previous &&
      project?.sidecarId === previousProject?.sidecarId &&
      project?.directory === previousProject?.directory &&
      selected?.sidecarId === previousSelected?.sidecarId &&
      selected?.sessionID === previousSelected?.sessionID &&
      screen === previousScreen
    ) return;
    previous = input;
    previousProject = project;
    previousSelected = selected;
    previousScreen = screen;
    const tabs = project && input ? resources.tabs(project) : undefined;
    if (tabs && input) tabs.update(input);
    const task = selected && tabs?.taskFor(selected.sessionID);
    active = project && input && selected
      ? { ...project, ...(task ? { taskID: task.id } : {}) }
      : undefined;
    const target =
      selected && project?.sidecarId === selected.sidecarId && input
        ? { sidecarId: selected.sidecarId, sessionID: selected.sessionID }
        : undefined;
    // Crumbs borrow metadata from the same selector; they never acquire transcripts.
    resources.scope(
      project,
      selected ? [selected.sessionID] : [],
      selected,
      tabs?.crumbs().map((crumb) => crumb.id) ?? [],
    );
    session.demand({
      scope: active,
      sessions: target ? [target] : [],
      selected: screen ? selected : undefined,
    });
  };
  const release = resources.observe({
    frame(server, frame, accepted) {
      if (!accepted || project?.sidecarId !== server) return;
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        if (resources.indexChanges(server)?.metadata.length) update();
      } else if (
        frame.t === "inbox.snapshot" || frame.t === "inbox.patch" ||
        frame.t === "approvals"
      ) update();
    },
  });
  return {
    update(value) {
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
    },
  };
}
