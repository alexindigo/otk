// SPDX-License-Identifier: LGPL-3.0-only
import "./ProjectTabs.css" with { type: "text" };
import { createMemo, createSignal, For, Show } from "solid-js";
import type { InboxSnapshot, Message, TaskRecord } from "@otk/protocol";
import {
  type ClientTabs,
  contextMeter,
  inboxStatus,
  type InboxTab,
  type MergedEntry,
  projectName,
  type ProjectSelection,
  type TaskActions,
  taskBreadcrumbs,
} from "@otk/client";
import StatusLight from "./StatusLight.tsx";
import { ownedAction, useCommandPorts } from "../keyboard/context.tsx";

/** Presentation and injected actions only; the framework-free tabs owner decides
 * which mandatory, preview and selected-idle tabs exist. */
export default function ProjectTabs(props: {
  project: ProjectSelection;
  model: ClientTabs;
  entries: MergedEntry[];
  inbox: InboxSnapshot;
  messages: Message[];
  exhausted: boolean;
  ready: boolean;
  onOpen(id: string): boolean;
  onEmpty(): boolean;
  onCreateSession(task?: TaskRecord): Promise<void>;
  actions: TaskActions;
}): import("solid-js").Element {
  const { commands } = useCommandPorts();
  const [error, setError] = createSignal("");
  const tasks = () =>
    props.inbox.tasks.filter((t) => t.directory === props.project.directory)
      .sort((a, b) => a.order - b.order);
  const active = () =>
    tasks().find((t) =>
      props.model.state.selected?.kind === "task" &&
      t.id === props.model.state.selected.id
    );
  const entry = (id: string) => props.entries.find((e) => e.id === id);
  const fail = (error: unknown) => {
    setError((error as Error).message);
  };
  const run = (action: Promise<unknown>) => {
    void action.catch(fail);
  };
  const select = ownedAction("tabs.select", (tab: InboxTab) => {
    if (tab.kind === "phantom") {
      if (props.onOpen(tab.id)) {
        props.model.select({ kind: "session", id: tab.id });
      }
      return;
    }
    const id = props.model.sessionFor(tab.id);
    if (id ? props.onOpen(id) : props.onEmpty()) {
      props.model.select({ kind: "task", id: tab.id }, id);
    }
  });
  const name = (task?: TaskRecord) => {
    const actions = props.actions, model = props.model;
    run(commands.run("dialog.open", {
      id: "task-name",
      input: {
        name: task?.name,
        save: async (name: string) => {
          if (task) await actions.rename(task.id, name);
          else {
            const created = await actions.create(name);
            if (props.model === model && props.onEmpty()) {
              model.select({ kind: "task", id: created.id });
            }
          }
        },
      },
    }));
  };
  const reorder = async (task: TaskRecord, delta: number) => {
    const ids = tasks().map((t) => t.id),
      from = ids.indexOf(task.id),
      to = from + delta;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    await props.actions.reorder(ids);
  };
  const pin = ownedAction("task.pin", (id: string) => props.model.pin(id));
  const rename = ownedAction("task.rename", (task?: TaskRecord) => name(task));
  const move = ownedAction(
    "task.reorder",
    (input: { task: TaskRecord; delta: number }) =>
      reorder(input.task, input.delta),
  );
  const close = ownedAction(
    "task.close",
    (id: string) => props.actions.close(id),
  );
  const add = ownedAction(
    "task.add",
    (input: { task: TaskRecord; sessionID: string }) =>
      props.actions.add(input.task, input.sessionID),
  );
  const createSession = ownedAction(
    "task.session.new",
    () => props.onCreateSession(active()),
  );
  const crumbs = createMemo(() => {
    const task = active();
    if (!task) return [];
    return taskBreadcrumbs(task, props.entries, props.model.state.sessionID);
  });
  const visibleCrumb = (n: number) =>
    crumbs().length <= 7 || n < 2 || n >= crumbs().length - 2 ||
    Math.abs(
        n - crumbs().findIndex((c) => c.id === props.model.state.sessionID),
      ) <= 1;
  const openCrumb = ownedAction("task.session.open", (id: string) => {
    const task = active();
    if (task && props.onOpen(id)) {
      props.model.select({ kind: "task", id: task.id }, id);
    }
  });
  const meter = createMemo(() => contextMeter(props.messages));
  return (
    <section class="otk-project-tabs" aria-label="Project tabs">
      <Show when={error()}>
        <p role="alert" class="otk-error">{error()}</p>
      </Show>
      <div class="otk-task-strip">
        <span class="otk-tabs-project" title={props.project.directory}>
          {projectName(props.project.directory)}
        </span>
        <div
          class="otk-task-list"
          role="tablist"
          aria-label="Tasks and active sessions"
        >
          <For each={props.model.tabs()} keyed={(t) => `${t.kind}/${t.id}`}>
            {(tab) => (
              <div
                class="otk-tab"
                data-kind={tab().kind}
                data-preview={String(tab().preview)}
              >
                <button
                  type="button"
                  role="tab"
                  class="otk-tab-open"
                  data-tab={tab().id}
                  data-status={entry(props.model.state.sessionID ?? "")?.status}
                  aria-selected={props.model.state.selected?.id === tab().id
                    ? "true"
                    : "false"}
                  aria-current={props.model.state.selected?.id === tab().id
                    ? "page"
                    : undefined}
                  onClick={() => run(select(tab()))}
                  onDblClick={() =>
                    tab().kind === "phantom" && run(pin(tab().id))}
                >
                  <StatusLight small state={tab().status} />
                  <span>{tab().title || "Session"}</span>
                  <Show when={tab().preview}>
                    <span class="otk-preview-label">Preview</span>
                  </Show>
                </button>
                <details class="otk-tab-actions">
                  <summary aria-label={`Actions for ${tab().title}`}>⋯</summary>
                  <div
                    class="otk-tab-menu"
                    onClick={(e) =>
                      e.currentTarget.closest("details")?.removeAttribute(
                        "open",
                      )}
                  >
                    <Show
                      when={tab().kind === "task"}
                      fallback={
                        <>
                          <button
                            type="button"
                            disabled={!props.ready}
                            onClick={() => run(pin(tab().id))}
                          >
                            Pin as task
                          </button>
                          <For
                            each={tasks()}
                            keyed={(t) => t.id}
                          >
                            {(task) => (
                              <button
                                type="button"
                                disabled={!props.ready}
                                onClick={() =>
                                  run(
                                    add({ task: task(), sessionID: tab().id }),
                                  )}
                              >
                                Add to task: {task().name}
                              </button>
                            )}
                          </For>
                        </>
                      }
                    >
                      <button
                        type="button"
                        disabled={!props.ready}
                        onClick={() =>
                          run(rename(tasks().find((t) => t.id === tab().id)))}
                      >
                        Rename task
                      </button>
                      <button
                        type="button"
                        disabled={!props.ready || tasks()[0]?.id === tab().id}
                        onClick={() =>
                          run(
                            move({
                              task: tasks().find((t) => t.id === tab().id)!,
                              delta: -1,
                            }),
                          )}
                      >
                        Move task left
                      </button>
                      <button
                        type="button"
                        disabled={!props.ready ||
                          tasks().at(-1)?.id === tab().id}
                        onClick={() =>
                          run(
                            move({
                              task: tasks().find((t) => t.id === tab().id)!,
                              delta: 1,
                            }),
                          )}
                      >
                        Move task right
                      </button>
                      <button
                        type="button"
                        disabled={!props.ready}
                        onClick={() => run(close(tab().id))}
                      >
                        Close task
                      </button>
                    </Show>
                  </div>
                </details>
              </div>
            )}
          </For>
        </div>
        <button
          type="button"
          class="otk-task-new"
          aria-label="New task"
          disabled={!props.ready}
          onClick={() => run(rename(undefined))}
        >
          +
        </button>
      </div>
      <div class="otk-breadcrumb-row">
        <nav class="otk-task-crumbs" aria-label="Task sessions">
          <Show when={active()}>
            <span class="otk-crumb-task">{active()!.name}</span>
          </Show>
          <For each={crumbs()} keyed={(c) => c.id}>
            {(crumb, n) => (
              <Show
                when={visibleCrumb(n())}
                fallback={
                  <Show when={n() === 0 || visibleCrumb(n() - 1)}>
                    <details class="otk-folded-crumbs">
                      <summary aria-label="More task sessions">…</summary>
                      <div class="otk-tab-menu">
                        <For
                          each={crumbs().filter((_, i) => !visibleCrumb(i))}
                          keyed={(c) => c.id}
                        >
                          {(c) => (
                            <button
                              type="button"
                              onClick={() => run(openCrumb(c().id))}
                            >
                              {entry(c().id)?.title ?? c().id}
                            </button>
                          )}
                        </For>
                      </div>
                    </details>
                  </Show>
                }
              >
                <button
                  type="button"
                  class="otk-session-crumb"
                  data-helper={String(crumb().helper)}
                  data-depth={crumb().depth}
                  data-crumb={crumb().id}
                  aria-current={props.model.state.sessionID === crumb().id
                    ? "page"
                    : undefined}
                  onClick={() => run(openCrumb(crumb().id))}
                >
                  <span aria-hidden="true">{crumb().helper ? "└" : "›"}</span>
                  <span>
                    {entry(crumb().id)?.title ?? "Session unavailable"}
                  </span>
                  <StatusLight
                    small
                    state={entry(crumb().id)
                      ? inboxStatus(entry(crumb().id)!, props.inbox)
                      : "idle"}
                  />
                </button>
              </Show>
            )}
          </For>
          <button
            type="button"
            class="otk-new-session"
            disabled={!props.ready}
            onClick={() => run(createSession())}
          >
            + session
          </button>
        </nav>
        <output
          class="otk-context-meter"
          aria-label="Session context and cost"
          title={`${
            props.exhausted ? "Loaded session" : "Loaded messages only"
          }; latest reported context tokens; context window unavailable`}
          data-tokens={meter().tokens}
          data-cost={meter().cost}
        >
          <Show when={meter().tokens !== undefined}>
            <span>{meter().tokens!.toLocaleString("en-US")} tokens</span>
          </Show>
          <Show when={meter().cost !== undefined}>
            <span>${meter().cost!.toFixed(4)}</span>
          </Show>
          <Show
            when={meter().tokens === undefined && meter().cost === undefined}
          >
            <span>No usage reported</span>
          </Show>
        </output>
      </div>
    </section>
  );
}
