// SPDX-License-Identifier: LGPL-3.0-only
import {
  errorMessage,
  type InboxBaseline,
  type InboxOp,
  type InboxSnapshot,
  type IndexEntry,
  isSessionID,
  type ProjectRecord,
  type ProjectSummary,
  type ServerFrame,
  type TaskRecord,
  type ViewLease,
} from "@otk/protocol";
import { HarnessError } from "@otk/harness";
import type {
  Finishes,
  Projects,
  ProjectTemplates,
  Seen,
  StoreWrite,
  Tasks,
} from "@otk/store";
import type { IndexStore } from "../index/store.ts";
import { ProjectSummaries } from "../index/project-summaries.ts";
import type { FrameSource } from "../ws/connections.ts";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import { pathTemplate, projectPath, scanProjects } from "./project-scan.ts";
import {
  localExecution,
  localResultExecution,
  localWrite,
  nativeEffect,
  nativeExecution,
  preparedLocalExecution,
  readExecution,
} from "../requests/policies.ts";
import {
  closedReceipt,
  projectReceipt,
  projectSessionReceipt,
  seenReceipt,
  taskReceipt,
  tasksReceipt,
  templatesReceipt,
  visitReceipt,
} from "./inbox-receipts.ts";
import { createdReceipt } from "./session-receipts.ts";
import type { ContentSession } from "@otk/protocol";
import type { RpcContext } from "../ws/registry.ts";
export interface InboxStores {
  projects: Projects;
  tasks: Tasks;
  seen: Seen;
  finishes: Finishes;
  templates: ProjectTemplates;
}
interface InboxMaps {
  summaries: Map<string, ProjectSummary>;
  projects: Map<string, ProjectRecord>;
  tasks: Map<string, TaskRecord>;
  seen: Map<string, number>;
  finishes: Map<string, number>;
}
interface InboxAssembly {
  dirty: Map<string, { kind: keyof InboxMaps; id: string }>;
  overflow: boolean;
}
interface InboxPublication {
  value: InboxOp;
  directory?: string;
  sessionID?: string;
}
/** Application-owned metadata only; the index remains the sole session owner. */
export class InboxFeature implements FrameSource {
  #taskProjects = new Map<string, readonly TaskRecord[]>();
  #projectTasks(directory: string): readonly TaskRecord[] {
    let value = this.#taskProjects.get(directory);
    if (!value) {
      value = [...this.#tasks.values()].filter((task) =>
        task.directory === directory
      );
      this.#taskProjects.set(directory, value);
    }
    return value;
  }
  #views = new Map<string, () => InboxBaseline>();
  retained(): readonly string[] {
    return [...this.#finishes].filter(([id, finish]) =>
      finish > (this.#seen.get(this.user)?.get(id) ?? 0)
    ).map(([id]) => id);
  }
  #directory(view: ViewLease): string | undefined {
    return view.directory ??
      (view.selected
        ? this.index.getMetadata(view.selected)?.directory
        : undefined);
  }
  keys(view: ViewLease): string[] {
    const directory = this.#directory(view);
    if (!directory) return [];
    const ids = new Set<string>();
    for (const task of this.#projectTasks(directory)) {
      for (const id of task.sessions) ids.add(id);
    }
    for (const entry of this.index.catalog(directory)) {
      if (entry.deleted) continue;
      const a = entry.attention;
      if (
        entry.status !== "idle" || a.error ||
        a.permissions + a.questions + a.childPermissions + a.childQuestions >
          0 ||
        !entry.parentID && (this.#finishes.get(entry.id) ?? 0) >
            (this.#seen.get(this.user)?.get(entry.id) ?? 0)
      ) ids.add(entry.id);
    }
    return [...ids];
  }
  open(
    view: () => ViewLease,
    id: string,
    entries: () => ReadonlySet<string>,
  ): FrameSource {
    const listeners = new Set<(frame: ServerFrame) => void>();
    let revision = 0;
    const emit = (frame: ServerFrame) => {
      for (const listener of listeners) listener(frame);
    };
    const baseline = (): InboxBaseline => {
      this.#flush();
      return {
        generation: this.#generation,
        revision,
        epoch: view().epoch,
        summaryRevision: this.#summaryRevision,
        inbox: this.get(view(), entries()),
      };
    };
    this.#views.set(id, baseline);
    const stop = this.listen((frame) => {
      if (frame.t !== "inbox.patch") emit(frame);
    });
    const publish = (changes: readonly InboxPublication[]) => {
      const scope = view(),
        directory = this.#directory(scope),
        leased = entries();
      const ops = changes.filter((change) =>
        change.directory !== undefined
          ? change.directory === directory
          : change.sessionID !== undefined
          ? leased.has(change.sessionID)
          : true
      ).map((change) => change.value);
      if (!ops.length) return;
      const from = revision;
      revision += ops.length;
      emit({
        t: "inbox.patch",
        generation: this.#generation,
        from,
        revision,
        ops,
      });
    };
    this.#publications.add(publish);
    let rowsScheduled = false;
    const rowsChanged = () => {
      if (rowsScheduled) return;
      rowsScheduled = true;
      const directory = this.#directory(view());
      queueMicrotask(() => {
        rowsScheduled = false;
        if (
          directory && this.#views.has(id) &&
          directory === this.#directory(view())
        ) {
          emit({ t: "sessions.changed", directory });
        }
      });
    };
    const stopRows = this.index.observe((entry, previous, delta) => {
      if (
        delta ||
        entry.directory !== this.#directory(view()) &&
          previous?.directory !== this.#directory(view())
      ) return;
      if (
        !previous || entry.title !== previous.title ||
        entry.parentID !== previous.parentID ||
        entry.directory !== previous.directory ||
        entry.timeUpdated !== previous.timeUpdated ||
        JSON.stringify(entry.deleted) !== JSON.stringify(previous.deleted)
      ) rowsChanged();
    });
    const stopRemoval = this.index.observeRemoval(rowsChanged);
    const hydrate = async (signal?: AbortSignal) => {
      const scope = view();
      const keys = [
        ...new Set([
          ...this.keys(scope),
          ...scope.crumbs,
          ...scope.rows,
          ...(scope.selected ? [scope.selected] : []),
        ]),
      ];
      if (keys.length) await this.hydrate?.(keys, signal);
    };
    return {
      snapshot: async (signal) => {
        await hydrate(signal);
        const value = baseline();
        return { t: "inbox.snapshot", ...value };
      },
      listen: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close: () => {
        stop();
        this.#publications.delete(publish);
        stopRows();
        stopRemoval();
        listeners.clear();
        this.#views.delete(id);
      },
    };
  }
  #listeners = new Set<(frame: ServerFrame) => void>();
  #publications = new Set<(changes: readonly InboxPublication[]) => void>();
  #stops: (() => void)[] = [];
  #scheduled = false;
  #generation = crypto.randomUUID();
  #revision = 0;
  #pending = new Map<string, InboxPublication>();
  #summaryPending = new Map<string, ProjectSummary | null>();
  #summaryRevision = 0;
  #projects = new Map<string, ProjectRecord>();
  #tasks = new Map<string, TaskRecord>();
  #templates: string[] = [];
  #closed = false;
  #discovered: string[] = [];
  #discoveryError = "";
  #scanVersion = 0;
  #policies: ReturnType<Projects["policies"]> = [];
  #seen = new Map<string, Map<string, number>>();
  #finishes = new Map<string, number>();
  #assemblies = new Set<InboxAssembly>();
  #user = "";
  readonly summaries: ProjectSummaries;
  constructor(
    readonly stores: InboxStores,
    readonly index: IndexStore,
    readonly identity: string | (() => string),
    readonly scan: (templates: readonly string[]) => Promise<string[]> =
      scanProjects,
    readonly promote?: (sessionID: string) => void,
    readonly snapshotRows?: number,
    readonly snapshotPending?: number,
    readonly hydrate?: (
      ids: readonly string[],
      signal?: AbortSignal,
    ) => Promise<void>,
    readonly discoveryProject?: (directory: string, active: boolean) => void,
  ) {
    this.#identity();
    this.#tasks = new Map(stores.tasks.list().map((task) => [task.id, task]));
    this.#templates = stores.templates.list();
    this.#policies = stores.projects.policies();
    this.#finishes = new Map(Object.entries(stores.finishes.list()));
    for (const { user, session, time } of stores.seen.all()) {
      const marks = this.#seen.get(user) ?? new Map<string, number>();
      marks.set(session, time);
      this.#seen.set(user, marks);
    }
    this.summaries = new ProjectSummaries(
      (id) => ({
        seen: this.#seen.get(this.user)?.get(id) ?? 0,
        finish: this.#finishes.get(id) ?? 0,
      }),
      (summary) => {
        this.#discoveryProject(summary.directory, summary);
        this.#capture("summaries", summary.directory);
        this.#summaryPending.set(summary.directory, summary);
        this.#schedule();
      },
      (directory) => {
        this.#capture("summaries", directory);
        this.#summaryPending.set(directory, null);
        this.#schedule();
      },
    );
    for (const project of this.#projects.values()) {
      this.summaries.ensure(project.directory);
    }
    for (const entry of index.snapshotEntries()) {
      const { digest: _digest, ...metadata } = entry;
      this.summaries.entry(metadata);
    }
    this.#stops.push(
      index.observe((entry, previous, delta) => {
        if (
          delta &&
          JSON.stringify(entry.deleted) === JSON.stringify(previous?.deleted)
        ) return;
        this.#observe(entry, previous);
        const { digest: _digest, ...metadata } = entry;
        this.summaries.entry(metadata);
        if (previous && entry.parentID !== previous.parentID) {
          this.summaries.refresh();
        }
      }),
      index.observeRemoval((id) => this.summaries.remove(id)),
      index.observeAuthority((value) => this.summaries.authority(value)),
      index.observeSeeds((values) => this.summaries.seed(values)),
      stores.projects.listen((change) => {
        this.#identity();
        for (const project of change.upsert) {
          this.summaries.ensure(project.directory);
          const known = this.#policies.find((policy) =>
            policy.user === change.user &&
            policy.directory === project.directory
          );
          if (known) known.inactive = project.inactive;
          else {this.#policies.push({
              user: change.user,
              directory: project.directory,
              inactive: project.inactive,
            });}
          if (change.user === this.#user) {
            this.#projects.set(project.directory, project);
            this.#discoveryProject(project.directory);
            this.#capture("projects", project.directory);
            this.#queue(`project:${project.directory}`, {
              op: "project.upsert",
              project,
            });
          }
        }
        for (const directory of change.remove) {
          this.#policies = this.#policies.filter((p) =>
            p.user !== change.user || p.directory !== directory
          );
          if (change.user === this.#user) {
            this.#projects.delete(directory);
            this.#discoveryProject(directory);
            this.#capture("projects", directory);
            this.#queue(`project:${directory}`, {
              op: "project.remove",
              directory,
            });
          }
        }
        this.#summaryDirectories();
      }),
      stores.finishes.listen(({ session, time }) => {
        this.#finishes.set(session, time);
        this.summaries.mark(session);
        this.#capture("finishes", session);
        this.#queue(`finish:${session}`, {
          op: "finish",
          sessionID: session,
          time,
        }, { sessionID: session });
      }),
      stores.seen.listen(({ user, session, time }) => {
        this.#identity();
        const marks = this.#seen.get(user) ?? new Map<string, number>();
        marks.set(session, time);
        this.#seen.set(user, marks);
        if (user === this.user) {
          this.summaries.mark(session);
          this.#capture("seen", session);
          this.#queue(`seen:${session}`, {
            op: "seen",
            sessionID: session,
            time,
          }, { sessionID: session });
        }
      }),
      stores.tasks.listen((change) => {
        for (const task of change.upsert) {
          this.#taskProjects.delete(task.directory);
          this.#tasks.set(task.id, task);
          this.#capture("tasks", task.id);
          this.#queue(`task:${task.id}`, { op: "task.upsert", task }, {
            directory: task.directory,
          });
        }
        for (const id of change.remove) {
          const task = this.#tasks.get(id);
          if (task) this.#taskProjects.delete(task.directory);
          this.#tasks.delete(id);
          this.#capture("tasks", id);
          this.#queue(`task:${id}`, { op: "task.remove", id }, {
            directory: task?.directory ?? "",
          });
        }
      }),
      stores.templates.listen(({ templates }) => {
        this.#templates = templates;
        this.#queue("templates", { op: "templates", values: templates });
        void this.#scan();
      }),
    );
    void this.#scan();
  }
  #discoveryProject(
    directory: string,
    summary = this.summaries?.values.get(directory),
  ): void {
    const active = !!(summary?.hasSessions || summary?.locationForms) &&
      (!this.#projects.get(directory)?.inactive ||
        summary.status === "working" || summary.status === "blocked" ||
        (summary.unseenCount ?? 0) > 0);
    this.discoveryProject?.(directory, active);
  }
  get user(): string {
    return typeof this.identity === "string" ? this.identity : this.identity();
  }
  approvalAttention(
    permissions: (id: string) => number,
    listen: (changed: () => void) => () => void,
  ): void {
    this.summaries.permissions(permissions);
    this.#stops.push(listen(() => this.summaries.refresh()));
  }
  locationAttention(
    values: () => Readonly<Record<string, number>>,
    listen: (changed: () => void) => () => void,
  ): void {
    this.summaries.locationForms(values());
    this.#stops.push(listen(() => this.summaries.locationForms(values())));
  }
  #summaryDirectories(): void {
    this.summaries.retain([...this.#projects.keys(), ...this.#discovered]);
  }
  #identity(): void {
    const user = this.user;
    if (user === this.#user) return;
    this.stores.projects.materialize(user);
    this.#user = user;
    this.#projects = new Map(
      this.stores.projects.list(user).map((
        project,
      ) => [project.directory, project]),
    );
    this.#generation = crypto.randomUUID();
    this.#revision = 0;
    this.#pending.clear();
    this.#summaryPending.clear();
    this.#summaryRevision = 0;
    this.summaries?.refresh();
  }
  get(view?: ViewLease, leased?: ReadonlySet<string>): InboxSnapshot {
    this.#identity();
    const directory = view && this.#directory(view);
    if (view && !leased) leased = new Set();
    return {
      projects: [...this.#projects.values()].sort((a, b) =>
        a.order - b.order || a.directory.localeCompare(b.directory)
      ).map((p) => ({ ...p })),
      tasks: [
        ...(view
          ? directory ? this.#projectTasks(directory) : []
          : this.#tasks.values()),
      ].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map((
        t,
      ) => ({ ...t, sessions: [...t.sessions] })),
      seen: Object.fromEntries(
        leased
          ? [...leased].flatMap((id) => {
            const time = this.#seen.get(this.user)?.get(id);
            return time === undefined ? [] : [[id, time]];
          })
          : this.#seen.get(this.user) ?? [],
      ),
      finishes: Object.fromEntries(
        leased
          ? [...leased].flatMap((id) => {
            const time = this.#finishes.get(id);
            return time === undefined ? [] : [[id, time]];
          })
          : this.#finishes,
      ),
      pathTemplates: [...this.#templates],
      discovered: [...this.#discovered],
      summaries: Object.fromEntries(this.summaries.values),
      ...(this.#discoveryError ? { discoveryError: this.#discoveryError } : {}),
    };
  }
  async baseline(signal?: AbortSignal): Promise<InboxBaseline> {
    // Copy in bounded turns and replay only keys changed during that copy.
    // Ongoing mark traffic does not require a quiet serving isolate. Only a
    // generation replacement or bounded-capture overflow restarts assembly.
    for (;;) {
      signal?.throwIfAborted();
      if (this.#closed) throw new DOMException("Inbox closed", "AbortError");
      this.#identity();
      this.#flush();
      const generation = this.#generation;
      const assembly: InboxAssembly = { dirty: new Map(), overflow: false };
      this.#assemblies.add(assembly);
      const maps: InboxMaps = {
        summaries: new Map(),
        projects: new Map(),
        tasks: new Map(),
        seen: new Map(),
        finishes: new Map(),
      };
      try {
        let copied = 0;
        const copy = async <T>(
          source: Map<string, T>,
          target: Map<string, T>,
        ) => {
          for (const [id, value] of source) {
            if (assembly.overflow) return;
            target.set(id, structuredClone(value));
            if (this.snapshotRows && ++copied % this.snapshotRows === 0) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              signal?.throwIfAborted();
              if (this.#closed) {
                throw new DOMException("Inbox closed", "AbortError");
              }
            }
          }
        };
        const source = this.#maps();
        await copy(source.projects, maps.projects);
        await copy(source.tasks, maps.tasks);
        await copy(source.seen, maps.seen);
        await copy(source.finishes, maps.finishes);
        await copy(source.summaries, maps.summaries);
        this.#flush();
        if (assembly.overflow || generation !== this.#generation) continue;
        const current = this.#maps();
        for (const { kind, id } of assembly.dirty.values()) {
          const target = maps[kind] as Map<
            string,
            ProjectRecord | TaskRecord | ProjectSummary | number
          >;
          const value = current[kind].get(id);
          if (value === undefined) target.delete(id);
          else target.set(id, structuredClone(value));
        }
        const inbox: InboxSnapshot = {
          projects: [...maps.projects.values()].sort((a, b) =>
            a.order - b.order || a.directory.localeCompare(b.directory)
          ),
          tasks: [...maps.tasks.values()].sort((a, b) =>
            a.order - b.order || a.id.localeCompare(b.id)
          ),
          seen: Object.fromEntries(maps.seen),
          finishes: Object.fromEntries(maps.finishes),
          pathTemplates: [...this.#templates],
          discovered: [...this.#discovered],
          summaries: Object.fromEntries(maps.summaries),
          ...(this.#discoveryError
            ? { discoveryError: this.#discoveryError }
            : {}),
        };
        return {
          generation,
          revision: this.#revision,
          summaryRevision: this.#summaryRevision,
          inbox,
        };
      } finally {
        this.#assemblies.delete(assembly);
      }
    }
  }
  #maps(): InboxMaps {
    return {
      summaries: this.summaries.values,
      projects: this.#projects,
      tasks: this.#tasks,
      seen: this.#seen.get(this.#user) ?? new Map(),
      finishes: this.#finishes,
    };
  }
  #capture(kind: keyof InboxMaps, id: string): void {
    const key = JSON.stringify([kind, id]);
    for (const assembly of this.#assemblies) {
      if (assembly.overflow || assembly.dirty.has(key)) continue;
      const limit = this.snapshotPending ?? this.snapshotRows;
      if (limit !== undefined && assembly.dirty.size >= limit) {
        assembly.overflow = true;
        assembly.dirty.clear();
      } else assembly.dirty.set(key, { kind, id });
    }
  }
  async snapshot(
    signal?: AbortSignal,
  ): Promise<Extract<ServerFrame, { t: "inbox.snapshot" }>> {
    return { t: "inbox.snapshot", ...await this.baseline(signal) };
  }
  listen(listener: (frame: ServerFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  close(): void {
    this.#closed = true;
    for (const stop of this.#stops.splice(0)) stop();
    this.#listeners.clear();
    this.#publications.clear();
  }
  #queue(
    key: string,
    op: InboxOp,
    scope: Omit<InboxPublication, "value"> = {},
  ): void {
    this.#pending.set(key, { value: op, ...scope });
    this.#schedule();
  }
  #schedule(): void {
    if (this.#scheduled || this.#closed) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#closed) return;
      this.#flush();
    });
  }
  #flush(): void {
    if (this.#summaryPending.size && !this.#closed) {
      const summaries: ProjectSummary[] = [], remove: string[] = [];
      for (const [directory, summary] of this.#summaryPending) {
        if (summary) summaries.push(summary);
        else remove.push(directory);
      }
      this.#summaryPending.clear();
      const from = this.#summaryRevision;
      this.#summaryRevision += summaries.length + remove.length;
      const frame: ServerFrame = {
        t: "inbox.summaries",
        generation: this.#generation,
        from,
        revision: this.#summaryRevision,
        summaries,
        ...(remove.length ? { remove } : {}),
      };
      for (const listener of this.#listeners) listener(structuredClone(frame));
    }
    if (!this.#pending.size || this.#closed) return;
    const changes = [...this.#pending.values()],
      ops = changes.map((change) => change.value);
    this.#pending.clear();
    const from = this.#revision;
    this.#revision += ops.length;
    const frame: ServerFrame = {
      t: "inbox.patch",
      generation: this.#generation,
      from,
      revision: this.#revision,
      ops,
    };
    for (const listener of this.#listeners) listener(structuredClone(frame));
    for (const listener of this.#publications) listener(changes);
  }
  #observe(entry: IndexEntry, previous?: IndexEntry, tx?: StoreWrite): void {
    const s = this.stores;
    if (
      previous?.status !== undefined && previous.status !== "idle" &&
      entry.status === "idle" && !entry.deleted && !previous.deleted
    ) s.finishes.record(entry.id);
    const a = entry.attention;
    const active = entry.status !== "idle" || !!a.error ||
      a.permissions + a.questions + a.childPermissions + a.childQuestions > 0;
    const unseen =
      [...this.#seen.values()].some((marks) =>
        (this.#finishes.get(entry.id) ?? 0) > (marks.get(entry.id) ?? 0)
      ) ||
      (this.#finishes.get(entry.id) ?? 0) >
        (this.#seen.get(this.user)?.get(entry.id) ?? 0);
    if (
      !entry.deleted && (active || unseen) &&
      (!previous || previous.status !== entry.status ||
        JSON.stringify(previous.attention) !== JSON.stringify(entry.attention))
    ) {
      const promote = () => this.promote?.(entry.id);
      if (tx) s.projects.db.afterCommit(tx, promote);
      else promote();
    }
    // Joined writes have not published their policy changes yet. Revalidate
    // against that transaction's current rows, using the same activity owner.
    for (const project of tx ? s.projects.policies() : this.#policies) {
      if (
        project.directory === entry.directory && project.inactive &&
        (active ||
          (this.#finishes.get(entry.id) ?? 0) >
            (this.#seen.get(project.user)?.get(entry.id) ?? 0))
      ) {
        s.projects.reactivate(project.user, entry.directory, tx);
      }
    }
  }
  /** Creation and successful action bookkeeping share the persisted project owner. */
  activate(directory: string, tx?: StoreWrite): void {
    const project = this.stores.projects.find(this.user, directory);
    if (!project) this.stores.projects.add(this.user, directory, tx);
    else if (project.inactive) {
      this.stores.projects.inactive(this.user, directory, false, tx);
    }
  }
  async #scan(): Promise<void> {
    const version = ++this.#scanVersion;
    // Retired template results must not survive a new configuration.
    this.#discovered = [];
    this.#discoveryError = "";
    try {
      const paths = await this.scan(this.#templates);
      if (this.#closed || version !== this.#scanVersion) return;
      this.#discovered = paths;
      this.#summaryDirectories();
    } catch (error) {
      if (this.#closed || version !== this.#scanVersion) return;
      this.#discoveryError = errorMessage(error);
    }
    this.#queue("discovery", {
      op: "discovery",
      directories: [...this.#discovered],
      ...(this.#discoveryError
        ? {
          failure: {
            code: "discovery.unavailable",
            retry: "new-intent" as const,
            diagnosticID: crypto.randomUUID(),
          },
        }
        : {}),
    });
  }
  register(rpc: RpcRegistry): void {
    const s = this.stores, user = () => this.user;
    const added = (ctx: RpcContext, session: ContentSession) => {
      const run = (tx: StoreWrite) => {
        this.activate(session.directory, tx);
        return {
          ...s.projects.get(user(), session.directory),
          sessionID: session.id,
        };
      };
      return ctx.execution
        ? ctx.execution.local(run, projectSessionReceipt.encode)
        : ctx.store.write(run);
    };
    const strings = (p: Record<string, unknown>, name: string): string[] => {
      const values = p[name];
      if (
        !Array.isArray(values) ||
        values.some((v) => typeof v !== "string" || !v.length) ||
        new Set(values).size !== values.length
      ) throw new HarnessError("params", `Expected unique ${name} strings`);
      return values as string[];
    };
    const sessions = (p: Record<string, unknown>) => {
      const values = strings(p, "sessions");
      if (!values.every(isSessionID)) {
        throw new HarnessError("params", "Expected qualified session IDs");
      }
      return values;
    };
    rpc.register("inbox.get", {
      execution: readExecution(() => ({ resource: "inbox" })),
      params: () => undefined,
      handler: (ctx) =>
        this.#views.get(ctx.request?.id ?? "")?.() ??
          this.baseline(ctx.execution?.signal),
    });
    rpc.register("projects.list", {
      execution: readExecution(() => ({ resource: "projects" })),
      params: () => undefined,
      handler: () => s.projects.list(user()),
    });
    rpc.register("projects.add", {
      execution: {
        ...nativeExecution(
          (directory: string) => ({ directory }),
          projectSessionReceipt,
        ),
        checkpoint: (receipt) =>
          receipt.kind === createdReceipt.kind
            ? createdReceipt.validate(receipt)
            : projectSessionReceipt.validate(receipt),
        recover: (ctx, record, execution) => {
          if (record.receipt_kind === projectSessionReceipt.kind) {
            return Promise.resolve({
              state: "complete",
              result: projectSessionReceipt.restore(record),
            });
          }
          if (record.receipt_kind === createdReceipt.kind) {
            return Promise.resolve({
              state: "complete",
              result: added(
                { ...ctx, execution },
                createdReceipt.restore(record),
              ),
            });
          }
          return Promise.resolve({
            state: "pending",
            progress: { phase: "reconciling", code: "checking-outcome" },
          });
        },
      },
      params: (p) => projectPath(text(p, "directory")!),
      handler: async (ctx, directory) => {
        if (!(await Deno.stat(directory)).isDirectory) {
          throw new HarnessError("params", "Expected a project directory");
        }
        // The existing Add project entry creates its initial session; empty
        // directory-only tracking is no longer a product operation.
        const session = await nativeEffect(
          ctx,
          (operation) =>
            ctx.harness.core.createSession({ directory }, operation),
          createdReceipt,
        );
        return added(ctx, session);
      },
    });
    rpc.register("projects.inactive", {
      execution: localExecution(
        (p: { directory: string }) => ({ directory: p.directory }),
        projectReceipt,
      ),
      params(p) {
        if (typeof p.inactive !== "boolean") {
          throw new HarnessError("params", "Expected inactive boolean");
        }
        return {
          directory: projectPath(text(p, "directory")!),
          inactive: p.inactive,
        };
      },
      handler: (ctx, p) =>
        localWrite(ctx, (tx) => {
          if (!s.projects.find(user(), p.directory)) {
            s.projects.discover(p.directory, tx);
            s.projects.materialize(user(), tx);
          }
          s.projects.inactive(user(), p.directory, p.inactive, tx);
          for (const entry of this.index.values()) {
            if (entry.directory === p.directory) {
              this.#observe(entry, undefined, tx);
            }
          }
          return s.projects.get(user(), p.directory);
        }, projectReceipt),
    });
    rpc.register("projects.visit", {
      execution: localExecution(
        (p: { directory: string }) => ({ directory: p.directory }),
        visitReceipt,
      ),
      params(p) {
        if (p.active !== undefined && typeof p.active !== "boolean") {
          throw new HarnessError("params", "Expected active boolean");
        }
        return {
          directory: projectPath(text(p, "directory")!),
          active: p.active === true,
        };
      },
      handler: (ctx, p) =>
        localWrite(ctx, (tx) => {
          if (p.active) this.activate(p.directory, tx);
          return s.projects.find(user(), p.directory)
            ? s.projects.visit(user(), p.directory, tx)
            : null;
        }, visitReceipt),
    });
    rpc.register("projects.scan", {
      execution: readExecution(() => ({ resource: "project-discovery" })),
      params: () => undefined,
      handler: (ctx) => scanProjects(s.templates.list(), ctx.execution?.signal),
    });
    rpc.register("projects.templates", {
      execution: localExecution(
        () => ({ resource: "project-templates" }),
        templatesReceipt,
      ),
      params: (p) => strings(p, "templates").map(pathTemplate),
      handler: (ctx, templates) =>
        localWrite(
          ctx,
          (tx) => s.templates.set(templates, tx),
          templatesReceipt,
        ),
    });
    rpc.register("tasks.list", {
      execution: readExecution((directory: string | undefined) => ({
        directory,
      })),
      params: (p) =>
        p.directory === undefined
          ? undefined
          : projectPath(text(p, "directory")!),
      handler: (ctx, directory) => {
        const selected = ctx.request?.view?.();
        const project = directory ?? (selected && this.#directory(selected));
        return ctx.request && !project ? [] : s.tasks.list(project);
      },
    });
    rpc.register("tasks.create", {
      execution: preparedLocalExecution(
        (p: { directory: string }) => ({ directory: p.directory }),
        taskReceipt,
      ),
      params: (p) => ({
        directory: projectPath(text(p, "directory")!),
        name: text(p, "name")!,
        sessions: p.sessions === undefined ? [] : sessions(p),
      }),
      async handler(ctx, p) {
        const directories = await ctx.sessionDirectories(p.sessions);
        for (const id of p.sessions) {
          if (directories[id] !== p.directory) {
            throw new HarnessError(
              "params",
              "Session belongs to another project",
            );
          }
        }
        return localWrite(
          ctx,
          (tx) => s.tasks.create(p.directory, p.name, p.sessions, tx),
          taskReceipt,
        );
      },
    });
    rpc.register("tasks.rename", {
      execution: localExecution(
        (p: { id: string }) => ({ resource: p.id }),
        taskReceipt,
      ),
      params: (p) => ({ id: text(p, "id")!, name: text(p, "name")! }),
      handler: (ctx, p) =>
        localWrite(ctx, (tx) => s.tasks.rename(p.id, p.name, tx), taskReceipt),
    });
    rpc.register("tasks.reorder", {
      execution: localExecution(
        (p: { directory: string }) => ({ directory: p.directory }),
        tasksReceipt,
      ),
      params: (p) => ({
        directory: projectPath(text(p, "directory")!),
        ids: strings(p, "ids"),
      }),
      handler: (ctx, p) =>
        localWrite(
          ctx,
          (tx) => s.tasks.reorder(p.directory, p.ids, tx),
          tasksReceipt,
        ),
    });
    rpc.register("tasks.close", {
      execution: localResultExecution(
        (id: string) => ({ resource: id }),
        closedReceipt,
        () => null,
      ),
      params: (p) => text(p, "id")!,
      handler: (ctx, id) => {
        localWrite(ctx, (tx) => {
          s.tasks.close(id, tx);
          return { taskID: id, closed: true as const };
        }, closedReceipt);
        return null;
      },
    });
    const member = (p: Record<string, unknown>) => ({
      id: text(p, "id")!,
      sessionID: sessionID(p)!,
    });
    rpc.register("tasks.addSession", {
      execution: {
        ...preparedLocalExecution(
          (p: { sessionID: string; id: string }) => ({
            sessionID: p.sessionID,
            resource: p.id,
          }),
          taskReceipt,
        ),
        ordering: "target",
      },
      params: member,
      async handler(ctx, p) {
        const directory = s.tasks.get(p.id).directory;
        if (await ctx.sessionDirectory(p.sessionID) !== directory) {
          throw new HarnessError(
            "params",
            "Session belongs to another project",
          );
        }
        return localWrite(ctx, (tx) => {
          if (s.tasks.get(p.id).directory !== directory) {
            throw new HarnessError("params", "Task project changed");
          }
          return s.tasks.addSession(p.id, p.sessionID, tx);
        }, taskReceipt);
      },
    });
    rpc.register("tasks.removeSession", {
      execution: {
        ...localExecution(
          (p: { sessionID: string; id: string }) => ({
            sessionID: p.sessionID,
            resource: p.id,
          }),
          taskReceipt,
        ),
        ordering: "target",
      },
      params: member,
      handler: (ctx, p) =>
        localWrite(
          ctx,
          (tx) => s.tasks.removeSession(p.id, p.sessionID, tx),
          taskReceipt,
        ),
    });
    rpc.register("tasks.sessions", {
      execution: {
        ...preparedLocalExecution(
          (p: { id: string }) => ({ resource: p.id }),
          taskReceipt,
        ),
        ordering: "target",
      },
      params: (p) => ({ id: text(p, "id")!, sessions: sessions(p) }),
      async handler(ctx, p) {
        const directory = s.tasks.get(p.id).directory;
        const directories = await ctx.sessionDirectories(p.sessions);
        for (const id of p.sessions) {
          if (directories[id] !== directory) {
            throw new HarnessError(
              "params",
              "Session belongs to another project",
            );
          }
        }
        return localWrite(ctx, (tx) => {
          if (s.tasks.get(p.id).directory !== directory) {
            throw new HarnessError("params", "Task project changed");
          }
          return s.tasks.sessions(p.id, p.sessions, tx);
        }, taskReceipt);
      },
    });
    rpc.register("sessions.seen", {
      execution: preparedLocalExecution(
        (id: string) => ({ sessionID: id }),
        seenReceipt,
      ),
      params: (p) => sessionID(p)!,
      handler: async (ctx, id) => {
        if (!this.index.get(id)?.deleted) await ctx.sessionDirectory(id);
        return localWrite(
          ctx,
          (tx) => s.seen.mark(user(), id, tx),
          seenReceipt,
        );
      },
    });
    rpc.register("sessions.finishes", {
      execution: readExecution(() => ({ resource: "session-finishes" })),
      params: () => undefined,
      handler: (ctx) => {
        const ids = ctx.request?.entries?.();
        return ids
          ? Object.fromEntries(
            [...this.#finishes].filter(([id]) => ids.has(id)),
          )
          : s.finishes.list();
      },
    });
  }
}
