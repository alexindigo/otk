// SPDX-License-Identifier: LGPL-3.0-only
import { TreeNode } from "./Tree.tsx";
import ChromeMeta, { MetaItem, SectionHeader } from "./ChromeMeta.tsx";
import { solidState } from "../state/binding.ts";
import { sessionSummary } from "@otk/client";
import { errorFeedback, type FailureValue, failureValue } from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";
import "./ProjectSessions.css" with { type: "text" };
import SidebarRow, { SidebarFeedback, SidebarFrame } from "./SidebarRow.tsx";
import DisclosureFeedback from "./DisclosureFeedback.tsx";
import { ControlIcon } from "./ControlValue.tsx";
import ProgressStatus from "./ProgressStatus.tsx";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  Show,
} from "solid-js";
import VirtualList from "./VirtualList.tsx";
import TitleEditor, { TitleFeedback } from "./TitleEditor.tsx";
import type {
  InboxSnapshot,
  IndexEntry,
  SessionTreeTarget,
} from "@otk/protocol";
import {
  createEntityStateStore,
  createSessionTree,
  type Disclosures,
  type DisclosureState,
  type EntityStateStore,
  lamp,
  type ListInteraction,
  type MergedEntry,
  type MergedMetadata,
  type ProjectSelection,
  type Selection,
  SESSION_TREE_DISCLOSURES,
  type SessionListRow,
  type SessionRename,
  type SessionTreeItem,
  sessionTreeView,
  sessionWorkStatus,
  usageCost,
} from "@otk/client";
import StatusLight from "./StatusLight.tsx";
import SessionStateMeta from "./SessionStateMeta.tsx";
import { entityKey, MAX_SESSION_TITLE, taskEntityID } from "@otk/protocol";
import UsageCost from "./UsageCost.tsx";
import { PlusIcon, SearchIcon, SessionsIcon } from "./ChromeIcons.tsx";
import {
  ownedAction,
  ownedCommand,
  selectionFocus,
  useCommandPorts,
} from "../keyboard/context.tsx";
import { focusControl } from "../keyboard/focus.ts";
import { contextTarget } from "./context-target.ts";
import { sessionState } from "./selection.ts";
import { digestLabel, digestProgress } from "@otk/client";
import { orderInteraction } from "./order-interaction.ts";

/** Reusable presentation of the client-owned task/session hierarchy. */
export default function ProjectSessions(props: {
  disclosure: Disclosures;
  entries?: readonly MergedEntry[];
  rows?(query: string): SessionListRow[];
  onRows?(keys: readonly string[], query: string): void;
  progress?: { busy: boolean; announcement: string };
  metadata?(id: string): MergedMetadata | undefined;
  entry?(id: string): IndexEntry | undefined;
  interaction?: ListInteraction;
  holdOrder?(): () => void;
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
  entities?(id: string): EntityStateStore;
  onOpen(entry: MergedEntry): void | Promise<unknown>;
  onPin?(entry: MergedEntry): void | Promise<unknown>;
  onCreate(project: ProjectSelection): void | Promise<unknown>;
}): import("solid-js").Element {
  const [query, setQuery] = createSignal(props.interaction?.query ?? "");
  const standalone = createEntityStateStore({
    read: () =>
      props.project ? props.inbox(props.project.sidecarId).entities : undefined,
    factory: solidState,
  });
  onCleanup(() => standalone.stop());
  const entities = () =>
    props.entities?.(props.project!.sidecarId) ?? standalone;
  createEffect(
    () =>
      [
        props.project
          ? props.inbox(props.project.sidecarId).entities
          : undefined,
        props.project ? props.connected(props.project.sidecarId) : false,
      ] as const,
    ([, connected]) => {
      if (!props.project || props.entities) return;
      standalone.stale(!connected);
      standalone.observe("all", "historical");
    },
  );
  const orderInput = orderInteraction(() => props.holdOrder?.() ?? (() => {}));
  const [error, setError] = createSignal<FailureValue>("");
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
    run: () => {
      focusControl(search);
    },
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
    void promise.catch((e) =>
      setError(failureValue(e, { actionLabel: "Opening session" }))
    );
  const hierarchy = createSessionTree();
  const bind = ({ kind, sidecarId: scope, id }: SessionTreeTarget) =>
    props.disclosure.bind(SESSION_TREE_DISCLOSURES[kind], { scope, id });
  const allRows = createMemo(() => {
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
  const groupCounts = createMemo(() => {
    const counts = new Map<string, number>();
    for (const row of allRows()) {
      if (row.kind === "session") {
        counts.set(row.group, (counts.get(row.group) ?? 0) + 1);
      }
    }
    return counts;
  });
  const tree = createMemo(() => {
    let failure: DisclosureState | undefined;
    const bindings = new Map<string, DisclosureState>();
    const rows = props.project
      ? sessionTreeView(allRows(), props.project, (item) => {
        const disclosure = bind(item.target);
        bindings.set(item.key, disclosure);
        if (disclosure.failureOrder() > (failure?.failureOrder() ?? 0)) {
          failure = disclosure;
        }
        return disclosure.open();
      })
      : [];
    return { rows, bindings, failure };
  });
  const rows = () => tree().rows;
  const byKey = createMemo(() =>
    new Map(rows().map((item) => [item.key, item]))
  );
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

  function SessionBranch(propsRow: { item: SessionTreeItem }) {
    const item = () => propsRow.item;
    const row = () => item().row;
    const key = item().key;
    const entry = () => merged(key);
    const title = () => entry()?.title ?? row().title;
    const parent = () => {
      const value = row();
      return value.kind === "session" ? value.parentID : undefined;
    };
    const stateKey = entityKey("session", key);
    const disclosure = () => tree().bindings.get(key);
    const selected = () =>
      props.selected?.sidecarId === props.project!.sidecarId &&
      props.selected.sessionID === key;
    const renaming = () =>
      props.rename?.matches({
        sidecarId: props.project!.sidecarId,
        sessionID: key,
      }, "row");
    const editing = () => renaming() && props.rename!.editing;
    let control: HTMLButtonElement | undefined;
    const bindFocus = selectionFocus("session", selected, () => control);
    const feedbackID = createUniqueId();
    const openRow = () => {
      const session = entry();
      if (session && !editing()) run(open(session));
    };
    const pinRow = () => {
      const session = entry();
      if (session && !session.deleted && !editing()) run(pin(session));
    };
    const ref = contextTarget(() => ({
      kind: "session",
      data: {
        ...props.project!,
        directory: entry()?.directory ?? props.project!.directory,
        sessionID: key,
        title: title(),
        origin: "row" as const,
      },
    }));
    const description = () =>
      `${entry()?.deleted ? "Deleted session, " : ""}${title()}${
        parent() ? `, child of ${merged(parent()!)?.title ?? parent()}` : ""
      }${
        costLabel(key) === undefined ? "" : `, session cost ${costLabel(key)}`
      }`;
    return (
      <div
        role="group"
        aria-label={row().title}
        data-depth={item().depth - 1}
        data-parent={parent()}
      >
        <TreeNode
          path={item().path}
          class="otk-session-tree otk-sidebar-tree"
          selected={selected()}
          open={disclosure()?.open() ?? true}
          hasChildren={item().hasChildren}
          showEmptyToggle={false}
          onOpen={(value) => void disclosure()?.set(value)}
          label={`Child sessions of ${title()}`}
          frame={({ class: surface, children }) => (
            <SidebarFrame
              frame={{
                selected: selected(),
                class: `${surface} otk-session-row ${
                  entry() ? sessionState(entry()!) : ""
                }${editing() ? " is-editing" : ""}`,
                ref: (element) => {
                  ref(element);
                  bindFocus(element);
                },
                attributes: {
                  "data-session": entry() ? key : undefined,
                  "data-status": entry()
                    ? sessionWorkStatus(entities(), stateKey)
                    : undefined,
                  title: title(),
                  onClick: openRow,
                  onDblClick: pinRow,
                },
              }}
            >
              {children}
            </SidebarFrame>
          )}
          node={() => (
            <Show when={entry()} fallback={<SessionsIcon />}>
              <StatusLight state={lamp(entities(), stateKey)} />
            </Show>
          )}
          feedback={() =>
            renaming() &&
              (props.rename!.state.invalid || props.rename!.state.error)
              ? (
                <SidebarFeedback>
                  <TitleFeedback owner={props.rename!} id={feedbackID} />
                </SidebarFeedback>
              )
              : undefined}
          header={() => (
            <SidebarRow
              mainRef={(element) => control = element}
              action={entry() && !editing()
                ? {
                  class: "otk-session-open",
                  "aria-label": description(),
                  "aria-description": costDescription(key),
                }
                : undefined}
              title={{
                text: title(),
                pending: renaming()
                  ? props.rename!.state.pendingTitle
                  : undefined,
                struck: !!entry()?.deleted,
              }}
              editor={editing()
                ? (
                  <TitleEditor
                    owner={props.rename!}
                    feedbackID={feedbackID}
                    label="Rename session"
                    maxLength={MAX_SESSION_TITLE}
                  />
                )
                : undefined}
              meta={
                <Show when={entry()}>
                  {(session) => (
                    <>
                      <SessionStateMeta
                        entities={entities()}
                        entityKey={stateKey}
                      />
                      <Show when={costLabel(key)}>
                        <MetaItem rank={6}>
                          <ChromeMeta
                            class="otk-session-cost"
                            aria-hidden="true"
                            title="Session cost"
                          >
                            <UsageCost value={cost(key)!} />
                          </ChromeMeta>
                        </MetaItem>
                      </Show>
                      <Show
                        when={session().digest?.total?.state !== "known" ||
                          (props.showCost && costLabel(key) === undefined)}
                      >
                        <MetaItem rank={7}>
                          <ChromeMeta class="otk-session-digest-state">
                            {digestLabel(session())}
                          </ChromeMeta>
                        </MetaItem>
                      </Show>
                    </>
                  )}
                </Show>
              }
            />
          )}
        />
      </div>
    );
  }
  return (
    <nav
      ref={orderInput}
      class="otk-project-sessions"
      data-panel-span="full"
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
        <FeedbackStatus
          class="otk-project-session-error"
          feedback={errorFeedback(error())}
        />
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
        <DisclosureFeedback
          disclosure={tree().failure}
          actionLabel="Saving session tree"
          class="otk-project-session-disclosure"
        />
        <div class="otk-project-session-content">
          <Show when={props.ready !== false}>
            <VirtualList
              class="otk-project-session-tree otk-sidebar-list"
              label="Task groups and sessions"
              keys={keys()}
              onRange={(keys) => {
                visibleKeys = keys;
                props.onRows?.(keys, query());
              }}
              samples={[{ role: "session", class: "otk-sidebar-row-grid" }, {
                role: "heading",
                class: "otk-sidebar-row-grid",
              }]}
              role={(key) => byKey().get(key)?.row.kind ?? "session"}
              position={props.interaction}
              itemAttributes={(key) => {
                const row = byKey().get(key)?.row;
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
                if (initial.row.kind === "heading") {
                  const group = initial.row.group;
                  const disclosure = () => tree().bindings.get(key);
                  return (
                    <h3
                      class="otk-session-group"
                      data-session-group={group}
                      aria-label={item().row.title}
                    >
                      <SectionHeader
                        sidebar
                        class="otk-session-tree"
                        path={item().path}
                        hasChildren={item().hasChildren}
                        label={item().row.title}
                        count={groupCounts().get(group) ?? 0}
                        open={disclosure()?.open() ?? true}
                        onOpen={(value) => void disclosure()?.set(value)}
                        leading={() => (
                          <Show when={group} fallback={<SessionsIcon />}>
                            <StatusLight
                              state={lamp(
                                entities(),
                                entityKey(
                                  "task",
                                  taskEntityID("task", group),
                                ),
                              )}
                            />
                          </Show>
                        )}
                      />
                    </h3>
                  );
                }
                return <SessionBranch item={item()} />;
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
