// SPDX-License-Identifier: LGPL-3.0-only
import "./ProjectTabs.css" with { type: "text" };
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
import { createMemo, createSignal, type Element, For, Show } from "solid-js";
import type {
  ContentSession,
  InboxSnapshot,
  Message,
  ModelCatalog,
  TaskRecord,
  UsageTotal,
} from "@otk/protocol";
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
import AutoMark from "./AutoMark.tsx";
import { ChevronIcon, PlusIcon } from "./ChromeIcons.tsx";
import { ownedAction, useCommandPorts } from "../keyboard/context.tsx";
import Menu from "./surface/Menu.tsx";
import { createTaskControls } from "../features/task-controls.ts";
import { countLabel } from "./tools/count.ts";

/** Presentation and injected actions only; the framework-free tabs owner decides
 * which mandatory, preview and selected-idle tabs exist. */
export default function ProjectTabs(props: {
  project: ProjectSelection;
  model: ClientTabs;
  entries: MergedEntry[];
  inbox: InboxSnapshot;
  messages: Message[];
  catalog?: ModelCatalog;
  usage?: UsageTotal;
  exhausted: boolean;
  showCost?: boolean;
  auto?(sessionID: string): boolean;
  session?: ContentSession;
  displayMenu?: Element;
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
  const controls = createTaskControls({
    commands,
    actions: () => props.actions,
    model: () => props.model,
    tasks,
    onEmpty: () => props.onEmpty(),
  });
  const pin = ownedAction("task.pin", controls.pin);
  const rename = ownedAction("task.rename", controls.rename);
  ownedAction("task.reorder", controls.move);
  ownedAction("task.close", controls.close);
  ownedAction("task.add", controls.add);
  const createSession = ownedAction(
    "task.session.new",
    () => props.onCreateSession(active()),
  );
  const crumbs = createMemo(() => {
    const task = active();
    if (!task) {
      return props.session
        ? [{ id: props.session.id, helper: !!props.session.parentID, depth: 0 }]
        : [];
    }
    return taskBreadcrumbs(task, props.entries, props.model.state.sessionID);
  });
  const visibleCrumb = (n: number) =>
    crumbs().length <= 7 || n < 2 || n >= crumbs().length - 2 ||
    Math.abs(
        n - crumbs().findIndex((c) => c.id === props.model.state.sessionID),
      ) <= 1;
  const openCrumb = ownedAction("task.session.open", (id: string) => {
    const task = active();
    if (props.onOpen(id)) {
      props.model.select(
        task ? { kind: "task", id: task.id } : { kind: "session", id },
        id,
      );
    }
  });
  const meter = createMemo(() => contextMeter(props.messages, props.catalog));
  const cost = () => props.usage?.cost;
  const contextRange = () =>
    countLabel(
      meter().limit!,
      "token",
      undefined,
      `${meter().tokens!.toLocaleString("en-US")} of ${
        meter().limit!.toLocaleString("en-US")
      }`,
    );
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
                  {...selection({
                    class: "otk-tab-open",
                    kind: "selected",
                    selected: props.model.state.selected?.id === tab().id,
                  })}
                  data-otk-selection="horizontal"
                  title={tab().title}
                  aria-label={`${tab().title || "Session"}${
                    tab().sessions.some((id) => !!props.auto?.(id))
                      ? tab().kind === "task"
                        ? ", Auto-approve is on for a session in this task"
                        : ", Auto-approve on"
                      : ""
                  }`}
                  data-tab={tab().id}
                  data-status={entry(props.model.state.sessionID ?? "")?.status}
                  onClick={() => run(select(tab()))}
                  onDblClick={() =>
                    tab().kind === "phantom" && run(pin(tab().id))}
                >
                  <SelectionContent>
                    <StatusLight small state={tab().status} />
                    <span>{tab().title || "Session"}</span>
                    <AutoMark
                      active={tab().sessions.some((id) => !!props.auto?.(id))}
                      label={tab().kind === "task"
                        ? "Auto-approve is on for a session in this task"
                        : undefined}
                    />
                    <Show when={tab().preview}>
                      <span class="otk-preview-label">Preview</span>
                    </Show>
                  </SelectionContent>
                </button>
              </div>
            )}
          </For>
        </div>
        <button
          type="button"
          class="otk-icon-button otk-task-new"
          aria-label="New task"
          title="New task"
          disabled={!props.ready}
          onClick={() => run(rename(undefined))}
        >
          <PlusIcon />
        </button>
        <div class="otk-topbar-end">{props.displayMenu}</div>
      </div>
      <div class="otk-breadcrumb-row">
        <nav class="otk-task-crumbs" aria-label="Task sessions">
          <For each={crumbs()} keyed={(c) => c.id}>
            {(crumb, n) => (
              <Show
                when={visibleCrumb(n())}
                fallback={
                  <Show when={n() === 0 || visibleCrumb(n() - 1)}>
                    <Menu
                      class="otk-folded-crumbs"
                      label="More task sessions"
                      trigger="…"
                    >
                      <For
                        each={crumbs().filter((_, i) => !visibleCrumb(i))}
                        keyed={(c) => c.id}
                      >
                        {(c) => (
                          <button
                            type="button"
                            data-otk-selection="vertical"
                            {...selection({
                              kind: "current",
                              selected: props.model.state.sessionID === c().id,
                            })}
                            onClick={() => run(openCrumb(c().id))}
                            aria-label={`${entry(c().id)?.title ?? c().id}${
                              props.auto?.(c().id) ? ", Auto-approve on" : ""
                            }`}
                          >
                            <SelectionContent>
                              {entry(c().id)?.title ?? c().id}
                              <AutoMark active={!!props.auto?.(c().id)} />
                            </SelectionContent>
                          </button>
                        )}
                      </For>
                    </Menu>
                  </Show>
                }
              >
                <span class="otk-crumb-link">
                  <Show when={n() > 0}>
                    <span class="otk-crumb-separator">
                      <ChevronIcon />
                    </span>
                  </Show>
                  <button
                    type="button"
                    {...selection({
                      class: "otk-session-crumb",
                      kind: "current",
                      selected: props.model.state.sessionID === crumb().id,
                    })}
                    data-otk-selection="horizontal"
                    title={props.project.directory}
                    data-helper={String(crumb().helper)}
                    data-depth={crumb().depth}
                    data-crumb={crumb().id}
                    aria-label={`${
                      props.session?.id === crumb().id
                        ? props.session.title
                        : entry(crumb().id)?.title ?? "Session unavailable"
                    }${props.auto?.(crumb().id) ? ", Auto-approve on" : ""}`}
                    onClick={() => run(openCrumb(crumb().id))}
                  >
                    <SelectionContent>
                      <StatusLight
                        small
                        state={entry(crumb().id)
                          ? inboxStatus(entry(crumb().id)!, props.inbox)
                          : "idle"}
                      />
                      <span class="otk-crumb-title">
                        {props.session?.id === crumb().id
                          ? props.session.title
                          : entry(crumb().id)?.title ?? "Session unavailable"}
                      </span>
                      <AutoMark active={!!props.auto?.(crumb().id)} />
                    </SelectionContent>
                  </button>
                </span>
              </Show>
            )}
          </For>
          <button
            type="button"
            class="otk-new-session"
            disabled={!props.ready}
            onClick={() => run(createSession())}
          >
            <PlusIcon /> Session
          </button>
        </nav>
        <output
          class="otk-context-meter"
          aria-label={props.showCost === false
            ? "Session context"
            : "Session context and cost"}
          title={`${
            props.exhausted ? "Session context" : "Context from loaded messages"
          }; latest reported context tokens; ${
            meter().limit === undefined
              ? "context window unavailable"
              : `${contextRange()} (${
                (meter().tokens! / meter().limit! * 100).toFixed(1)
              }%)`
          }`}
          data-tokens={meter().tokens}
          data-cost={props.showCost === false ? undefined : cost()}
          data-limit={meter().limit}
        >
          <Show when={meter().tokens !== undefined}>
            <span>
              {countLabel(
                meter().tokens!,
                "token",
                undefined,
                meter().tokens!.toLocaleString("en-US"),
              )}
            </span>
            <Show when={meter().fraction !== undefined}>
              <span
                class="otk-context-bar"
                role="meter"
                aria-label="Context window used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={meter().fraction! * 100}
                aria-valuetext={contextRange()}
              >
                <span style={{ width: `${meter().fraction! * 100}%` }} />
              </span>
            </Show>
          </Show>
          <Show when={props.showCost !== false && cost() !== undefined}>
            <span>${cost()!.toFixed(4)}</span>
          </Show>
          <Show
            when={meter().tokens === undefined &&
              (props.showCost === false || cost() === undefined)}
          >
            <span>No usage reported</span>
          </Show>
        </output>
      </div>
    </section>
  );
}
