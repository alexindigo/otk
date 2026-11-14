// SPDX-License-Identifier: LGPL-3.0-only
import { sessionSummary } from "@otk/client";
import { failureText } from "@otk/client";
import "./ProjectSessions.css" with { type: "text" };
import ListRow from "./ListRow.tsx";
import { ControlIcon } from "./ControlValue.tsx";
import ProgressStatus from "./ProgressStatus.tsx";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import VirtualList from "./VirtualList.tsx";
import TitleEditor from "./TitleEditor.tsx";
import type { InboxSnapshot, IndexEntry } from "@otk/protocol";
import {
  createSessionTree,
  inboxStatus,
  type ListInteraction,
  type MergedEntry,
  type MergedMetadata,
  type ProjectSelection,
  type Selection,
  type SessionListRow,
  type SessionRename,
  usageCost,
} from "@otk/client";
import StatusLight from "./StatusLight.tsx";
import UsageCost from "./UsageCost.tsx";
import { ChevronIcon, PlusIcon, SearchIcon } from "./ChromeIcons.tsx";
import {
  ownedAction,
  ownedCommand,
  useCommandPorts,
} from "../keyboard/context.tsx";
import { contextTarget } from "./context-target.ts";
import { sessionState } from "./selection.ts";
import { digestLabel, digestProgress } from "@otk/client";

/** Reusable presentation of the client-owned task/session hierarchy. */
export default function ProjectSessions(props: {
  entries?: readonly MergedEntry[];
  rows?(query: string): SessionListRow[];
  onRows?(keys: readonly string[], query: string): void;
  progress?: { busy: boolean; announcement: string };
  metadata?(id: string): MergedMetadata | undefined;
  entry?(id: string): IndexEntry | undefined;
  interaction?: ListInteraction;
  project?: ProjectSelection;
  ready?: boolean;
  loading?: boolean;
  loadingText?: string;
  selected?: Selection;
  rename?: SessionRename;
  showCost?: boolean;
  cost?(sessionID: string): number | undefined;
  connected(id: string): boolean;
  inbox(id: string): InboxSnapshot;
  onOpen(entry: MergedEntry): void | Promise<unknown>;
  onPin?(entry: MergedEntry): void | Promise<unknown>;
  onCreate(project: ProjectSelection): void | Promise<unknown>;
}): import("solid-js").Element {
  const [query, setQuery] = createSignal(props.interaction?.query ?? "");
  const [error, setError] = createSignal("");
  let visibleKeys: readonly string[] = [];
  onCleanup(() => props.onRows?.([], query()));
  let search!: HTMLInputElement;
  ownedCommand(useCommandPorts(), {
    id: "session.find",
    title: "Find a session",
    category: "Session",
    context: { kind: "panel", order: 10 },
    enabled: () =>
      !!props.project && search?.isConnected &&
      !!search.getClientRects().length,
    run: () => search.focus(),
  });
  const open = ownedAction("project.session.open", props.onOpen, {
    arguments: {
      type: "object",
      properties: { id: { type: "string" }, sidecarId: { type: "string" } },
    },
  });
  const pin = ownedAction(
    "project.session.pin",
    (entry: MergedEntry) => props.onPin?.(entry),
    {
      arguments: {
        type: "object",
        properties: { id: { type: "string" }, sidecarId: { type: "string" } },
      },
    },
  );
  const create = ownedAction("project.session.new", props.onCreate, {
    arguments: {
      type: "object",
      properties: {
        sidecarId: { type: "string" },
        directory: { type: "string" },
      },
    },
  });
  const run = (promise: Promise<unknown>) =>
    void promise.catch((e) => setError(failureText(e)));
  const hierarchy = createSessionTree();
  const rows = createMemo(() => {
    const project = props.project;
    return project && props.ready !== false
      ? props.rows?.(query()) ?? hierarchy.rows(
        (props.entries ?? []).filter((e) => e.sidecarId === project.sidecarId),
        props.inbox(project.sidecarId).tasks,
        project.directory,
        query(),
      )
      : [];
  });
  const byKey = createMemo(() => new Map(rows().map((row) => [row.key, row])));
  const keys = createMemo(() => rows().map((row) => row.key));
  const merged = (id: string): MergedEntry => {
    const raw = props.entry?.(id),
      projected = props.metadata?.(id) ??
        props.entries?.find((e) => e.id === id);
    // Keyed authoritative facts; approval attention stays with its existing
    // shared projection. Rows borrow current facts, never a replicated entry map.
    return raw
      ? {
        ...raw,
        sidecarId: props.project!.sidecarId,
        attention: projected?.attention ?? raw.attention,
        operationStatus: projected?.operationStatus,
      }
      : projected as MergedEntry;
  };
  const cost = (id: string) => {
    if (props.cost) return props.cost(id);
    const entry = merged(id);
    return props.showCost
      ? sessionSummary(entry)?.cost ?? undefined
      : undefined;
  };
  const costLabel = (id: string) => {
    const value = cost(id);
    return value === undefined ? undefined : usageCost(value);
  };
  const costDescription = (id: string) => {
    const value = cost(id);
    return value === undefined
      ? undefined
      : `Exact session cost: ${usageCost(value, "exact")}`;
  };
  const progress = createMemo(() =>
    props.progress ?? digestProgress(
      (props.entries ?? []).filter((entry) =>
        entry.sidecarId === props.project?.sidecarId &&
        entry.directory === props.project.directory
      ),
    )
  );
  return (
    <nav
      class="otk-project-sessions"
      aria-label="Project sessions"
      data-session-project={props.project?.directory}
      aria-busy={props.ready === false || props.loading || progress().busy
        ? "true"
        : "false"}
    >
      <Show
        when={props.ready !== false && !props.loading &&
          progress().announcement}
      >
        <span
          class="otk-session-summary-status"
          role="status"
          aria-live="polite"
        >
          {progress().announcement}
        </span>
      </Show>
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
            <ControlIcon>
              <SearchIcon class="otk-session-search-icon" />
            </ControlIcon>
            <input
              ref={(element) => {
                search = element;
              }}
              type="search"
              aria-label="Search sessions by title"
              placeholder="Find a session"
              value={query()}
              onInput={(event) => {
                const value = event.currentTarget.value;
                if (props.interaction) props.interaction.query = value;
                setQuery(value);
                props.onRows?.(visibleKeys, value);
              }}
            />
          </label>
          <Show when={props.connected(props.project!.sidecarId)}>
            <button
              type="button"
              class="otk-icon-button otk-panel-new-session"
              title="New session"
              aria-label={`New session in ${props.project!.directory}`}
              onClick={() => run(create(props.project!))}
            >
              <PlusIcon />
            </button>
          </Show>
        </div>
        <div class="otk-project-session-content">
          <Show when={props.ready !== false}>
            <VirtualList
              class="otk-project-session-tree"
              label="Task groups and sessions"
              keys={keys()}
              onRange={(keys) => {
                visibleKeys = keys;
                props.onRows?.(keys, query());
              }}
              samples={[{ role: "session", class: "otk-list-row" }, {
                role: "heading",
                class: "otk-session-group-heading",
              }]}
              role={(key) => byKey().get(key)?.kind ?? "session"}
              position={props.interaction}
              itemAttributes={(key) => {
                const row = byKey().get(key);
                return row?.kind === "session"
                  ? { "aria-posinset": row.position, "aria-setsize": row.size }
                  : { role: "presentation" };
              }}
              onPosition={(position) => {
                if (props.interaction) {
                  Object.assign(props.interaction, position);
                }
              }}
              pinned={props.rename?.state.editing?.origin === "row" &&
                  props.rename.state.editing.sidecarId ===
                    props.project?.sidecarId
                ? [props.rename.state.editing.sessionID]
                : []}
              render={(key) => {
                const initial = byKey().get(key)!;
                const item = () => byKey().get(key) ?? initial;
                if (initial.kind === "heading") {
                  return (
                    <h3
                      class="otk-session-group otk-session-group-heading"
                      data-session-group={initial.group}
                      aria-label={item().title}
                    >
                      <ChevronIcon class="otk-session-group-chevron" />
                      <span class="otk-control-label" title={item().title}>
                        {item().title}
                      </span>
                      <span class="otk-session-group-rule" />
                    </h3>
                  );
                }
                const original = merged(key);
                const row = () => {
                  const value = item();
                  return {
                    session: merged(key) ?? original,
                    depth: value.kind === "session" ? value.depth : 0,
                    parentID: value.kind === "session"
                      ? value.parentID
                      : undefined,
                  };
                };
                const editing = () =>
                  props.rename?.matches({
                    sidecarId: props.project!.sidecarId,
                    sessionID: row().session.id,
                  }, "row");
                return (
                  <Show
                    when={!!merged(key)}
                    fallback={
                      <ListRow as="div" selected={false}>
                        {item().title}
                      </ListRow>
                    }
                  >
                    <div
                      role="group"
                      aria-label={item().title}
                      data-depth={row().depth}
                      data-parent={row().parentID}
                    >
                      <ListRow
                        editing={editing()}
                        ref={contextTarget(() => ({
                          kind: "session",
                          data: {
                            ...props.project!,
                            directory: row().session.directory,
                            sessionID: row().session.id,
                            title: row().session.title,
                            origin: "row" as const,
                          },
                        }))}
                        class={`otk-session-row ${sessionState(row().session)}`}
                        selected={props.selected?.sidecarId ===
                            props.project!.sidecarId &&
                          props.selected.sessionID === row().session.id}
                        attributes={{
                          "data-session": row().session.id,
                          "data-status": row().session.status,
                          style: { "--session-depth": row().depth },
                          title: row().session.title,
                          "aria-description": costDescription(
                            row().session.id,
                          ),
                          "aria-label": `${
                            row().session.deleted ? "Deleted session, " : ""
                          }${row().session.title}${
                            row().parentID
                              ? `, child of ${
                                merged(row().parentID!)?.title ?? row().parentID
                              }`
                              : ""
                          }${
                            costLabel(row().session.id) === undefined
                              ? ""
                              : `, session cost ${costLabel(row().session.id)}`
                          }`,
                          onClick: () => run(open(merged(row().session.id))),
                          onDblClick: () => {
                            if (!row().session.deleted) {
                              run(
                                pin(merged(row().session.id)),
                              );
                            }
                          },
                        }}
                        leading={
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
                              attention={{
                                server: props.project!.sidecarId,
                                session: row().session.id,
                              }}
                              state={inboxStatus(
                                row().session,
                                props.inbox(props.project!.sidecarId),
                              )}
                              event={row().session.timeUpdated}
                            />
                          </span>
                        }
                        labelClass="otk-row-title"
                        trailing={
                          <>
                            <Show when={row().session.status === "retry"}>
                              <span>
                                retry {row().session.retry?.attempt}
                              </span>
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
                                title="The agent reported a session failure"
                                aria-label="Session error"
                              >
                                Error
                              </span>
                            </Show>
                            <Show when={costLabel(row().session.id)}>
                              <span
                                class="otk-session-cost"
                                aria-hidden="true"
                                title="Session cost"
                              >
                                <UsageCost
                                  value={cost(row().session.id)!}
                                />
                              </span>
                            </Show>
                            <Show
                              when={row().session.digest.total?.state !==
                                  "known" ||
                                (props.showCost &&
                                  costLabel(row().session.id) ===
                                    undefined)}
                            >
                              <span class="otk-session-digest-state">
                                {digestLabel(row().session)}
                              </span>
                            </Show>
                          </>
                        }
                      >
                        <Show
                          when={editing()}
                          fallback={row().session.title}
                        >
                          <TitleEditor owner={props.rename!} />
                        </Show>
                      </ListRow>
                    </div>
                  </Show>
                );
              }}
            />
            <Show when={!props.loading && !rows().length}>
              <p class="otk-muted">No matching sessions</p>
            </Show>
          </Show>
        </div>
        <div class="otk-session-loading-slot">
          <Show when={props.ready === false || props.loading}>
            <ProgressStatus
              class="otk-session-loading-row"
              text={props.loadingText || "Loading sessions..."}
            />
          </Show>
        </div>
      </Show>
    </nav>
  );
}
