// SPDX-License-Identifier: LGPL-3.0-only
import "./ProjectSessions.css" with { type: "text" };
import { createMemo, createSignal, For, Show } from "solid-js";
import type { InboxSnapshot } from "@otk/protocol";
import {
  inboxStatus,
  type MergedEntry,
  type ProjectSelection,
  type Selection,
  sessionTree,
} from "@otk/client";
import StatusLight from "./StatusLight.tsx";
import { ChevronIcon, PlusIcon, SearchIcon } from "./ChromeIcons.tsx";
import { ownedAction } from "../keyboard/context.tsx";

/** Reusable presentation of the client-owned task/session hierarchy. */
export default function ProjectSessions(props: {
  entries: MergedEntry[];
  project?: ProjectSelection;
  selected?: Selection;
  connected(id: string): boolean;
  inbox(id: string): InboxSnapshot;
  onOpen(entry: MergedEntry): void | Promise<unknown>;
  onPin?(entry: MergedEntry): void | Promise<unknown>;
  onCreate(project: ProjectSelection): void | Promise<unknown>;
}): import("solid-js").Element {
  const [query, setQuery] = createSignal("");
  const [error, setError] = createSignal("");
  const open = ownedAction("project.session.open", props.onOpen);
  const pin = ownedAction(
    "project.session.pin",
    (entry: MergedEntry) => props.onPin?.(entry),
  );
  const create = ownedAction("project.session.new", props.onCreate);
  const run = (promise: Promise<unknown>) =>
    void promise.catch((e) => setError((e as Error).message));
  const groups = createMemo(() => {
    const project = props.project;
    return project
      ? sessionTree(
        props.entries.filter((e) => e.sidecarId === project.sidecarId),
        props.inbox(project.sidecarId).tasks,
        project.directory,
        query(),
      )
      : [];
  });
  const merged = (id: string) =>
    props.entries.find((e) =>
      e.sidecarId === props.project?.sidecarId && e.id === id
    )!;
  return (
    <nav
      class="otk-project-sessions"
      aria-label="Project sessions"
      data-session-project={props.project?.directory}
    >
      <Show when={error()}>
        <p class="otk-error" role="alert">{error()}</p>
      </Show>
      <Show
        when={props.project}
        fallback={
          <p class="otk-muted">Choose a project to browse its sessions.</p>
        }
      >
        <div class="otk-project-session-heading">
          <label class="otk-session-search">
            <SearchIcon />
            <input
              type="search"
              aria-label="Search sessions by title"
              placeholder="Find a session"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            class="otk-icon-button otk-panel-new-session"
            title="New session"
            aria-label={`New session in ${props.project!.directory}`}
            disabled={!props.connected(props.project!.sidecarId)}
            onClick={() => run(create(props.project!))}
          >
            <PlusIcon />
          </button>
        </div>
        <div class="otk-project-session-tree">
          <For each={groups()} keyed={(group) => group.id}>
            {(group) => (
              <section
                class="otk-session-group"
                data-session-group={group().id}
                aria-label={group().title}
              >
                <h3>
                  <ChevronIcon />
                  <span>{group().title}</span>
                  <span class="otk-session-group-rule" />
                </h3>
                <ul class="otk-project-session-list">
                  <For each={group().rows} keyed={(row) => row.session.id}>
                    {(row) => (
                      <li data-depth={row().depth} data-parent={row().parentID}>
                        <button
                          type="button"
                          class="otk-session-row"
                          data-otk-selection="vertical"
                          data-session={row().session.id}
                          data-status={row().session.status}
                          style={{ "--session-depth": row().depth }}
                          title={row().session.title}
                          aria-label={`${row().session.title}${
                            row().parentID
                              ? `, child of ${merged(row().parentID!).title}`
                              : ""
                          }`}
                          aria-current={props.selected?.sidecarId ===
                                props.project!.sidecarId &&
                              props.selected.sessionID === row().session.id
                            ? "page"
                            : undefined}
                          onClick={() =>
                            run(open(merged(row().session.id)))}
                          onDblClick={() =>
                            run(pin(merged(row().session.id)))}
                        >
                          <span class="otk-session-leading">
                            <Show when={row().depth > 0}>
                              <span
                                class="otk-session-indent"
                                aria-hidden="true"
                              >
                                <svg
                                  class="otk-session-branch"
                                  viewBox="0 0 20 30"
                                  fill="none"
                                  stroke="currentColor"
                                >
                                  <path d="M4 0v10a5 5 0 0 0 5 5h7" />
                                </svg>
                              </span>
                            </Show>
                            <StatusLight
                              small
                              state={inboxStatus(
                                row().session,
                                props.inbox(props.project!.sidecarId),
                              )}
                              event={row().session.timeUpdated}
                            />
                          </span>
                          <span class="otk-row-title">
                            {row().session.title}
                          </span>
                          <Show when={row().session.status === "retry"}>
                            <span>retry {row().session.retry?.attempt}</span>
                          </Show>
                          <Show
                            when={row().session.attention.permissions +
                              row().session.attention.childPermissions}
                          >
                            <span title="Pending permissions">
                              P {row().session.attention.permissions +
                                row().session.attention.childPermissions}
                            </span>
                          </Show>
                          <Show
                            when={row().session.attention.questions +
                              row().session.attention.childQuestions}
                          >
                            <span title="Pending questions">
                              Q {row().session.attention.questions +
                                row().session.attention.childQuestions}
                            </span>
                          </Show>
                          <Show when={row().session.attention.error}>
                            <span
                              title={row().session.attention.error}
                              aria-label="Session error"
                            >
                              Error
                            </span>
                          </Show>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={!group().rows.length}>
                  <p class="otk-muted">No sessions</p>
                </Show>
              </section>
            )}
          </For>
          <Show when={!groups().length}>
            <p class="otk-muted">No matching sessions</p>
          </Show>
        </div>
      </Show>
    </nav>
  );
}
