// SPDX-License-Identifier: LGPL-3.0-only
import { hashFor, sessionSummary } from "@otk/client";
import { exactCount, failureText, overflowPreference } from "@otk/client";
import "./ProjectTabs.css" with { type: "text" };
import { selection, sessionState } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  type Element,
  For,
  onCleanup,
  onSettled,
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
} from "@otk/client";
import StatusLight from "./StatusLight.tsx";
import EdgeTriangle from "./EdgeTriangle.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
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
  entries?: MergedEntry[];
  currentEntry?(id: string): IndexEntry | undefined;
  inbox: InboxSnapshot;
  catalog?: ModelCatalog;
  entry?: IndexEntry;
  eligible?(target: import("@otk/client").Selection): boolean;
  showCost?: boolean;
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
  const tasks = () => props.model.tasks();
  const active = () =>
    tasks().find((t) =>
      props.model.state.selected?.kind === "task" &&
      t.id === props.model.state.selected.id
    );
  const entry = (id: string) => props.model.entry(id);
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
  }, {
    arguments: {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["phantom", "task"] },
      },
    },
  });
  let controlOwner = props.model, controlLifetime = new AbortController();
  const controlSignal = () => {
    const owner = props.model;
    if (owner !== controlOwner) {
      controlLifetime.abort();
      controlOwner = owner;
      controlLifetime = new AbortController();
    }
    return controlLifetime.signal;
  };
  createEffect(() => props.model, () => {
    controlSignal();
  });
  onCleanup(() => controlLifetime.abort());
  const controls = createTaskControls({
    commands,
    get signal() {
      return controlSignal();
    },
    actions: () => props.actions,
    model: () => props.model,
    tasks,
    onEmpty: () => props.onEmpty(),
  });
  const pin = ownedAction("task.pin", controls.pin, {
    arguments: { type: "string" },
  });
  const taskAvailable = (target: TaskContextTarget) =>
    target.sidecarId === props.project.sidecarId &&
    tasks().some((task) =>
      task.id === target.taskID && task.directory === target.directory
    );
  const renameTask = (target: TaskContextTarget | undefined) =>
    controls.rename(
      target ? tasks().find((task) => task.id === target.taskID)! : undefined,
    );
  const rename = ownedAction("task.rename", renameTask, {
    arguments: {
      type: "object",
      optional: true,
      properties: {
        sidecarId: { type: "string" },
        directory: { type: "string" },
        taskID: { type: "string" },
      },
    },
    context: { kind: "task", title: () => "Rename task" },
    enabled: (_ctx, target) =>
      props.ready && (!target || taskAvailable(target)),
  });
  ownedAction("task.reorder", controls.move, {
    arguments: {
      type: "object",
      properties: {
        task: {
          type: "object",
          properties: { id: { type: "string" }, directory: { type: "string" } },
        },
        delta: { type: "number" },
      },
    },
  });
  const closeTask = (target: TaskContextTarget) =>
    controls.close(target.taskID);
  ownedAction("task.close", closeTask, {
    arguments: {
      type: "object",
      properties: {
        sidecarId: { type: "string" },
        directory: { type: "string" },
        taskID: { type: "string" },
      },
    },
    context: { kind: "task", title: () => "Close task", destructive: true },
    enabled: (_ctx, target) => props.ready && !!target && taskAvailable(target),
  });
  ownedCommand(useCommandPorts(), {
    id: "task.add",
    title: "Add to task",
    category: "Session",
    arguments: {
      type: "object",
      properties: {
        sidecarId: { type: "string" },
        sessionID: { type: "string" },
        taskID: { type: "string" },
      },
    },
    context: {
      kind: "session",
      items: (target: SessionContextTarget & { taskID?: string }) =>
        tasks().filter((task) =>
          task.directory === target.directory &&
          !task.sessions.includes(target.sessionID)
        ).map(
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
      tasks().some((task) =>
        task.id === target.taskID && task.directory === target.directory &&
        !task.sessions.includes(target.sessionID)
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
      directory: entry(id)?.directory ?? props.project.directory,
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
  const tabs = createMemo(() => props.model.tabs());
  const openTitle = () => {
    const id = props.model.state.sessionID;
    return id
      ? (props.session?.id === id ? props.session.title : entry(id)?.title)
      : undefined;
  };
  const separateTitle = () => {
    const current = openTitle();
    return current &&
        tabs().find((tab) => tab.id === props.model.state.selected?.id)
            ?.title !== current
      ? current
      : undefined;
  };
  const crumbs = createMemo(() => {
    tabs();
    return props.model.crumbs();
  });
  const required = () =>
    crumbs().filter((c) =>
      c.helper || c.id === props.model.state.sessionID ||
      props.rename?.matches({
        sidecarId: props.project.sidecarId,
        sessionID: c.id,
      }, "chip")
    ).map((c) => c.id);
  const tabRows = createMemo(() =>
    tabs().map((tab) => ({ ...tab, key: `${tab.kind}/${tab.id}` }))
  );
  let lane!: HTMLDivElement;
  const [edges, setEdges] = createSignal({ previous: false, next: false });
  const updateEdges = () =>
    setEdges({
      previous: lane.scrollLeft > 1,
      next: lane.scrollLeft + lane.clientWidth < lane.scrollWidth - 1,
    });
  const revealActive = () => {
    lane.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
    updateEdges();
  };
  const activeTabKey = createMemo(() =>
    JSON.stringify([
      props.project.sidecarId,
      props.project.directory,
      props.model.state.selected?.kind,
      props.model.state.selected?.id,
    ])
  );
  createEffect(
    activeTabKey,
    () =>
      onSettled(() => {
        if (lane?.isConnected) revealActive();
      }),
  );
  onSettled(() => {
    const observer = new ResizeObserver(revealActive);
    observer.observe(lane);
    revealActive();
    return () => observer.disconnect();
  });
  const pageTabs = (direction: "previous" | "next") => {
    const bounds = lane.getBoundingClientRect();
    const tabs = [...lane.querySelectorAll<HTMLElement>(".otk-tab")];
    const visible = tabs.filter((tab) => {
      const box = tab.getBoundingClientRect();
      return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
    });
    const boundary = direction === "next" ? visible.at(-1) : visible[0];
    // Overlap pages when several tabs fit. A sole full tab cannot overlap
    // itself: target its neighbour so paging still makes forward/back progress.
    const target = visible.length === 1
      ? tabs[tabs.indexOf(boundary!) + (direction === "next" ? 1 : -1)]
      : boundary;
    if (target) {
      const box = target.getBoundingClientRect();
      lane.scrollBy({
        left: direction === "next"
          ? box.left - bounds.left
          : box.right - bounds.right,
      });
    } else {
      lane.scrollBy({
        left: direction === "next" ? lane.clientWidth : -lane.clientWidth,
      });
    }
    updateEdges();
  };
  const title = (id: string) =>
    props.session?.id === id
      ? props.session.title
      : entry(id)?.title ?? "Session unavailable";
  const openCrumb = ownedAction("task.session.open", (id: string) => {
    if (crumbs().some((crumb) => crumb.id === id && crumb.external)) {
      props.onOpen(id);
      return;
    }
    const task = active();
    if (props.onOpen(id)) {
      if (task) props.model.select({ kind: "task", id: task.id }, id);
      else props.model.preview(id);
    }
  }, { arguments: { type: "string" } });
  const meter = createMemo(() => summaryMeter(props.entry, props.catalog));
  const cost = () => sessionSummary(props.entry)?.cost ?? undefined;
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
        <EdgeTriangle
          direction="previous"
          visible={edges().previous}
          onClick={() => pageTabs("previous")}
        />
        <ScrollRegion
          ref={lane}
          axis="x"
          class="otk-task-list"
          role="tablist"
          aria-label="Tasks and active sessions"
          onScroll={updateEdges}
          onWheel={(event: WheelEvent) => {
            if (
              !event.ctrlKey && !event.metaKey &&
              Math.abs(event.deltaY) > Math.abs(event.deltaX)
            ) {
              event.preventDefault();
              const unit = event.deltaMode === 1
                ? 16
                : event.deltaMode === 2
                ? lane.clientWidth
                : 1;
              lane.scrollBy({ left: event.deltaY * unit });
            }
          }}
        >
          <For each={tabRows()} keyed={(tab) => tab.key}>
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
                          data: {
                            ...props.project,
                            directory:
                              tasks().find((task) => task.id === tab().id)
                                ?.directory ?? props.project.directory,
                            taskID: tab().id,
                          },
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
                          ? sessionState(
                            props.currentEntry?.(tab().id) ?? entry(tab().id),
                          )
                          : ""
                      ) + (editing() ? " is-editing" : ""),
                      kind: "selected",
                      selected: props.model.state.selected?.id === tab().id,
                    })}
                    data-otk-selection="horizontal"
                    title={tab().title}
                    aria-label={tab().title || "Session"}
                    data-tab={tab().id}
                    data-open-session={!separateTitle() &&
                        props.model.state.selected?.id === tab().id
                      ? props.model.state.sessionID
                      : undefined}
                    data-status={entry(props.model.state.sessionID ?? "")
                      ?.status}
                    {...native.attributes}
                  >
                    <SelectionContent
                      class="otk-session-selection"
                      leading={
                        <StatusLight
                          small
                          state={tab().status}
                          attention={{
                            server: props.project.sidecarId,
                            family: {
                              id: tab().id,
                              contains: (id) =>
                                props.model.belongsToTab(tab().id, id),
                            },
                          }}
                        />
                      }
                    >
                      <span class="otk-control-label">
                        <Show
                          when={editing()}
                          fallback={tab().title || "Session"}
                        >
                          <TitleEditor owner={props.rename!} />
                        </Show>
                      </span>
                      <Show when={tab().preview}>
                        <span class="otk-preview-label">Preview</span>
                      </Show>
                    </SelectionContent>
                  </Control>
                </div>
              );
            }}
          </For>
        </ScrollRegion>
        <EdgeTriangle
          direction="next"
          visible={edges().next}
          onClick={() => pageTabs("next")}
        />
        <Show when={props.ready}>
          <Show when={separateTitle()}>
            {(title) => (
              <span
                class="otk-open-session-title"
                aria-label="Open session"
                data-open-session={props.model.state.sessionID}
              >
                <span class="otk-control-label">{title()}</span>
              </span>
            )}
          </Show>
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
                <SelectionContent
                  class="otk-session-selection otk-crumb-measure-content"
                  leading={<StatusLight small state="none" />}
                >
                  {title(item.id)}
                </SelectionContent>
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
              const Control = dynamic(() =>
                editing() ? "div" : crumb().external ? "a" : "button"
              );
              return (
                <>
                  {(() => {
                    const native = nativeAttributes(() => ({
                      onClick: (event: MouseEvent) => {
                        if (crumb().external) {
                          if (
                            event.button !== 0 || event.ctrlKey ||
                            event.metaKey || event.shiftKey || event.altKey
                          ) return;
                          event.preventDefault();
                        }
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
                          type={crumb().external ? undefined : "button"}
                          href={crumb().external
                            ? hashFor({
                              sidecarId: props.project.sidecarId,
                              sessionID: crumb().id,
                            })
                            : undefined}
                          ref={[
                            contextTarget(() => sessionTarget(crumb().id)),
                            native.ref,
                          ]}
                          {...selection({
                            class: `otk-session-crumb ${
                              sessionState(
                                props.currentEntry?.(crumb().id) ??
                                  entry(crumb().id),
                              )
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
                          }`}
                          {...native.attributes}
                        >
                          <SelectionContent
                            class="otk-session-selection"
                            leading={
                              <StatusLight
                                small
                                attention={{
                                  server: props.project.sidecarId,
                                  session: crumb().id,
                                }}
                                state={entry(crumb().id)
                                  ? inboxStatus(entry(crumb().id)!, props.inbox)
                                  : "none"}
                              />
                            }
                          >
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
        when={crumbs().some((crumb) =>
          props.rename?.matches({
            sidecarId: props.project.sidecarId,
            sessionID: crumb.id,
          }, "chip")
        )}
      >
        <div class="otk-crumb-feedback">
          <TitleFeedback owner={props.rename!} id={crumbFeedbackID} />
        </div>
      </Show>
    </section>
  );
}
