// SPDX-License-Identifier: LGPL-3.0-only
import type {
  CapabilityName,
  IndexEntry,
  Preferences,
  ProjectLocation,
  ServerFrame,
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
import {
  createInbox,
  type InboxModel,
  type InboxProject,
  inboxProjects,
} from "./inbox.ts";
import type { Selection } from "./session.ts";
import { projectName, type ProjectSelection } from "./project-navigation.ts";
import {
  type ClientSidecars,
  LOCAL_SIDECAR,
  type SidecarState,
} from "./sidecars.ts";
import { createState, type StateFactory } from "./state.ts";
import { type ClientTabs, createTabs, type TabInput } from "./tabs.ts";
import { createTaskActions, type TaskActions } from "./task-actions.ts";
import { requestAttention } from "./request-attention.ts";
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

export interface FrameObserver {
  frame?(id: string, frame: ServerFrame, accepted: boolean): void;
  removed?(id: string): void;
}
export interface ServerResources {
  ownsFailure?(cause: unknown): boolean;
  scope(project?: ProjectSelection, sessions?: string[]): void;
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
  projects(
    now: number,
    ageing?: readonly number[],
  ): (InboxProject & { sidecarId: string; label: string })[];
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
  sidecars(receive: (id: string, frame: ServerFrame) => void): ClientSidecars;
  index: ClientIndex;
  factory?: StateFactory;
  error?: (error: unknown) => void;
}): ServerResources {
  const factory = o.factory ?? createState;
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
  const tabModels = new Map<string, ClientTabs>();
  const requestObservers = new Map<string, () => void>();
  const requestClock = factory({ revision: 0 });
  const observers = new Set<FrameObserver>();
  let stopped = false;
  let visible: { project: ProjectSelection; sessions: string[] } | undefined;
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
        factory,
      });
      projections.set(id, owner);
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
        rpc.requests.subscribe(() =>
          requestClock.update((state) => {
            state.revision++;
          })
        ),
      );
    }
    void requestClock.state.revision;
    return requestAttention(
      rpc.requests.operations(),
      rpc.metadata,
      o.index.catalog(id),
      inbox(id).state.inbox.tasks,
    );
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
      model = createInbox(sidecars.connection(id).rpc, factory, o.error);
      inboxes.set(id, model);
    }
    return model;
  };
  const tabInput = (p: ProjectSelection): TabInput => ({
    directory: p.directory,
    get taskActivity() {
      return operationAttention(p.sidecarId).tasks;
    },
    get entries() {
      return operationAttention(p.sidecarId).entries(
        attention(p.sidecarId).entries(
          o.index.catalog(p.sidecarId, p.directory),
        ),
      );
    },
    get inbox() {
      return inbox(p.sidecarId).state.inbox;
    },
  });
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
  const receive = (id: string, frame: ServerFrame): void => {
    if (stopped) return;
    approvals(id).receive(frame);
    let accepted = true;
    if (frame.t === "index.snapshot" || frame.t === "index.patch") {
      accepted = o.index.receive(id, frame);
      if (!accepted) sidecars.connection(id).send({ t: "resnapshot" });
      else {projection(id).update(
          o.index.changes(id)!.ids,
          frame.t === "index.snapshot",
        );}
    }
    if (frame.t === "welcome") projections.get(id)?.reset();
    if (frame.t === "approvals" || frame.t === "harness") projection(id);
    inbox(id).receive(frame);
    catalogs.get(id)?.receive(frame);
    frecencies.get(id)?.receive(frame);
    if (frame.t === "welcome") bindVisibleCatalog();
    if (frame.t === "welcome" && visible?.project.sidecarId === id) {
      sendScope(id, {
        directory: visible.project.directory,
        sessions: visible.sessions,
      });
    }
    for (const observer of observers) observer.frame?.(id, frame, accepted);
  };
  const sidecars = o.sidecars(receive);
  const stopLinks = sidecars.subscribe(() => {
    for (const id of projections.keys()) projection(id);
  });
  return {
    ownsFailure: (cause) =>
      sidecars.state.list.some((server) =>
        sidecars.connection(server.id).rpc.ownsFailure(cause)
      ),
    sidecars,
    scope(project, sessions = []) {
      if (
        visible?.project.sidecarId === project?.sidecarId &&
        visible?.project.directory === project?.directory &&
        JSON.stringify(visible?.sessions) === JSON.stringify(sessions)
      ) return;
      if (visible && visible.project.sidecarId !== project?.sidecarId) {
        sendScope(visible.project.sidecarId, { sessions: [] });
      }
      visible = project && { project, sessions: [...new Set(sessions)] };
      bindVisibleCatalog();
      if (visible) {
        sendScope(visible.project.sidecarId, {
          directory: visible.project.directory,
          sessions: visible.sessions,
        });
      }
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
      sidecars.state.list.flatMap((s) =>
        operationAttention(s.id).entries(
          attention(s.id).entries(o.index.catalog(s.id)),
        )
      ),
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
    projects: (now, ageing) =>
      sidecars.state.list.flatMap((s) =>
        operationAttention(s.id).projects(inboxProjects(
          attention(s.id).entries(o.index.catalog(s.id)),
          inbox(s.id).state.inbox,
          now,
          ageing,
        ))
          .map((p) => ({ ...p, sidecarId: s.id, label: s.label }))
      ).sort((a, b) => {
        const rank = { tracked: 0, index: 1, template: 2 };
        if (a.source === "tracked" && b.source === "tracked") return 0;
        return rank[a.source ?? "tracked"] - rank[b.source ?? "tracked"] ||
          a.order - b.order ||
          projectName(a.directory).localeCompare(projectName(b.directory)) ||
          a.directory.localeCompare(b.directory) ||
          a.label.localeCompare(b.label);
      }),
    tabSnapshot(p) {
      const input = tabInput(p);
      void input.entries;
      void input.taskActivity;
      void input.inbox;
      return input;
    },
    syncTabs(p, input, selected) {
      const model = tabs(p);
      model.update(input);
      const id = selected?.sessionID;
      if (
        id &&
        input.entries.some((e) => e.id === id && e.directory === p.directory) &&
        (model.state.sessionID !== id || !model.state.selected)
      ) model.preview(id);
    },
    historySources: () =>
      sidecars.state.list.filter((s) => advertised(s.id, "history"))
        .map((s) => ({ id: s.id, connection: sidecars.connection(s.id) })),
    observe(observer) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    add: (url, label) => sidecars.add(url, label),
    remove(id) {
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
      stopLinks();
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
}
