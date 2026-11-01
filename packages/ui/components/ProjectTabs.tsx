// SPDX-License-Identifier: LGPL-3.0-only
import { exactCount, failureText, overflowPreference } from "@otk/client";
import "./ProjectTabs.css" with { type: "text" };
import { selection, sessionState } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
import {
  createMemo,
  createSignal,
  createUniqueId,
  type Element,
  For,
  Show,
} from "solid-js";
import { dynamic } from "@solidjs/web";
import TitleEditor, { TitleFeedback } from "./TitleEditor.tsx";
import type {
  ContentSession,
  InboxSnapshot,
  IndexEntry,
  ModelCatalog,
  TaskRecord,
} from "@otk/protocol";
import {
  type ClientTabs,
  digestLabel,
  inboxStatus,
  type InboxTab,
  type MergedEntry,
  projectName,
  type ProjectSelection,
  type SessionRename,
  summaryMeter,
  type TaskActions,
  taskBreadcrumbs,
} from "@otk/client";
import StatusLight from "./StatusLight.tsx";
import AutoMark from "./AutoMark.tsx";
import UsageCost from "./UsageCost.tsx";
import { ChevronIcon, PlusIcon } from "./ChromeIcons.tsx";
import {
  ownedAction,
  ownedCommand,
  useCommandPorts,
} from "../keyboard/context.tsx";
import Menu from "./surface/Menu.tsx";
import { createTaskControls } from "../features/task-controls.ts";
import { countLabel } from "./tools/count.ts";
import { contextTarget } from "./context-target.ts";
import type { SessionContextTarget } from "../features/session-context.ts";
import OverflowRow from "./OverflowRow.tsx";
import { breadcrumbRows } from "./list-presentation.ts";
import { nativeAttributes } from "./native-attributes.ts";
interface TaskContextTarget extends ProjectSelection {
  taskID: string;
}

/** Presentation and injected actions only; the framework-free tabs owner decides
 * which mandatory, preview and selected-idle tabs exist. */
export default function ProjectTabs(props: {
  project: ProjectSelection;
  model: ClientTabs;
  entries: MergedEntry[];
  inbox: InboxSnapshot;
  catalog?: ModelCatalog;
  entry?: IndexEntry;
  eligible?(target: import("@otk/client").Selection): boolean;
  showCost?: boolean;
  auto?(sessionID: string): boolean;
  session?: ContentSession;
  rename?: SessionRename;
  displayMenu?: Element;
  /** Reserve space for consumer chrome without inspecting its class or state. */
  reserveTrailing?: boolean;
  ready: boolean;
  onOpen(id: string): boolean;
  onEmpty(): boolean;
  onCreateSession(task?: TaskRecord): Promise<void>;
  actions: TaskActions;
}): import("solid-js").Element {
  const { commands } = useCommandPorts();
  const [error, setError] = createSignal("");
  const crumbFeedbackID = createUniqueId();
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
    setError(failureText(error));
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
  const taskAvailable = (target: TaskContextTarget) =>
    target.sidecarId === props.project.sidecarId &&
    target.directory === props.project.directory &&
    tasks().some((task) => task.id === target.taskID);
  const renameTask = (target?: TaskContextTarget) =>
    controls.rename(
      target ? tasks().find((task) => task.id === target.taskID)! : undefined,
    );
  const rename = ownedAction("task.rename", renameTask, {
    context: { kind: "task", title: () => "Rename task" },
    enabled: (_ctx, target) =>
      props.ready && (!target || taskAvailable(target)),
  });
  ownedAction("task.reorder", controls.move);
  const closeTask = (target: TaskContextTarget) =>
    controls.close(target.taskID);
  ownedAction("task.close", closeTask, {
    context: { kind: "task", title: () => "Close task", destructive: true },
    enabled: (_ctx, target) => props.ready && !!target && taskAvailable(target),
  });
  ownedCommand(useCommandPorts(), {
    id: "task.add",
    title: "Add to task",
    category: "Session",
    hidden: true,
    context: {
      kind: "session",
      items: (target: SessionContextTarget & { taskID?: string }) =>
        tasks().filter((task) => !task.sessions.includes(target.sessionID)).map(
          (task) => ({
            key: task.id,
            title: `Add to task: ${task.name}`,
            args: { ...target, taskID: task.id },
          }),
        ),
      order: 20,
    },
    enabled: (_ctx, target?: SessionContextTarget & { taskID?: string }) =>
      props.ready &&
      !!target && (props.eligible?.(target) ?? true) &&
      target?.sidecarId === props.project.sidecarId &&
      target.directory === props.project.directory &&
      tasks().some((task) =>
        task.id === target.taskID && !task.sessions.includes(target.sessionID)
      ),
    run: (_ctx, target: SessionContextTarget & { taskID?: string }) =>
      controls.add({
        task: tasks().find((task) => task.id === target.taskID)!,
        sessionID: target.sessionID,
      }),
  });
  const sessionTarget = (id: string, origin: "tab" | "chip" = "chip") => ({
    kind: "session",
    data: {
      ...props.project,
      sessionID: id,
      origin,
      title: props.session?.id === id
        ? props.session.title
        : entry(id)?.title ?? "Session",
    },
  });
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
    return taskBreadcrumbs(
      task,
      props.entries,
      props.model.state.sessionID,
      props.model.state.closed,
    );
  });
  const required = () =>
    crumbs().filter((c) =>
      c.id === props.model.state.sessionID ||
      props.rename?.matches({
        sidecarId: props.project.sidecarId,
        sessionID: c.id,
      }, "chip")
    ).map((c) => c.id);
  const tabRows = createMemo(() =>
    props.model.tabs().map((tab) => ({ ...tab, key: `${tab.kind}/${tab.id}` }))
  );
  const requiredTabs = () =>
    tabRows().filter((tab) =>
      tab.status !== "idle" ||
      tab.id === props.model.state.selected?.id || tab.kind === "phantom" &&
        props.rename?.matches({
          sidecarId: props.project.sidecarId,
          sessionID: tab.id,
        }, "tab")
    ).map((tab) => tab.key);
  const title = (id: string) =>
    props.session?.id === id
      ? props.session.title
      : entry(id)?.title ?? "Session unavailable";
  const openCrumb = ownedAction("task.session.open", (id: string) => {
    const task = active();
    if (props.onOpen(id)) {
      props.model.select(
        task ? { kind: "task", id: task.id } : { kind: "session", id },
        id,
      );
    }
  });
  const meter = createMemo(() => summaryMeter(props.entry, props.catalog));
  const cost = () =>
    props.entry?.digest.state === "ready"
      ? props.entry.digest.total?.cost ?? undefined
      : undefined;
  const contextRange = () =>
    countLabel(
      meter().limit!,
      "token",
      undefined,
      `${exactCount(meter().tokens!)} of ${exactCount(meter().limit!)}`,
    );
  return (
    <section
      class="otk-project-tabs"
      aria-label="Project tabs"
      data-reserve-trailing={props.reserveTrailing ? "true" : undefined}
    >
      <Show when={error()}>
        <p role="alert" class="otk-error">{error()}</p>
      </Show>
      <div class="otk-task-strip">
        <span
          class="otk-tabs-project otk-control-label"
          title={props.project.directory}
        >
          {projectName(props.project.directory)}
        </span>
        <div
          class="otk-task-list"
          role="tablist"
          aria-label="Tasks and active sessions"
        >
          <OverflowRow
            items={tabRows()}
            required={requiredTabs()}
            wrapRequired
            measure={(tab) => (
              <span class="otk-tab-measure">
                <SelectionContent>
                  <StatusLight small state={tab.status} />
                  <span class="otk-control-label">
                    {tab.title || "Session"}
                  </span>
                  <AutoMark
                    active={tab.sessions.some((id) => !!props.auto?.(id))}
                  />
                  <Show when={tab.preview}>
                    <span class="otk-preview-label">Preview</span>
                  </Show>
                </SelectionContent>
              </span>
            )}
            more={(keys) => (
              <Menu
                class="otk-folded-tasks"
                triggerClass="otk-overflow-trigger"
                label="More tasks"
                trigger="…"
              >
                <For
                  each={tabRows().filter((tab) => keys().includes(tab.key))}
                  keyed={(tab) => tab.key}
                >
                  {(tab) => (
                    <button
                      type="button"
                      data-overflow-tab={tab().id}
                      ref={contextTarget<
                        SessionContextTarget | TaskContextTarget
                      >(() => {
                        const value = tab();
                        return value.kind === "task"
                          ? {
                            kind: "task",
                            data: { ...props.project, taskID: value.id },
                          }
                          : sessionTarget(value.id, "tab");
                      })}
                      data-otk-selection="vertical"
                      {...selection({
                        kind: "selected",
                        selected: props.model.state.selected?.id === tab().id,
                      })}
                      onClick={() => run(select(tab()))}
                    >
                      <SelectionContent>
                        {tab().title || "Session"}
                        <AutoMark
                          active={tab().sessions.some((id) =>
                            !!props.auto?.(id)
                          )}
                        />
                      </SelectionContent>
                    </button>
                  )}
                </For>
              </Menu>
            )}
          >
            {(tab) => {
              const editing = () =>
                tab().kind === "phantom" &&
                props.rename?.matches({
                  sidecarId: props.project.sidecarId,
                  sessionID: tab().id,
                }, "tab");
              const Control = dynamic(() => editing() ? "div" : "button");
              const native = nativeAttributes(() => ({
                onClick: () => {
                  if (!editing()) run(select(tab()));
                },
                onDblClick: () =>
                  !editing() && tab().kind === "phantom" && run(pin(tab().id)),
              }));
              return (
                <div
                  class="otk-tab"
                  ref={contextTarget<SessionContextTarget | TaskContextTarget>(
                    () =>
                      tab().kind === "task"
                        ? {
                          kind: "task",
                          data: { ...props.project, taskID: tab().id },
                        }
                        : sessionTarget(tab().id, "tab"),
                  )}
                  data-kind={tab().kind}
                  data-preview={String(tab().preview)}
                >
                  <Control
                    ref={native.ref}
                    type="button"
                    role="tab"
                    {...selection({
                      class: "otk-tab-open " + (
                        tab().kind === "phantom"
                          ? sessionState(entry(tab().id))
                          : ""
                      ) + (editing() ? " is-editing" : ""),
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
                    data-status={entry(props.model.state.sessionID ?? "")
                      ?.status}
                    {...native.attributes}
                  >
                    <SelectionContent>
                      <StatusLight small state={tab().status} />
                      <span class="otk-control-label">
                        <Show
                          when={editing()}
                          fallback={tab().title || "Session"}
                        >
                          <TitleEditor owner={props.rename!} />
                        </Show>
                      </span>
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
                  </Control>
                </div>
              );
            }}
          </OverflowRow>
        </div>
        <Show when={props.ready}>
          <button
            type="button"
            class="otk-icon-button otk-task-new"
            aria-label="New task"
            title="New task"
            onClick={() => run(rename(undefined))}
          >
            <PlusIcon />
          </button>
        </Show>
        <div class="otk-topbar-end">{props.displayMenu}</div>
      </div>
      <div class="otk-breadcrumb-row">
        <nav class="otk-task-crumbs" aria-label="Task sessions">
          <OverflowRow
            items={breadcrumbRows(crumbs())}
            required={required()}
            preferred={overflowPreference(
              crumbs().map((c) => c.id),
              props.model.state.sessionID,
              (id) => entry(id)?.parentID,
            )}
            measure={(item) => (
              <span class="otk-crumb-measure">
                <Show when={!item.first}>
                  <ChevronIcon class="otk-crumb-chevron" />
                </Show>
                <span class="otk-crumb-measure-content">
                  <StatusLight small state="idle" />
                  {title(item.id)}
                  <AutoMark active={!!props.auto?.(item.id)} />
                </span>
              </span>
            )}
            more={(ids) => (
              <Menu
                class="otk-folded-crumbs"
                triggerClass="otk-overflow-trigger otk-folded-crumbs-trigger"
                label="More task sessions"
                trigger="…"
              >
                <For each={ids()} keyed={(id) => id}>
                  {(id) => (
                    <button
                      type="button"
                      data-overflow-target={id()}
                      ref={contextTarget(() => sessionTarget(id()))}
                      data-otk-selection="vertical"
                      {...selection({
                        kind: "current",
                        selected: props.model.state.sessionID === id(),
                      })}
                      onClick={() => run(openCrumb(id()))}
                    >
                      <SelectionContent>
                        {title(id())}
                        <AutoMark active={!!props.auto?.(id())} />
                      </SelectionContent>
                    </button>
                  )}
                </For>
              </Menu>
            )}
          >
            {(crumb) => {
              const editing = () =>
                props.rename?.matches({
                  sidecarId: props.project.sidecarId,
                  sessionID: crumb().id,
                }, "chip");
              const Control = dynamic(() => editing() ? "div" : "button");
              return (
                <>
                  {(() => {
                    const native = nativeAttributes(() => ({
                      onClick: () => {
                        if (!editing()) run(openCrumb(crumb().id));
                      },
                    }));
                    return (
                      <span class="otk-crumb-link">
                        <Show when={!crumb().first}>
                          <span class="otk-crumb-separator">
                            <ChevronIcon class="otk-crumb-chevron" />
                          </span>
                        </Show>
                        <Control
                          type="button"
                          ref={[
                            contextTarget(() => sessionTarget(crumb().id)),
                            native.ref,
                          ]}
                          {...selection({
                            class: `otk-session-crumb ${
                              sessionState(entry(crumb().id))
                            }${editing() ? " is-editing" : ""}`,
                            kind: "current",
                            selected:
                              props.model.state.sessionID === crumb().id,
                          })}
                          data-otk-selection="horizontal"
                          title={`${
                            title(crumb().id)
                          } · ${props.project.directory}`}
                          data-helper={String(crumb().helper)}
                          data-depth={crumb().depth}
                          data-crumb={crumb().id}
                          aria-label={`${
                            props.session?.id === crumb().id
                              ? props.session.title
                              : entry(crumb().id)?.title ??
                                "Session unavailable"
                          }${
                            props.auto?.(crumb().id) ? ", Auto-approve on" : ""
                          }`}
                          {...native.attributes}
                        >
                          <SelectionContent>
                            <StatusLight
                              small
                              state={entry(crumb().id)
                                ? inboxStatus(entry(crumb().id)!, props.inbox)
                                : "idle"}
                            />
                            <span class="otk-crumb-title">
                              <Show
                                when={editing()}
                                fallback={props.session?.id === crumb().id
                                  ? props.session.title
                                  : entry(crumb().id)?.title ??
                                    "Session unavailable"}
                              >
                                <TitleEditor
                                  owner={props.rename!}
                                  feedbackID={crumbFeedbackID}
                                />
                              </Show>
                            </span>
                            <AutoMark active={!!props.auto?.(crumb().id)} />
                          </SelectionContent>
                        </Control>
                      </span>
                    );
                  })()}
                </>
              );
            }}
          </OverflowRow>
          <Show when={props.ready}>
            <button
              type="button"
              class="otk-new-session"
              onClick={() => run(createSession())}
            >
              <PlusIcon /> Session
            </button>
          </Show>
        </nav>
        <output
          class="otk-context-meter"
          aria-label={props.showCost === false
            ? "Session context"
            : "Session context and cost"}
          title={`${"Session context"}; latest reported context tokens; ${
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
                exactCount(meter().tokens!),
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
            <UsageCost value={cost()!} />
          </Show>
          <Show
            when={meter().tokens === undefined &&
              (props.showCost === false || cost() === undefined)}
          >
            <span>{digestLabel(props.entry)}</span>
          </Show>
        </output>
      </div>
      <Show
        when={crumbs().some((crumb) => props.rename?.matches({
          sidecarId: props.project.sidecarId,
          sessionID: crumb.id,
        }, "chip"))}
      >
        <div class="otk-crumb-feedback">
          <TitleFeedback owner={props.rename!} id={crumbFeedbackID} />
        </div>
      </Show>
    </section>
  );
}
