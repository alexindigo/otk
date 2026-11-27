// SPDX-License-Identifier: LGPL-3.0-only
import type {
  CapabilityName,
  IndexEntry,
  Preferences,
  ProjectEditTarget,
  ProjectLocation,
  ProjectMove,
  ProjectPatch,
  ServerFrame,
  SessionStructure,
  SessionTreeTarget,
  ShellLayout,
} from "@otk/protocol";
import { type ApprovalModel, createApprovals } from "./approvals.ts";
import {
  type AttentionProjection,
  createAttentionProjection,
  type EntryChanges,
} from "./entry-observations.ts";
import type { SidecarConnection } from "./connection.ts";
import type {
  ClientIndex,
  IndexChanges,
  MergedEntry,
  MergedMetadata,
} from "./index.ts";
import { createInbox, type InboxModel, projectHierarchy } from "./inbox.ts";
import {
  createProjectProjection,
  type ProjectProjectionRow,
} from "./project-projection.ts";
import type { Selection } from "./session.ts";
import type { ProjectSelection } from "./project-navigation.ts";
import {
  type ClientSidecars,
  LOCAL_SIDECAR,
  type SidecarState,
} from "./sidecars.ts";
import { createState, type StateFactory } from "./state.ts";
import { createProgress, type ProgressDisplay } from "./progress.ts";
import { type ClientTabs, createTabs, type TabInput } from "./tabs.ts";
import { createTaskActions, type TaskActions } from "./task-actions.ts";
import { createSessionTree, type SessionListRow } from "./session-tree.ts";
import {
  createCatalogCodecs,
  entityKey,
  entityRetainsVisibility,
} from "@otk/protocol";
import {
  type ClientDirectoryCatalogs,
  createDirectoryCatalogs,
  type DirectoryCatalogLease,
} from "./directory-catalogs.ts";
import {
  createFrecencyCatalogs,
  type FrecencyCatalogLease,
} from "./frecency-catalogs.ts";
import { createSessionLists } from "./session-lists.ts";
import { type CollectionState, collectionState } from "./collection-state.ts";
import { createProjectOrder, orderProjectRows } from "./project-order.ts";
import { createFileFacts, type FileFacts } from "./file-facts.ts";
import { reportDiagnostic } from "./diagnostics.ts";
import type { NoteSession, NotificationLocation } from "./notifications.ts";
import { sessionTitle } from "./session-title.ts";

export interface FrameObserver {
  frame?(id: string, frame: ServerFrame, accepted: boolean): void;
  removed?(id: string): void;
}
type ServerProjectRow = ProjectProjectionRow & {
  sidecarId: string;
  label: string;
  otkProjectID?: string;
};
export interface ServerResources {
  forms(id: string): readonly import("@otk/protocol").FormRequest[];
  progress(server: string, directory?: string): ProgressDisplay;
  ownsFailure?(cause: unknown): boolean;
  scope(
    project?: ProjectSelection,
    sessions?: string[],
    selected?: Selection,
    crumbs?: string[],
  ): void;
  visibleRows(
    project: ProjectSelection,
    rows: readonly string[],
    query?: string,
  ): void;
  historyNeighbors(neighbors: readonly Selection[]): void;
  retainSessionReference(sidecarId: string, sessionID: string): () => void;
  projectSession(
    project: ProjectSelection,
    preferred?: string,
    attention?: boolean,
  ): Promise<string | undefined>;
  /** Presentation routing only; native/persisted directories remain unchanged. */
  projectDirectory?(
    sidecar: string,
    directory: string,
    repoID?: string,
  ): string;
  sidecars: ClientSidecars;
  inbox(id: string): InboxModel;
  directoryCatalog(id: string, directory: string): DirectoryCatalogLease;
  fileFacts(id: string): FileFacts;
  frecencyCatalog(id: string, directory: string): FrecencyCatalogLease;
  approvals(id: string): ApprovalModel;
  tabs(project: ProjectSelection): ClientTabs;
  holdTaskOrder(project: ProjectSelection): () => void;
  moveProject(sidecarId: string, move: ProjectMove): Promise<void>;
  taskActions(project: ProjectSelection): TaskActions;
  entry(sidecarId: string, sessionID: string): IndexEntry | undefined;
  server(id: string): SidecarState | undefined;
  connected(id: string): boolean;
  linked(id: string): boolean;
  advertised(id: string, capability: CapabilityName): boolean;
  declares(id: string, capability: CapabilityName): boolean;
  anyAdvertised(capability: CapabilityName): boolean;
  connectionKey(id: string): number | undefined;
  projected(id: string, sessionID: string): IndexEntry | undefined;
  projectedProject(id: string, directory: string): readonly IndexEntry[];
  observeEntries(
    id: string,
    listener: (changes: EntryChanges) => void,
  ): () => void;
  entries(): MergedEntry[];
  metadataEntries(): MergedMetadata[];
  /** Unprojected metadata borrowed from the shared keyed-index owner. */
  indexEntries(sidecar: string): readonly IndexEntry[];
  indexChanges(sidecar: string): IndexChanges | undefined;
  projectEntries(project: ProjectSelection): MergedEntry[];
  projectMetadata(project: ProjectSelection): readonly MergedMetadata[];
  metadataEntry(
    sidecarId: string,
    sessionID: string,
  ): MergedMetadata | undefined;
  sessionRows(project: ProjectSelection, query?: string): SessionListRow[];
  projectContents(project: ProjectSelection): CollectionState;
  sessionCollection(project: ProjectSelection, query?: string): {
    state: CollectionState;
    rows: SessionListRow[];
    progress: ProgressDisplay;
  };
  projectsReady(): boolean;
  projectProgress(
    project: ProjectSelection,
  ): { busy: boolean; announcement: string };
  projectRow(
    project: ProjectSelection,
    now: number,
  ): ProjectProjectionRow | undefined;
  duplicateProjectName(name: string): boolean;
  checkoutLabel(sidecarId: string, directory: string): string;
  projectLabel(sidecarId: string, directory: string): string;
  notificationLocation(target: NoteSession): NotificationLocation | undefined;
  updateProject(
    target: ProjectSelection & ProjectEditTarget,
    patch: ProjectPatch,
  ): Promise<void>;
  projects(
    now: number,
  ): ServerProjectRow[];
  /** The connection's entity states, for lamps and emphasis (decision 62). */
  entities(server: string): import("./entity-state.ts").EntityStateStore;
  tabSnapshot(project: ProjectSelection): TabInput;
  syncTabs(
    project: ProjectSelection,
    input: TabInput,
    selected?: Selection,
  ): void;
  historySources(): { id: string; connection: SidecarConnection }[];
  receive(id: string, frame: ServerFrame): void;
  observe(observer: FrameObserver): () => void;
  add(url: string, label: string): Promise<string>;
  remove(id: string): void;
  layout(patch: Partial<ShellLayout>): Promise<void>;
  projectCollapse(project: ProjectSelection, collapsed: boolean): Promise<void>;
  treeCollapse(target: SessionTreeTarget, collapsed: boolean): Promise<void>;
  rememberLocation(location: ProjectLocation): Promise<void>;
  inactive(project: ProjectSelection, inactive: boolean): Promise<void>;
  setPreference(key: keyof Preferences, value: unknown): Promise<void>;
  stop(): void;
}

/** Connection-local resources and projections; consumers observe frames after reduction. */
export function createServerResources(o: {
  sidecars(
    receive: (id: string, frame: ServerFrame) => boolean | void,
  ): ClientSidecars;
  index: ClientIndex;
  factory?: StateFactory;
  error?: (error: unknown) => void;
  diagnostic?: (error: unknown) => void;
  /** One release input for catalog warm-up. Until decision 30, acquisition is page-ready. */
  pageReady?: (
    project: ProjectSelection,
    release: () => void,
  ) => void | (() => void);
}): ServerResources {
  const factory = o.factory ?? createState;
  const orders = new Map<string, ReturnType<typeof createProjectOrder>>();
  const missingOrder = new Map<string, Set<string>>();
  function projectOrder(id: string) {
    let order = orders.get(id);
    if (!order) orders.set(id, order = createProjectOrder(factory));
    return order;
  }
  const lifetimeClock = factory({ revision: 0 });
  const requestSubscriptions = new Map<string, () => void>();
  const requests = (id: string) => {
    void lifetimeClock.state.revision;
    const owner = sidecars.connection(id).attention;
    if (!requestSubscriptions.has(id)) {
      requestSubscriptions.set(
        id,
        owner.subscribe(() => {
          lifetimeClock.update((s) => {
            s.revision++;
          });
        }),
      );
    }
    return owner;
  };
  const hierarchyClock = factory({ revision: 0 });
  const tabContextClock = factory({ keys: {} as Record<string, number> });
  const invalidateTabContext = (cache: { key: string; dirty: boolean }) => {
    if (cache.dirty) return;
    cache.dirty = true;
    tabContextClock.update((state) => {
      state.keys[cache.key] = (state.keys[cache.key] ?? 0) + 1;
    });
  };
  let tasksFollowParent = false;
  const progressOwners = new Map<string, ReturnType<typeof createProgress>>();
  const progressOwner = (id: string) => {
    let owner = progressOwners.get(id);
    if (!owner) progressOwners.set(id, owner = createProgress(factory));
    return owner;
  };
  const inboxes = new Map<string, InboxModel>();
  const fileFactOwners = new Map<string, FileFacts>();
  const fileFacts = (id: string) => {
    let owner = fileFactOwners.get(id);
    if (!owner) {
      owner = createFileFacts(sidecars.connection(id).rpc, undefined, {
        images: sidecars.connection(id).rpc,
        factory,
        diagnostic: (cause) => reportDiagnostic(console.debug, cause),
      });
      fileFactOwners.set(id, owner);
    }
    return owner;
  };
  const catalogs = new Map<string, ClientDirectoryCatalogs>();
  const frecencies = new Map<
    string,
    ReturnType<typeof createFrecencyCatalogs>
  >();
  let visibleCatalog: {
    key: string;
    directory: DirectoryCatalogLease;
    frecency: FrecencyCatalogLease;
    stopReady?: () => void;
  } | undefined;
  const directoryOwner = (id: string) => {
    let owner = catalogs.get(id);
    if (!owner) {
      owner = createDirectoryCatalogs({
        codecs: createCatalogCodecs(),
        factory,
        diagnostic: o.error,
        watch: (directory) =>
          sidecars.connection(id).rpc.start("catalogs.watch", { directory }),
        retainFiles: (directory) =>
          sidecars.connection(id).rpc.start("catalogs.watch", {
            directory,
            files: true,
          }),
        demand: (directory, kinds, intent, signal) =>
          sidecars.connection(id).rpc.call("catalogs.demand", {
            directory,
            kinds,
            intent,
          }, signal).then(() => {}),
        refresh: (directory, kinds, signal) =>
          sidecars.connection(id).rpc.call("catalogs.refresh", {
            directory,
            kinds,
          }, signal)
            .then(() => {}),
      });
      catalogs.set(id, owner);
    }
    return owner;
  };
  const frecencyOwner = (id: string) => {
    let owner = frecencies.get(id);
    if (!owner) {
      owner = createFrecencyCatalogs(sidecars.connection(id).rpc, factory);
      frecencies.set(id, owner);
    }
    return owner;
  };
  const bindVisibleCatalog = () => {
    const displayed = visible?.project;
    const current = selected && selected.sidecarId === displayed?.sidecarId
      ? o.index.getMetadata(selected.sidecarId, selected.sessionID)
      : undefined;
    const project = displayed && current?.directory && !current.deleted
      ? { ...displayed, directory: current.directory }
      : displayed;
    const key = project &&
      JSON.stringify([project.sidecarId, project.directory]);
    if (visibleCatalog?.key === key) return;
    visibleCatalog?.stopReady?.();
    visibleCatalog?.directory.release();
    visibleCatalog?.frecency.release();
    visibleCatalog = undefined;
    if (project && declares(project.sidecarId, "catalogs")) {
      visibleCatalog = {
        key: key!,
        directory: directoryOwner(project.sidecarId).acquire(project.directory),
        frecency: frecencyOwner(project.sidecarId).acquire(project.directory),
      };
      const lease = visibleCatalog.directory;
      const release = () => {
        if (visibleCatalog?.directory !== lease) return;
        void lease.warm(["models", "agents", "commands", "skills"]).catch((
          cause,
        ) => o.error?.(cause));
      };
      const stopReady = (o.pageReady ?? ((_project, ready) => ready()))(
        project,
        release,
      );
      if (stopReady) visibleCatalog.stopReady = stopReady;
    }
  };
  const approvalModels = new Map<string, ApprovalModel>();
  const projections = new Map<string, AttentionProjection>();
  const projectOwners = new Map<
    string,
    ReturnType<typeof createProjectProjection>
  >();
  const projectReleases = new Map<string, (() => void)[]>();
  const names = new Map<string, number>();
  const projectLabels = new Map<string, Map<string, string>>();
  const nameClock = factory({ keys: {} as Record<string, number> });
  const countName = (name: string, delta: number) => {
    const before = names.get(name) ?? 0;
    const after = before + delta;
    if (after) names.set(name, after);
    else names.delete(name);
    if ((before > 1) !== (after > 1)) {
      nameClock.update((state) => {
        state.keys[name] = (state.keys[name] ?? 0) + 1;
      });
    }
  };
  const labelledRows = new WeakMap<
    ProjectProjectionRow,
    ServerProjectRow
  >();
  const tabModels = new Map<string, ClientTabs>();
  const observers = new Set<FrameObserver>();
  let stopped = false;
  let visible: { project: ProjectSelection; sessions: string[] } | undefined;
  let selected: Selection | undefined, crumbs: string[] = [];
  let historyNeighbors: readonly Selection[] = [];
  const sessionReferences = new Map<string, Map<string, number>>();
  let referenceViewPending = false;
  let rowDemand:
    | { project: ProjectSelection; rows: string[]; query: string }
    | undefined;
  const listOwners = new Map<string, ReturnType<typeof createSessionLists>>();
  const listOwner = (id: string) => {
    let owner = listOwners.get(id);
    if (!owner) {
      const connection = sidecars.connection(id);
      listOwners.set(
        id,
        owner = createSessionLists(
          connection.rpc,
          () => connection.viewEpoch,
          factory,
        ),
      );
    }
    return owner;
  };
  const listInputs = (project: ProjectSelection, query = "") =>
    projectOwner(project.sidecarId).scopes(
      projectOwner(project.sidecarId).resolve(project.directory),
    ).map((directory) => ({ directory, query }));
  const listsFor = (project: ProjectSelection, query = "") =>
    listInputs(project, query).map((input) =>
      listOwner(project.sidecarId).get(input)
    );
  const trees = new Map<string, ReturnType<typeof createSessionTree>>();
  const rowFacts = new WeakMap<SessionListRow[], {
    count: number;
    beforeAnswer: SessionListRow[];
  }>();
  const listContexts = new WeakMap<TabInput, {
    scope: string;
    values: (SessionStructure & { retained: boolean })[];
  }>();
  const listContext = (p: ProjectSelection) => {
    const input = tabInput(p);
    const scope = JSON.stringify([
      selected?.sidecarId === p.sidecarId ? selected.sessionID : null,
      visible?.project.sidecarId === p.sidecarId &&
        visible.project.directory === p.directory
        ? [visible.sessions, crumbs]
        : null,
      rowDemand?.project.sidecarId === p.sidecarId &&
        rowDemand.project.directory === p.directory
        ? rowDemand.rows
        : null,
    ]);
    const previous = listContexts.get(input);
    if (previous?.scope === scope) return previous.values;
    const values = new Map(input.entries.map((entry) => [entry.id, entry]));
    const required = new Set(
      input.inbox.tasks.filter((task) =>
        (input.directories ?? [p.directory]).includes(task.directory)
      )
        .flatMap((task) => task.sessions),
    );
    if (selected?.sidecarId === p.sidecarId) required.add(selected.sessionID);
    if (
      visible?.project.sidecarId === p.sidecarId &&
      visible.project.directory === p.directory
    ) {
      for (const id of [...visible.sessions, ...crumbs]) required.add(id);
    }
    if (
      rowDemand?.project.sidecarId === p.sidecarId &&
      rowDemand.project.directory === p.directory
    ) {
      for (const id of rowDemand.rows) required.add(id);
    }
    for (const entry of input.entries) {
      if (
        entry.deleted ||
        entityRetainsVisibility(
          input.entities?.get(entityKey("session", entry.id)),
        )
      ) {
        required.add(entry.id);
      }
    }
    for (const id of required) {
      const entry = values.get(id);
      if (entry?.parentID && values.has(entry.parentID)) {
        required.add(entry.parentID);
      }
    }
    const context = [...required].flatMap((id) => {
      const entry = values.get(id);
      return entry
        ? [{
          id: entry.id,
          directory: entry.directory,
          title: entry.title,
          timeCreated: entry.timeCreated,
          parentID: entry.parentID,
          retained: !!entry.deleted,
          hierarchy: entry.hierarchy,
        }]
        : [];
    });
    listContexts.set(input, { scope, values: context });
    return context;
  };
  const sendView = () => {
    const id = visible?.project.sidecarId ?? selected?.sidecarId;
    for (const sidecar of sidecars.state.list) {
      const active = sidecar.id === id;
      const rows = active && visible && rowDemand?.project.sidecarId === id &&
          rowDemand.project.directory === visible.project.directory
        ? rowDemand
        : undefined;
      sidecars.connection(sidecar.id).view({
        directory: active ? visible?.project.directory : undefined,
        selected: active
          ? selected?.sessionID ?? visible?.sessions[0]
          : undefined,
        crumbs: active ? crumbs : [],
        rows: rows?.rows ?? [],
        references: [...(sessionReferences.get(sidecar.id)?.keys() ?? [])]
          .sort(),
        historyNeighbors: historyNeighbors.length
          ? historyNeighbors.filter((target) => target.sidecarId === sidecar.id)
            .map((target) => target.sessionID)
          : undefined,
        query: rows?.query,
        tasksFollowParent,
      });
    }
  };
  const scheduleReferenceView = () => {
    if (referenceViewPending || stopped) return;
    referenceViewPending = true;
    queueMicrotask(() => {
      referenceViewPending = false;
      if (!stopped) sendView();
    });
  };
  const sendScope = (
    id: string,
    value: { directory?: string; sessions: string[] },
  ) => {
    const connection = sidecars.connection(id);
    if (attached(id) && declares(id, "digests")) {
      void connection.rpc.call("digests.scope", value).catch(
        o.error ?? console.warn,
      );
    }
  };
  const live = () => {
    if (stopped) throw new Error("Server resources are stopped");
  };
  const entry = (id: string, sessionID: string): IndexEntry | undefined =>
    o.index.get(id, sessionID);
  const server = (id: string): SidecarState | undefined =>
    sidecars.state.list.find((s) => s.id === id);
  const connected = (id: string): boolean => server(id)?.status === "connected";
  const attached = (id: string): boolean => {
    const value = server(id);
    return value?.status === "connected" || value?.attaching === true;
  };
  const linked = (id: string): boolean =>
    connected(id) && server(id)?.harness === "connected";
  const declares = (id: string, capability: CapabilityName): boolean =>
    server(id)?.capabilities.includes(capability) ?? false;
  const advertised = (id: string, capability: CapabilityName): boolean =>
    connected(id) && declares(id, capability);
  const approvals = (id: string): ApprovalModel => {
    live();
    let model = approvalModels.get(id);
    if (!model) {
      model = createApprovals(
        sidecars.connection(id).rpc,
        (sessionID) => entry(id, sessionID),
        factory,
      );
      approvalModels.set(id, model);
    }
    return model;
  };
  const terminalEvidence = (
    state: import("@otk/protocol").EntityState | undefined,
  ) =>
    state && ({
      terminal: state.terminal,
      outcome: state.outcome,
      unseen: state.counts.unseen > 0,
      terminalOrigin: state.terminalOrigin,
      terminalFailure: state.evidence?.failure,
    });
  const projection = (id: string): AttentionProjection => {
    let owner = projections.get(id);
    if (!owner) {
      owner = createAttentionProjection({
        entry: (sessionID) => entry(id, sessionID),
        ids: () => o.index.ids(id),
        entity: (sessionID) =>
          inbox(id).entities.isStale
            ? undefined
            : inbox(id).entities.get(entityKey("session", sessionID)),
        completions: true,
        factory,
      });
      projections.set(id, owner);
      owner.subscribe((changes) => {
        requests(id).observePermissionScopes(
          changes,
          (session) => entry(id, session),
        );
      });
      for (
        const [session, time] of Object.entries(inbox(id).state.inbox.finishes)
      ) {
        const supervision = terminalEvidence(
          inbox(id).entities.get(entityKey("session", session)),
        );
        owner.finished(
          session,
          time,
          true,
          supervision?.terminal === time ? supervision.outcome : undefined,
          supervision?.terminal === time ? supervision.unseen : undefined,
          supervision,
        );
      }
    }
    return owner;
  };
  const projectOwner = (id: string) => {
    let owner = projectOwners.get(id);
    if (owner) return owner;
    const counted = new Map<string, string>();
    projectLabels.set(id, counted);
    owner = createProjectProjection({
      factory,
      labelChanged(directory, label) {
        const before = counted.get(directory);
        if (label === before) return;
        if (before !== undefined) countName(before, -1);
        if (label === undefined) counted.delete(directory);
        else {
          counted.set(directory, label);
          countName(label, 1);
        }
      },
      inbox: () => inbox(id).state.inbox,
      entities: () => inbox(id).entities,
      entry: (sessionID) => o.index.getMetadata(id, sessionID),
    });
    projectOwners.set(id, owner);
    owner.inbox(inbox(id).state.inbox);
    owner.update(o.index.ids(id));
    projectReleases.set(id, [
      projection(id).subscribe((changes) =>
        owner!.update(changes.changes.map((c) => c.id))
      ),
      inbox(id).observeChanges((changes) => {
        owner!.inbox(inbox(id).state.inbox, changes);
        if (changes.baseline || changes.entities) {
          owner!.entities(changes.baseline ? "all" : changes.entities!);
        }
      }),
    ]);
    return owner;
  };
  const entries = (): MergedEntry[] =>
    sidecars.state.list.flatMap((s) => [...o.index.partition(s.id)]);
  const inbox = (id: string): InboxModel => {
    live();
    let model = inboxes.get(id);
    if (!model) {
      model = createInbox(
        sidecars.connection(id).rpc,
        factory,
        o.error,
        () => sidecars.connection(id).viewEpoch,
        () => attached(id),
        () =>
          visible?.project.sidecarId === id
            ? projectOwner(id).resolve(visible.project.directory)
            : undefined,
      );
      inboxes.set(id, model);
      const current = model;
      current.entities.stale(!attached(id));
      current.observeChanges((changes) => {
        if (changes.baseline || changes.entities) {
          current.entities.stale(!attached(id));
        }
        for (const cache of tabInputs.values()) {
          if (cache.server !== id) continue;
          if (changes.sessions.some((key) => cache.dependencies.has(key))) {
            invalidateTabContext(cache);
          }
          if (
            (changes.tasks || changes.baseline) && cache.followParent &&
            cache.taskSignature !==
              hierarchyTaskSignature(
                current.state.inbox.tasks,
                cache.dependencies,
              )
          ) {
            invalidateTabContext(cache);
          }
        }
        const owner = projections.get(id);
        if (!owner) return;
        const prefix = entityKey("session", "");
        const entitySessions = changes.entities?.filter((key) =>
          key.startsWith(prefix)
        ).map((key) => key.slice(prefix.length)) ?? [];
        owner.update(entitySessions, changes.baseline);
        const finishes = current.state.inbox.finishes;
        for (
          const session of changes.baseline
            ? new Set([...Object.keys(finishes), ...o.index.ids(id)])
            : new Set([...changes.sessions, ...entitySessions])
        ) {
          if (changes.baseline || finishes[session] !== undefined) {
            const time = finishes[session] ?? 0;
            const supervision = terminalEvidence(
              current.entities.get(entityKey("session", session)),
            );
            const outcome = supervision?.terminal === time
              ? supervision.outcome
              : undefined;
            const unseen = supervision?.terminal === time
              ? supervision.unseen
              : undefined;
            if (changes.admitted) {
              owner.admitFinished(session, time, outcome, unseen, supervision);
            } else {
              owner.finished(
                session,
                time,
                changes.baseline,
                outcome,
                unseen,
                supervision,
              );
            }
          }
        }
        if (changes.settlements) {
          owner.settled(changes.settlements);
        }
      });
    }
    return model;
  };
  const hierarchyTaskSignature = (
    tasks: readonly import("@otk/protocol").TaskRecord[],
    keys: ReadonlySet<string>,
  ) =>
    JSON.stringify(
      tasks.filter((task) => task.sessions.some((id) => keys.has(id))),
    );
  const tabInputs = new Map<string, {
    key: string;
    server: string;
    base: TabInput;
    dependencies: ReadonlySet<string>;
    dirty: boolean;
    taskSignature: string;
    tasks: TabInput["inbox"]["tasks"];
    followParent: boolean;
    value: TabInput;
  }>();
  const tabInput = (p: ProjectSelection): TabInput => {
    const owner = projectOwner(p.sidecarId), base = owner.input(p.directory);
    void hierarchyClock.state.revision;
    const followParent = tasksFollowParent;
    const key = JSON.stringify([p.sidecarId, base.directory]);
    void tabContextClock.state.keys[key];
    const tasks = () =>
      inbox(p.sidecarId).projectTasks(base.directory) ??
        base.inbox.tasks;
    const currentTasks = tasks();
    const previous = tabInputs.get(key);
    if (
      previous?.base === base && previous.followParent === followParent &&
      previous.tasks === currentTasks && !previous.dirty
    ) {
      return previous.value;
    }
    const context = new Map(base.entries.map((entry) => [entry.id, entry]));
    const dependencies = new Set(context.keys());
    const descendants = new Set(dependencies);
    for (const id of descendants) {
      for (const child of o.index.children(p.sidecarId, id)) {
        if (!descendants.has(child)) {
          descendants.add(child);
          dependencies.add(child);
        }
      }
    }
    const acquire = () => {
      for (const id of dependencies) {
        const entry = owner.entry(id);
        if (!entry) continue;
        context.set(id, entry);
        if (entry.parentID) dependencies.add(entry.parentID);
        if (entry.hierarchy?.rootID) dependencies.add(entry.hierarchy.rootID);
      }
    };
    acquire();
    for (const task of currentTasks) {
      if (
        (base.directories ?? [base.directory]).includes(task.directory) ||
        followParent && task.sessions.some((id) => dependencies.has(id))
      ) {
        for (const id of task.sessions) dependencies.add(id);
      }
    }
    acquire();
    const value: TabInput = {
      version: base.version,
      get connected() {
        return linked(p.sidecarId);
      },
      directory: base.directory,
      directories: base.directories,
      context: [...context.values()],
      followParent,
      get entries() {
        return base.entries;
      },
      get inbox() {
        const current = base.inbox, values = tasks();
        return current.tasks === values
          ? current
          : { ...current, tasks: values };
      },
      get taskActivity() {
        return base.taskActivity;
      },
      get entities() {
        return base.entities;
      },
    };
    tabInputs.set(key, {
      key,
      server: p.sidecarId,
      base,
      dependencies,
      dirty: false,
      taskSignature: hierarchyTaskSignature(tasks(), dependencies),
      tasks: currentTasks,
      followParent,
      value,
    });
    return value;
  };
  const tabs = (p: ProjectSelection): ClientTabs => {
    live();
    p = { ...p, directory: projectOwner(p.sidecarId).resolve(p.directory) };
    const key = `${p.sidecarId}/${p.directory}`;
    let model = tabModels.get(key);
    if (!model) {
      model = createTabs(inbox(p.sidecarId).promote, factory, {
        input: () => tabInput(p),
        session: (sessionID) =>
          sidecars.connection(p.sidecarId).rpc.call("session.get", {
            sessionID,
          }),
      });
      model.update(tabInput(p));
      tabModels.set(key, model);
    }
    return model;
  };
  const sessionCollection = (
    p: ProjectSelection,
    query?: string,
  ) => {
    const lists = listsFor(p, query),
      key = JSON.stringify([p.sidecarId, p.directory]);
    let tree = trees.get(key);
    if (!tree) trees.set(key, tree = createSessionTree());
    const input = tabInput(p), model = tabs(p);
    model.update(input);
    const taskOrder = model.tabs().map((tab) => tab.id);
    const owner = listOwner(p.sidecarId);
    const tasksKnown =
      inbox(p.sidecarId).projectTasks(input.directory) !== undefined;
    const answered = tasksKnown && lists.every((page) => owner.confirmed(page));
    const rows = model.orderRows(tree.rows(
      [...new Map(
        lists.flatMap((list) => owner.structures(list, listContext(p))).map((
          entry,
        ) => [entry.id, entry]),
      ).values()],
      input.inbox.tasks,
      p.directory,
      query,
      projectOwner(p.sidecarId).scopes(
        projectOwner(p.sidecarId).resolve(p.directory),
      ),
      taskOrder,
    ));
    let facts = rowFacts.get(rows);
    if (!facts) {
      const ungrouped = rows.some((row) =>
        row.kind === "session" && !row.group
      );
      const count = rows.reduce(
        (count, row) => count + Number(row.kind === "session" || !!row.group),
        0,
      );
      facts = {
        count,
        beforeAnswer: ungrouped ? rows : rows.filter((row) => !!row.group),
      };
      rowFacts.set(rows, facts);
    }
    return {
      state: collectionState(answered, tasksKnown ? facts.count : 0),
      // The synthetic heading is not evidence of an empty ungrouped list.
      rows: answered ? rows : facts.beforeAnswer,
      progress: owner.progress(lists.find((page) => page.loading) ?? lists[0]),
    };
  };
  const receive = (id: string, frame: ServerFrame): boolean => {
    if (stopped) return false;
    if (frame.t === "projects.order" || frame.t === "welcome") {
      projectOrder(id).receive(frame);
    }
    if (
      id === LOCAL_SIDECAR && frame.t === "prefs" &&
      tasksFollowParent !== frame.prefs.tasksFollowParent
    ) {
      tasksFollowParent = frame.prefs.tasksFollowParent;
      hierarchyClock.update((state) => {
        state.revision++;
      });
      sendView();
      for (const model of inboxes.values()) model.invalidateProjectTasks();
      for (const owner of listOwners.values()) owner.refresh();
    }
    approvals(id).receive(frame);
    if (frame.t === "forms.pending") {
      requests(id).replace("form", frame.requests);
    }
    if (frame.t === "content") requests(id).receive(frame.event);
    let accepted = true;
    if (frame.t === "index.snapshot" || frame.t === "index.patch") {
      accepted = o.index.receive(id, frame);
      if (!accepted) sidecars.connection(id).send({ t: "resnapshot" });
      else {
        requests(id).retireSessions((session) =>
          !!o.index.get(id, session)?.deleted
        );
        projection(id).update(
          o.index.changes(id)!.ids,
          frame.t === "index.snapshot",
        );
        projectOwners.get(id)?.update(o.index.changes(id)!.metadata);
        for (const cache of tabInputs.values()) {
          if (
            cache.server === id &&
            o.index.changes(id)!.metadata.some((key) =>
              cache.dependencies.has(key) ||
              cache.dependencies.has(
                o.index.getMetadata(id, key)?.parentID ?? "",
              )
            )
          ) {
            invalidateTabContext(cache);
          }
        }
        if (o.index.changes(id)!.metadata.length) {
          if (
            selected?.sidecarId === id &&
            o.index.changes(id)!.metadata.includes(selected.sessionID)
          ) bindVisibleCatalog();
        }
      }
    }
    if (frame.t === "welcome") {
      projections.get(id)?.reset();
      inbox(id).entities.stale(true);
    }
    if (frame.t === "approvals" || frame.t === "harness") projection(id);
    inbox(id).receive(frame);
    if (frame.t === "digest.progress") {
      for (const facts of frame.values) {
        progressOwner(id).receive(facts.directory ?? "", facts);
      }
    }
    catalogs.get(id)?.receive(frame);
    frecencies.get(id)?.receive(frame);
    if (frame.t === "welcome") bindVisibleCatalog();
    if (frame.t === "sessions.changed") {
      for (
        const directory of projectOwner(id).scopes(
          projectOwner(id).resolve(frame.directory),
        )
      ) listOwners.get(id)?.receive({ ...frame, directory });
    } else listOwners.get(id)?.receive(frame);
    if (frame.t === "welcome") listOwners.get(id)?.refresh();
    if (frame.t === "welcome" && visible?.project.sidecarId === id) {
      sendScope(id, {
        directory: visible.project.directory,
        sessions: visible.sessions,
      });
    }
    for (const observer of observers) observer.frame?.(id, frame, accepted);
    return accepted;
  };
  const sidecars = o.sidecars(receive);
  const stopLinks = sidecars.subscribe(() => {
    // Reconnection alone cannot revive old evidence. Accepted entity changes
    // or a baseline make the replica fresh again in observeChanges above.
    for (const [id, model] of inboxes) {
      if (!attached(id)) model.entities.stale(true);
    }
    for (const id of projections.keys()) projection(id);
  });
  const api: ServerResources = {
    progress: (id, directory) => {
      const owner = progressOwner(id),
        label = "Indexing sessions";
      const local = owner.display(directory ?? "", label);
      return local.text ? local : owner.display("", label);
    },
    ownsFailure: (cause) =>
      sidecars.state.list.some((server) =>
        sidecars.connection(server.id).rpc.ownsFailure(cause)
      ),
    sidecars,
    scope(project, sessions = [], selection, nextCrumbs = []) {
      if (
        visible?.project.sidecarId === project?.sidecarId &&
        visible?.project.directory === project?.directory &&
        JSON.stringify(visible?.sessions) === JSON.stringify(sessions) &&
        selected?.sidecarId === selection?.sidecarId &&
        selected?.sessionID === selection?.sessionID &&
        JSON.stringify(crumbs) === JSON.stringify(nextCrumbs)
      ) return;
      if (visible && visible.project.sidecarId !== project?.sidecarId) {
        sendScope(visible.project.sidecarId, { sessions: [] });
      }
      if (
        project &&
        (visible?.project.directory !== project.directory ||
          visible.project.sidecarId !== project.sidecarId)
      ) {
        progressOwner(project.sidecarId).reset(project.directory);
      }
      visible = project && { project, sessions: [...new Set(sessions)] };
      selected = selection;
      crumbs = nextCrumbs;
      sendView();
      bindVisibleCatalog();
      if (project) {
        listOwner(project.sidecarId).activate(listInputs(project));
      }
      if (visible) {
        sendScope(visible.project.sidecarId, {
          directory: visible.project.directory,
          sessions: visible.sessions,
        });
      }
    },
    historyNeighbors(neighbors) {
      if (JSON.stringify(neighbors) === JSON.stringify(historyNeighbors)) {
        return;
      }
      historyNeighbors = neighbors;
      sendView();
    },
    retainSessionReference(sidecarId, sessionID) {
      let ids = sessionReferences.get(sidecarId);
      if (!ids) sessionReferences.set(sidecarId, ids = new Map());
      const refs = ids;
      const count = refs.get(sessionID) ?? 0;
      refs.set(sessionID, count + 1);
      if (!count) scheduleReferenceView();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const next = (refs.get(sessionID) ?? 1) - 1;
        if (next > 0) refs.set(sessionID, next);
        else {
          refs.delete(sessionID);
          if (!refs.size && sessionReferences.get(sidecarId) === refs) {
            sessionReferences.delete(sidecarId);
          }
          scheduleReferenceView();
        }
      };
    },
    visibleRows(project, rows, query = "") {
      const next = {
        project,
        rows: [...rows].filter((id) => !id.startsWith("heading:")),
        query,
      };
      if (JSON.stringify(next) === JSON.stringify(rowDemand)) return;
      rowDemand = next;
      sendView();
      listOwner(project.sidecarId).activate(listInputs(project, query));
      for (const list of listsFor(project, query)) {
        listOwner(project.sidecarId).viewport(
          list,
          rows,
          () =>
            sessionCollection(project, query).rows.filter((row) =>
              row.kind === "session"
            )
              .map((row) => row.key),
        );
      }
    },
    async projectSession(project, preferred, attention) {
      const connection = sidecars.connection(project.sidecarId);
      return await connection.rpc.call("navigation.default", {
        directory: project.directory,
        preferred,
        ...(attention ? { attention: true } : {}),
      }) ?? undefined;
    },
    projectDirectory: (sidecar, directory, repoID) =>
      projectOwner(sidecar).resolve(directory, repoID),
    inbox,
    fileFacts,
    directoryCatalog: (id, directory) => {
      live();
      return directoryOwner(id).acquire(directory);
    },
    frecencyCatalog: (id, directory) => {
      live();
      return frecencyOwner(id).acquire(directory);
    },
    approvals,
    forms: (id) => requests(id).forms(),
    tabs,
    holdTaskOrder(p) {
      const model = tabs(p);
      model.update(tabInput(p));
      return model.holdOrder();
    },
    async moveProject(id, move) {
      const result = await sidecars.connection(id).rpc.call(
        "projects.move",
        move,
      );
      await projectOrder(id).settled(result.revision);
    },
    entry,
    server,
    connected,
    linked,
    declares,
    advertised,
    projected: (id, sessionID) => projection(id).get(sessionID),
    projectedProject: (id, directory) => {
      const owner = projection(id);
      return projectOwner(id).input(directory).entries.map((entry) =>
        owner.get(entry.id)!
      ).filter(Boolean);
    },
    observeEntries: (id, listener) => projection(id).subscribe(listener),
    entries,
    metadataEntries: () =>
      sidecars.state.list.flatMap((s) => projectOwner(s.id).metadata()),
    indexEntries: (id) => o.index.partition(id),
    indexChanges: (id) => o.index.changes(id),
    receive,
    taskActions: (p) => {
      const rpc = sidecars.connection(p.sidecarId).rpc;
      return {
        ...createTaskActions(rpc, p.directory),
        async reorder(ids) {
          const tasks = new Map(
            inbox(p.sidecarId).state.inbox.tasks.map((task) => [task.id, task]),
          );
          const scopes = new Map<string, string[]>();
          for (const id of ids) {
            const directory = tasks.get(id)?.directory ?? p.directory;
            const values = scopes.get(directory) ?? [];
            values.push(id);
            scopes.set(directory, values);
          }
          for (const [directory, values] of scopes) {
            await createTaskActions(rpc, directory).reorder(values);
          }
        },
      };
    },
    anyAdvertised: (capability) =>
      sidecars.state.list.some((s) => advertised(s.id, capability)),
    connectionKey: (id) => server(id)?.connectionVersion,
    projectEntries: (p) =>
      projectOwner(p.sidecarId).input(p.directory).entries.flatMap((entry) => {
        const row = o.index.get(p.sidecarId, entry.id);
        return row ? [row] : [];
      }),
    projectRow: (p, now) =>
      projectOwner(p.sidecarId).row(
        projectOwner(p.sidecarId).resolve(p.directory),
        now,
      ),
    entities: (server) => inbox(server).entities,
    projectMetadata: (p) => tabInput(p).entries as readonly MergedMetadata[],
    metadataEntry: (id, sessionID) => projectOwner(id).entry(sessionID),
    projectContents: (p) => sessionCollection(p).state,
    sessionCollection,
    sessionRows: (p, query) => sessionCollection(p, query).rows,
    projectsReady: () =>
      sidecars.state.list.every((s) =>
        projectOrder(s.id).ready && inbox(s.id).state.ready
      ),
    projectProgress: (p) => o.index.progress(p.sidecarId, p.directory),
    checkoutLabel: (id, directory) => projectOwner(id).label(directory),
    projectLabel: (id, directory) => projectOwner(id).projectLabel(directory),
    notificationLocation({ sidecar, session }) {
      const entry = o.index.getMetadata(sidecar, session);
      if (!entry) return undefined;
      const projects = projectOwner(sidecar);
      const directory = projects.resolve(entry.directory, entry.projectID);
      const project = { sidecarId: sidecar, directory };
      const model = tabs(project);
      model.update(tabInput(project));
      const title = sessionTitle(session, entry.title);
      return {
        project: projects.projectIdentity(directory),
        task: model.taskTitleFor(session) ?? title,
        session: title,
      };
    },
    async updateProject({ sidecarId, directory, projectID }, patch) {
      await sidecars.connection(sidecarId).rpc.call("project.update", {
        directory,
        projectID,
        patch,
      });
    },
    duplicateProjectName: (name) => {
      for (const s of sidecars.state.list) projectOwner(s.id);
      void nameClock.state.keys[name];
      return (names.get(name) ?? 0) > 1;
    },
    projects: (now) => {
      // The configured server list is durable before any server answers.
      const rows = sidecars.state.list.flatMap((s, serverOrder) => {
        const order = projectOrder(s.id);
        if (!order.ready) return [];
        const owner = projectOwner(s.id);
        return owner.directories().map((directory) => {
          const row = owner.row(directory, now)!;
          const slot = order.slot(directory);
          if (!slot) {
            let reported = missingOrder.get(s.id);
            if (!reported) missingOrder.set(s.id, reported = new Set());
            if (!reported.has(directory)) {
              reported.add(directory);
              reportDiagnostic(
                o.diagnostic ?? console.warn,
                new Error(
                  `project order missing directory: ${s.id} ${directory}`,
                ),
              );
            }
          }
          let labelled = labelledRows.get(row);
          if (
            !labelled || labelled.label !== s.label ||
            labelled.otkProjectID !== slot?.id
          ) {
            labelled = {
              ...row,
              sidecarId: s.id,
              label: s.label,
              otkProjectID: slot?.id,
            };
            labelledRows.set(row, labelled);
          }
          return { row: labelled, serverOrder, slot };
        });
      });
      return projectHierarchy(orderProjectRows(rows));
    },
    tabSnapshot(p) {
      const input = tabInput(p);
      void input.entries;
      void input.taskActivity;
      void input.inbox;
      return input;
    },
    syncTabs(p, input, selected) {
      const model = tabs(p);
      input = tabInput(p);
      model.update(input);
      const id = selected?.sessionID;
      if (
        id &&
        input.entries.some((e) => e.id === id) &&
        (model.state.sessionID !== id || !model.state.selected)
      ) model.preview(id);
    },
    historySources: () =>
      sidecars.state.list.filter((s) =>
        s.id === visible?.project.sidecarId && advertised(s.id, "history")
      )
        .map((s) => ({ id: s.id, connection: sidecars.connection(s.id) })),
    observe(observer) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    add: (url, label) => sidecars.add(url, label),
    remove(id) {
      orders.get(id)?.stop();
      orders.delete(id);
      missingOrder.delete(id);
      requestSubscriptions.get(id)?.();
      requestSubscriptions.delete(id);
      listOwners.get(id)?.stop();
      listOwners.delete(id);
      progressOwners.get(id)?.stop();
      progressOwners.delete(id);
      for (const release of projectReleases.get(id) ?? []) release();
      projectReleases.delete(id);
      for (const label of projectLabels.get(id)?.values() ?? []) {
        countName(label, -1);
      }
      projectLabels.delete(id);
      projectOwners.delete(id);
      for (const [key, cache] of tabInputs) {
        if (cache.server === id) tabInputs.delete(key);
      }
      fileFactOwners.get(id)?.stop();
      fileFactOwners.delete(id);
      catalogs.get(id)?.stop();
      catalogs.delete(id);
      frecencies.get(id)?.stop();
      frecencies.delete(id);
      o.index.remove(id);
      for (const observer of observers) observer.removed?.(id);
      inboxes.get(id)?.stop();
      inboxes.delete(id);
      approvalModels.get(id)?.stop();
      approvalModels.delete(id);
      projections.get(id)?.stop();
      projections.delete(id);
      for (const [key, model] of tabModels) {
        if (!key.startsWith(`${id}/`)) continue;
        model.stop();
        tabModels.delete(key);
      }
      sidecars.remove(id);
    },
    async layout(patch) {
      await sidecars.connection(LOCAL_SIDECAR).rpc.call("layout.patch", patch);
    },
    async projectCollapse(project, collapsed) {
      await sidecars.connection(LOCAL_SIDECAR).rpc.call("layout.project", {
        sidecarId: project.sidecarId,
        directory: project.directory,
        collapsed,
      });
    },
    async treeCollapse(target, collapsed) {
      await sidecars.connection(LOCAL_SIDECAR).rpc.call("layout.tree", {
        ...target,
        collapsed,
      });
    },
    async rememberLocation(location) {
      await sidecars.connection(LOCAL_SIDECAR).rpc.call(
        "layout.location",
        location,
      );
    },
    async inactive(p, inactive) {
      await sidecars.connection(p.sidecarId).rpc.call("projects.inactive", {
        directory: p.directory,
        inactive,
      });
    },
    async setPreference(key, value) {
      await sidecars.connection(LOCAL_SIDECAR).rpc.call("prefs.set", {
        key,
        value,
      });
    },
    stop() {
      for (const order of orders.values()) order.stop();
      orders.clear();
      for (const release of requestSubscriptions.values()) release();
      requestSubscriptions.clear();
      if (stopped) return;
      stopped = true;
      sessionReferences.clear();
      for (const owner of listOwners.values()) owner.stop();
      listOwners.clear();
      for (const owner of progressOwners.values()) owner.stop();
      progressOwners.clear();
      stopLinks();
      for (const releases of projectReleases.values()) {
        for (const release of releases) {
          release();
        }
      }
      projectReleases.clear();
      projectOwners.clear();
      tabInputs.clear();
      visibleCatalog?.stopReady?.();
      visibleCatalog?.directory.release();
      visibleCatalog?.frecency.release();
      visibleCatalog = undefined;
      for (const owner of fileFactOwners.values()) owner.stop();
      fileFactOwners.clear();
      for (const owner of catalogs.values()) owner.stop();
      for (const owner of frecencies.values()) owner.stop();
      catalogs.clear();
      frecencies.clear();
      for (const model of approvalModels.values()) model.stop();
      for (const model of tabModels.values()) model.stop();
      approvalModels.clear();
      for (const projection of projections.values()) projection.stop();
      projections.clear();
      tabModels.clear();
      for (const inbox of inboxes.values()) inbox.stop();
      inboxes.clear();
      observers.clear();
      sidecars.stop();
    },
  };
  return api;
}
