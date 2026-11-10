// SPDX-License-Identifier: LGPL-3.0-only
import type {
  CapabilityName,
  IndexEntry,
  Preferences,
  ProjectLocation,
  ServerFrame,
  SessionStructure,
  ShellLayout,
} from "@otk/protocol";
import { type ApprovalModel, createApprovals } from "./approvals.ts";
import {
  type ApprovalAttention,
  type AttentionProjection,
  createAttentionProjection,
  type EntryChanges,
} from "./approval-attention.ts";
import type { SidecarConnection } from "./connection.ts";
import type {
  ClientIndex,
  IndexChanges,
  MergedEntry,
  MergedMetadata,
} from "./index.ts";
import { createInbox, type InboxModel, inboxStatus } from "./inbox.ts";
import {
  createProjectProjection,
  type ProjectProjectionRow,
} from "./project-projection.ts";
import type { Selection } from "./session.ts";
import { projectName, type ProjectSelection } from "./project-navigation.ts";
import {
  type ClientSidecars,
  LOCAL_SIDECAR,
  type SidecarState,
} from "./sidecars.ts";
import { createState, type StateFactory } from "./state.ts";
import { createProgress, type ProgressDisplay } from "./progress.ts";
import { type ClientTabs, createTabs, type TabInput } from "./tabs.ts";
import { createTaskActions, type TaskActions } from "./task-actions.ts";
import { requestAttention } from "./request-attention.ts";
import { createSessionTree, type SessionListRow } from "./session-tree.ts";
import { createCatalogCodecs } from "@otk/protocol";
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

export interface FrameObserver {
  frame?(id: string, frame: ServerFrame, accepted: boolean): void;
  removed?(id: string): void;
}
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
  projectSession(
    project: ProjectSelection,
    preferred?: string,
  ): Promise<string | undefined>;
  sidecars: ClientSidecars;
  inbox(id: string): InboxModel;
  directoryCatalog(id: string, directory: string): DirectoryCatalogLease;
  frecencyCatalog(id: string, directory: string): FrecencyCatalogLease;
  approvals(id: string): ApprovalModel;
  tabs(project: ProjectSelection): ClientTabs;
  taskActions(project: ProjectSelection): TaskActions;
  entry(sidecarId: string, sessionID: string): IndexEntry | undefined;
  server(id: string): SidecarState | undefined;
  connected(id: string): boolean;
  linked(id: string): boolean;
  advertised(id: string, capability: CapabilityName): boolean;
  declares(id: string, capability: CapabilityName): boolean;
  anyAdvertised(capability: CapabilityName): boolean;
  connectionKey(id: string): number | undefined;
  attention(id: string): ApprovalAttention;
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
  sessionRowsReady(project: ProjectSelection): boolean;
  sessionRowsLoading(project: ProjectSelection): boolean;
  sessionRowsStatus(project: ProjectSelection): ProgressDisplay;
  projectProgress(
    project: ProjectSelection,
  ): { busy: boolean; announcement: string };
  projectRow(
    project: ProjectSelection,
    now: number,
    ageing?: readonly number[],
  ): ProjectProjectionRow | undefined;
  duplicateProjectName(name: string): boolean;
  projects(
    now: number,
    ageing?: readonly number[],
  ): (ProjectProjectionRow & { sidecarId: string; label: string })[];
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
}): ServerResources {
  const factory = o.factory ?? createState;
  const pendingForms = factory<
    { servers: Record<string, import("@otk/protocol").FormRequest[]> }
  >({ servers: {} });
  const progressOwners = new Map<string, ReturnType<typeof createProgress>>();
  const progressOwner = (id: string) => {
    let owner = progressOwners.get(id);
    if (!owner) progressOwners.set(id, owner = createProgress(factory));
    return owner;
  };
  const inboxes = new Map<string, InboxModel>();
  const catalogs = new Map<string, ClientDirectoryCatalogs>();
  const frecencies = new Map<
    string,
    ReturnType<typeof createFrecencyCatalogs>
  >();
  let visibleCatalog: {
    key: string;
    directory: DirectoryCatalogLease;
    frecency: FrecencyCatalogLease;
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
        refresh: (directory) =>
          sidecars.connection(id).rpc.call("catalogs.refresh", { directory })
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
    const project = visible?.project;
    const key = project &&
      JSON.stringify([project.sidecarId, project.directory]);
    if (visibleCatalog?.key === key) return;
    visibleCatalog?.directory.release();
    visibleCatalog?.frecency.release();
    visibleCatalog = undefined;
    if (project && declares(project.sidecarId, "catalogs")) {
      visibleCatalog = {
        key: key!,
        directory: directoryOwner(project.sidecarId).acquire(project.directory),
        frecency: frecencyOwner(project.sidecarId).acquire(project.directory),
      };
    }
  };
  const approvalModels = new Map<string, ApprovalModel>();
  const projections = new Map<string, AttentionProjection>();
  const projectOwners = new Map<
    string,
    ReturnType<typeof createProjectProjection>
  >();
  const operationCache = new Map<string, ReturnType<typeof requestAttention>>();
  const projectReleases = new Map<string, (() => void)[]>();
  const names = new Map<string, number>();
  const nameClock = factory({ keys: {} as Record<string, number> });
  const nameMembership = (directory: string, present: boolean) => {
    const name = projectName(directory), before = names.get(name) ?? 0;
    const after = before + (present ? 1 : -1);
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
    { sidecarId: string; label: string } & ProjectProjectionRow
  >();
  const tabModels = new Map<string, ClientTabs>();
  const requestObservers = new Map<string, () => void>();
  const requestClock = factory({ keys: {} as Record<string, number> });
  const observers = new Set<FrameObserver>();
  let stopped = false;
  let visible: { project: ProjectSelection; sessions: string[] } | undefined;
  let selected: Selection | undefined, crumbs: string[] = [];
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
  const listFor = (project: ProjectSelection, query?: string) =>
    listOwner(project.sidecarId).get({
      directory: project.directory,
      query: query ?? "",
    });
  const trees = new Map<string, ReturnType<typeof createSessionTree>>();
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
      input.inbox.tasks.filter((task) => task.directory === p.directory)
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
      if (entry.deleted || inboxStatus(entry, input.inbox) !== "idle") {
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
          parentID: entry.parentID,
          retained: !!entry.deleted,
        }]
        : [];
    });
    listContexts.set(input, { scope, values: context });
    return context;
  };
  const inboxDirectories = new Map<string, string>();
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
        query: rows?.query,
      });
    }
  };
  const sendScope = (
    id: string,
    value: { directory?: string; sessions: string[] },
  ) => {
    if (advertised(id, "digests")) {
      void sidecars.connection(id).rpc.call("digests.scope", value).catch(
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
  const projection = (id: string): AttentionProjection => {
    let owner = projections.get(id);
    if (!owner) {
      owner = createAttentionProjection({
        entry: (sessionID) => entry(id, sessionID),
        ids: () => o.index.ids(id),
        children: (sessionID) => o.index.children(id, sessionID),
        completions: true,
        factory,
      });
      projections.set(id, owner);
      for (
        const [session, time] of Object.entries(inbox(id).state.inbox.finishes)
      ) {
        owner.finished(session, time, true);
      }
    }
    const model = approvals(id);
    owner.configure(
      model.state.snapshot.enabled,
      linked(id) && model.state.ready,
    );
    return owner;
  };
  const attention = (id: string): ApprovalAttention => {
    const current = approvals(id).attention(linked(id));
    const owner = projection(id);
    return {
      ...current,
      entries: (entries) =>
        entries.map((entry) => {
          const projected = owner.get(entry.id);
          return projected && projected.attention !== entry.attention
            ? { ...entry, attention: projected.attention }
            : entry;
        }),
    };
  };
  const operationAttention = (id: string) => {
    const rpc = sidecars.connection(id).rpc;
    if (!requestObservers.has(id) && !stopped) {
      requestObservers.set(
        id,
        rpc.requests.subscribe(() => {
          const previous = operationCache.get(id);
          operationCache.delete(id);
          refreshOperations(id, previous);
          requestClock.update((state) => {
            state.keys[id] = (state.keys[id] ?? 0) + 1;
          });
        }),
      );
    }
    void requestClock.state.keys[id];
    let value = operationCache.get(id);
    if (value) return value;
    value = requestAttention(
      rpc.requests.operations(),
      rpc.metadata,
      (sessionID) => o.index.getMetadata(id, sessionID),
      inbox(id).state.inbox.tasks,
    );
    operationCache.set(id, value);
    return value;
  };
  const refreshOperations = (
    id: string,
    previous?: ReturnType<typeof requestAttention>,
  ) => {
    const owner = projectOwners.get(id);
    if (!owner) return;
    const next = operationAttention(id);
    owner.update(
      new Set([...previous?.sessions.keys() ?? [], ...next.sessions.keys()]),
    );
    owner.operations(next.projectStates);
  };
  const projectOwner = (id: string) => {
    let owner = projectOwners.get(id);
    if (owner) return owner;
    const decorated = new WeakMap<MergedMetadata, MergedMetadata>();
    owner = createProjectProjection({
      factory,
      membership: nameMembership,
      inbox: () => inbox(id).state.inbox,
      taskActivity: () => operationAttention(id).tasks,
      entry: (sessionID) => {
        const raw = o.index.getMetadata(id, sessionID);
        if (!raw) return undefined;
        const attention = projection(id).get(sessionID)?.attention ??
          raw.attention;
        const operationStatus = operationAttention(id).sessions.get(sessionID);
        if (attention === raw.attention && !operationStatus) return raw;
        const previous = decorated.get(raw);
        if (
          previous?.attention === attention &&
          previous.operationStatus === operationStatus
        ) return previous;
        const value = { ...raw, attention, operationStatus };
        decorated.set(raw, value);
        return value;
      },
    });
    projectOwners.set(id, owner);
    owner.inbox(inbox(id).state.inbox);
    owner.update(o.index.ids(id));
    owner.operations(operationAttention(id).projectStates);
    projectReleases.set(id, [
      projection(id).subscribe((changes) =>
        owner!.update(changes.changes.map((c) => c.id))
      ),
      inbox(id).observeChanges((changes) => {
        const previous = operationCache.get(id);
        if (changes.tasks) operationCache.delete(id);
        owner!.inbox(inbox(id).state.inbox, changes);
        if (changes.tasks) refreshOperations(id, previous);
      }),
    ]);
    return owner;
  };
  const entries = (): MergedEntry[] =>
    sidecars.state.list.flatMap((s) =>
      operationAttention(s.id).entries(
        attention(s.id).entries(o.index.partition(s.id)),
      )
    );
  const inbox = (id: string): InboxModel => {
    live();
    let model = inboxes.get(id);
    if (!model) {
      model = createInbox(
        sidecars.connection(id).rpc,
        factory,
        o.error,
        () => sidecars.connection(id).viewEpoch,
      );
      inboxes.set(id, model);
      const current = model;
      current.observeChanges((changes) => {
        const owner = projections.get(id);
        if (!owner) return;
        const finishes = current.state.inbox.finishes;
        for (
          const session of changes.baseline
            ? new Set([...Object.keys(finishes), ...o.index.ids(id)])
            : changes.sessions
        ) {
          if (changes.baseline || finishes[session] !== undefined) {
            owner.finished(session, finishes[session] ?? 0, changes.baseline);
          }
        }
      });
    }
    return model;
  };
  const tabInput = (p: ProjectSelection): TabInput =>
    projectOwner(p.sidecarId).input(p.directory);
  const tabs = (p: ProjectSelection): ClientTabs => {
    live();
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
  const receive = (id: string, frame: ServerFrame): boolean => {
    if (stopped) return false;
    approvals(id).receive(frame);
    if (frame.t === "forms.pending") {
      pendingForms.update((s) => {
        s.servers[id] = frame.requests;
      });
    }
    let accepted = true;
    if (frame.t === "index.snapshot" || frame.t === "index.patch") {
      accepted = o.index.receive(id, frame);
      if (!accepted) sidecars.connection(id).send({ t: "resnapshot" });
      else {
        const previous = operationCache.get(id);
        if (o.index.changes(id)!.metadata.length) operationCache.delete(id);
        projection(id).update(
          o.index.changes(id)!.ids,
          frame.t === "index.snapshot",
        );
        projectOwners.get(id)?.update(o.index.changes(id)!.metadata);
        if (o.index.changes(id)!.metadata.length) {
          refreshOperations(id, previous);
        }
      }
    }
    if (frame.t === "welcome") projections.get(id)?.reset();
    if (frame.t === "approvals" || frame.t === "harness") projection(id);
    inbox(id).receive(frame);
    if (
      frame.t === "inbox.snapshot" &&
      frame.epoch === sidecars.connection(id).viewEpoch &&
      visible?.project.sidecarId === id
    ) {
      inboxDirectories.set(id, visible.project.directory);
    }
    if (frame.t === "digest.progress") {
      for (const facts of frame.values) {
        progressOwner(id).receive(facts.directory ?? "", facts);
      }
    }
    catalogs.get(id)?.receive(frame);
    frecencies.get(id)?.receive(frame);
    if (frame.t === "welcome") bindVisibleCatalog();
    listOwners.get(id)?.receive(frame);
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
        listOwner(project.sidecarId).activate({ directory: project.directory });
      }
      if (visible) {
        sendScope(visible.project.sidecarId, {
          directory: visible.project.directory,
          sessions: visible.sessions,
        });
      }
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
      listOwner(project.sidecarId).activate({
        directory: project.directory,
        query,
      });
      const list = listFor(project, query);
      listOwner(project.sidecarId).viewport(list, rows);
    },
    async projectSession(project, preferred) {
      const connection = sidecars.connection(project.sidecarId);
      if (preferred) {
        const identities = await connection.rpc.call("sessions.identities", {
          ids: [preferred],
        });
        if (
          identities.some((row) =>
            row.id === preferred && row.directory === project.directory
          )
        ) return preferred;
      }
      const page = await connection.rpc.call("sessions.list", {
        directory: project.directory,
        parentID: null,
        limit: 1,
      });
      return page.items[0]?.id;
    },
    inbox,
    directoryCatalog: (id, directory) => {
      live();
      return directoryOwner(id).acquire(directory);
    },
    frecencyCatalog: (id, directory) => {
      live();
      return frecencyOwner(id).acquire(directory);
    },
    approvals,
    forms: (id) => pendingForms.state.servers[id] ?? [],
    tabs,
    entry,
    server,
    connected,
    linked,
    declares,
    advertised,
    attention,
    projected: (id, sessionID) => projection(id).get(sessionID),
    projectedProject: (id, directory) => {
      const owner = projection(id);
      return o.index.ids(id, directory).map((sessionID) =>
        owner.get(sessionID)!
      ).filter(Boolean);
    },
    observeEntries: (id, listener) => projection(id).subscribe(listener),
    entries,
    metadataEntries: () =>
      sidecars.state.list.flatMap((s) => projectOwner(s.id).metadata()),
    indexEntries: (id) => o.index.partition(id),
    indexChanges: (id) => o.index.changes(id),
    receive,
    taskActions: (p) =>
      createTaskActions(sidecars.connection(p.sidecarId).rpc, p.directory),
    anyAdvertised: (capability) =>
      sidecars.state.list.some((s) => advertised(s.id, capability)),
    connectionKey: (id) => server(id)?.connectionVersion,
    projectEntries: (p) =>
      operationAttention(p.sidecarId).entries(
        attention(p.sidecarId).entries(
          o.index.partition(p.sidecarId, p.directory),
        ),
      ),
    projectRow: (p, now, ageing) =>
      projectOwner(p.sidecarId).row(p.directory, now, ageing),
    projectMetadata: (p) => tabInput(p).entries as readonly MergedMetadata[],
    metadataEntry: (id, sessionID) => projectOwner(id).entry(sessionID),
    sessionRowsReady: (p) => {
      const page = listFor(
        p,
        rowDemand?.project.directory === p.directory &&
          rowDemand.project.sidecarId === p.sidecarId
          ? rowDemand.query
          : "",
      );
      return (page.ready || listContext(p).length > 0) &&
        inbox(p.sidecarId).state.ready &&
        inboxDirectories.get(p.sidecarId) === p.directory;
    },
    sessionRowsLoading: (p) =>
      listFor(
        p,
        rowDemand?.project.directory === p.directory &&
          rowDemand.project.sidecarId === p.sidecarId
          ? rowDemand.query
          : "",
      ).loading,
    sessionRowsStatus: (p) =>
      listOwner(p.sidecarId).progress(
        listFor(
          p,
          rowDemand?.project.directory === p.directory &&
            rowDemand.project.sidecarId === p.sidecarId
            ? rowDemand.query
            : "",
        ),
      ),
    sessionRows: (p, query) => {
      const list = listFor(p, query),
        key = JSON.stringify([p.sidecarId, p.directory]);
      let tree = trees.get(key);
      if (!tree) trees.set(key, tree = createSessionTree());
      return tree.rows(
        listOwner(p.sidecarId).structures(list, listContext(p)),
        inbox(p.sidecarId).state.inbox.tasks,
        p.directory,
        query,
      );
    },
    projectProgress: (p) => o.index.progress(p.sidecarId, p.directory),
    duplicateProjectName: (name) => {
      for (const s of sidecars.state.list) projectOwner(s.id);
      void nameClock.state.keys[name];
      return (names.get(name) ?? 0) > 1;
    },
    projects: (now, ageing) => {
      const rows = sidecars.state.list.flatMap((s) => {
        const owner = projectOwner(s.id);
        return owner.directories().map((directory) => {
          const row = owner.row(directory, now, ageing)!;
          let labelled = labelledRows.get(row);
          if (!labelled || labelled.label !== s.label) {
            labelled = { ...row, sidecarId: s.id, label: s.label };
            labelledRows.set(row, labelled);
          }
          return labelled;
        }).sort((a, b) => a.order - b.order);
      }).sort((a, b) => {
        const rank = { tracked: 0, index: 1, template: 2 };
        if (a.source === "tracked" && b.source === "tracked") return 0;
        return rank[a.source ?? "tracked"] - rank[b.source ?? "tracked"] ||
          a.order - b.order ||
          projectName(a.directory).localeCompare(projectName(b.directory)) ||
          a.directory.localeCompare(b.directory) ||
          a.label.localeCompare(b.label);
      });
      return rows;
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
        input.entries.some((e) => e.id === id && e.directory === p.directory) &&
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
      listOwners.get(id)?.stop();
      listOwners.delete(id);
      inboxDirectories.delete(id);
      progressOwners.get(id)?.stop();
      progressOwners.delete(id);
      for (const release of projectReleases.get(id) ?? []) release();
      projectReleases.delete(id);
      for (const directory of projectOwners.get(id)?.directories() ?? []) {
        nameMembership(directory, false);
      }
      projectOwners.delete(id);
      operationCache.delete(id);
      catalogs.get(id)?.stop();
      catalogs.delete(id);
      frecencies.get(id)?.stop();
      frecencies.delete(id);
      requestObservers.get(id)?.();
      requestObservers.delete(id);
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
      if (stopped) return;
      stopped = true;
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
      operationCache.clear();
      visibleCatalog?.directory.release();
      visibleCatalog?.frecency.release();
      visibleCatalog = undefined;
      for (const owner of catalogs.values()) owner.stop();
      for (const owner of frecencies.values()) owner.stop();
      catalogs.clear();
      frecencies.clear();
      for (const release of requestObservers.values()) release();
      requestObservers.clear();
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
