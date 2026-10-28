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
import type { ApprovalAttention } from "./approval-attention.ts";
import type { SidecarConnection } from "./connection.ts";
import type { ClientIndex, MergedEntry } from "./index.ts";
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

export interface FrameObserver {
  frame?(id: string, frame: ServerFrame, accepted: boolean): void;
  removed?(id: string): void;
}
export interface ServerResources {
  scope(project?: ProjectSelection, sessions?: string[]): void;
  sidecars: ClientSidecars;
  inbox(id: string): InboxModel;
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
  entries(): MergedEntry[];
  /** Unprojected metadata borrowed from the shared keyed-index owner. */
  indexEntries(sidecar: string): readonly IndexEntry[];
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
  const approvalModels = new Map<string, ApprovalModel>();
  const tabModels = new Map<string, ClientTabs>();
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
  const attention = (id: string): ApprovalAttention =>
    approvals(id).attention(linked(id));
  const entries = (): MergedEntry[] =>
    sidecars.state.list.flatMap((s) =>
      attention(s.id).entries(o.index.partition(s.id))
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
    entries: attention(p.sidecarId).entries(
      o.index.partition(p.sidecarId, p.directory),
    ),
    inbox: inbox(p.sidecarId).state.inbox,
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
    }
    inbox(id).receive(frame);
    if (frame.t === "welcome" && visible?.project.sidecarId === id) {
      sendScope(id, {
        directory: visible.project.directory,
        sessions: visible.sessions,
      });
    }
    for (const observer of observers) observer.frame?.(id, frame, accepted);
  };
  const sidecars = o.sidecars(receive);
  return {
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
      if (visible) {
        sendScope(visible.project.sidecarId, {
          directory: visible.project.directory,
          sessions: visible.sessions,
        });
      }
    },
    inbox,
    approvals,
    tabs,
    entry,
    server,
    connected,
    linked,
    declares,
    advertised,
    attention,
    entries,
    indexEntries: (id) => o.index.partition(id),
    receive,
    taskActions: (p) =>
      createTaskActions(sidecars.connection(p.sidecarId).rpc, p.directory),
    anyAdvertised: (capability) =>
      sidecars.state.list.some((s) => advertised(s.id, capability)),
    connectionKey: (id) => server(id)?.connectionVersion,
    projectEntries: (p) =>
      attention(p.sidecarId).entries(
        o.index.partition(p.sidecarId, p.directory),
      ),
    projects: (now, ageing) =>
      sidecars.state.list.flatMap((s) =>
        inboxProjects(
          attention(s.id).entries(o.index.partition(s.id)),
          inbox(s.id).state.inbox,
          now,
          ageing,
        )
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
      const input = tabInput(p), metadata = input.inbox;
      return {
        directory: input.directory,
        entries: input.entries.map((e) => ({
          ...e,
          attention: { ...e.attention },
        })),
        inbox: {
          ...metadata,
          tasks: metadata.tasks.map((t) => ({
            ...t,
            sessions: [...t.sessions],
          })),
          seen: { ...metadata.seen },
          finishes: { ...metadata.finishes },
        },
      };
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
      o.index.remove(id);
      for (const observer of observers) observer.removed?.(id);
      inboxes.delete(id);
      approvalModels.get(id)?.stop();
      approvalModels.delete(id);
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
      for (const model of approvalModels.values()) model.stop();
      for (const model of tabModels.values()) model.stop();
      approvalModels.clear();
      tabModels.clear();
      inboxes.clear();
      observers.clear();
      sidecars.stop();
    },
  };
}
