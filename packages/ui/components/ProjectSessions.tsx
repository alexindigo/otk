// SPDX-License-Identifier: LGPL-3.0-only
import "./ProjectSessions.css" with { type: "text" };
import { For, Show } from "solid-js";
import type { InboxSnapshot, IndexEntry } from "@otk/protocol";
import {
  inboxStatus,
  type MergedEntry,
  projectName,
  type ProjectSelection,
  type Selection,
} from "@otk/client";
import StatusLight from "./StatusLight.tsx";
import { ownedAction } from "../keyboard/context.tsx";
/** Interim centre-owned session navigation; task tabs and the panel replace it. */
export default function ProjectSessions(props: {
  entries: MergedEntry[];
  project?: ProjectSelection;
  selected?: Selection;
  connected(id: string): boolean;
  inbox(id: string): InboxSnapshot;
  onOpen(entry: MergedEntry): void;
  onCreate(project: ProjectSelection): void;
}): import("solid-js").Element {
  const roots = () =>
    props.entries.filter((e) =>
      !e.parentID &&
      (!props.project ||
        (e.sidecarId === props.project.sidecarId &&
          e.directory === props.project.directory))
    );
  const open = ownedAction("project.session.open", props.onOpen);
  const create = ownedAction("project.session.new", props.onCreate);
  const projects = () =>
    props.project
      ? [props.project]
      : roots().filter((e, n, all) =>
        all.findIndex((p) =>
          p.sidecarId === e.sidecarId && p.directory === e.directory
        ) === n
      ).map((e) => ({ sidecarId: e.sidecarId, directory: e.directory }));
  return (
    <nav class="otk-project-sessions" aria-label="Project sessions">
      <For each={projects()} keyed={(p) => `${p.sidecarId}/${p.directory}`}>
        {(p) => (
          <section data-session-project={p().directory}>
            <div class="otk-project-session-heading">
              <span title={p().directory}>{projectName(p().directory)}</span>
              <button
                type="button"
                class="otk-new-session"
                aria-label={`New session in ${p().directory}`}
                disabled={!props.connected(p().sidecarId)}
                onClick={() => void create(p())}
              >
                + New session
              </button>
            </div>
            <div class="otk-project-session-list">
              <For
                each={roots().filter((e) =>
                  e.sidecarId === p().sidecarId && e.directory === p().directory
                )}
                keyed={(e) => e.id}
              >
                {(e) => (
                  <button
                    type="button"
                    class="otk-session-row"
                    data-session={e().id}
                    data-status={e().status}
                    aria-current={props.selected?.sidecarId === e().sidecarId &&
                        (props.selected.rootID || props.selected.sessionID) ===
                          e().id
                      ? "page"
                      : undefined}
                    onClick={() => void open(e())}
                  >
                    <StatusLight
                      state={inboxStatus(
                        e() as IndexEntry,
                        props.inbox(e().sidecarId),
                      )}
                      event={e().timeUpdated}
                    />
                    <span class="otk-row-title">{e().title}</span>
                    <Show when={e().status === "retry"}>
                      <span>retry {e().retry?.attempt}</span>
                    </Show>
                    <Show
                      when={e().attention.permissions +
                        e().attention.childPermissions}
                    >
                      <span title="Pending permissions">
                        P {e().attention.permissions +
                          e().attention.childPermissions}
                      </span>
                    </Show>
                    <Show
                      when={e().attention.questions +
                        e().attention.childQuestions}
                    >
                      <span title="Pending questions">
                        Q{" "}
                        {e().attention.questions + e().attention.childQuestions}
                      </span>
                    </Show>
                    <Show when={e().attention.error}>
                      <span
                        title={e().attention.error}
                        aria-label="Session error"
                      >
                        Error
                      </span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </section>
        )}
      </For>
    </nav>
  );
}
