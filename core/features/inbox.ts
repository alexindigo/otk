// SPDX-License-Identifier: LGPL-3.0-only
import {
  errorMessage,
  type InboxSnapshot,
  type IndexEntry,
  isSessionID,
  type ServerFrame,
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
/** Application-owned metadata only; the index remains the sole session owner. */
export class InboxFeature implements FrameSource {
  #listeners = new Set<(frame: ServerFrame) => void>();
  #stops: (() => void)[] = [];
  #scheduled = false;
  #closed = false;
  #discovered: string[] = [];
  #discoveryError = "";
  #scanVersion = 0;
  #policies: ReturnType<Projects["policies"]> = [];
  #seen = new Map<string, Map<string, number>>();
  #finishes: Record<string, number> = {};
  #user = "";
  constructor(
    readonly stores: InboxStores,
    readonly index: IndexStore,
    readonly identity: string | (() => string),
    readonly scan: (templates: readonly string[]) => Promise<string[]> =
      scanProjects,
    readonly promote?: (sessionID: string) => void,
  ) {
    this.#identity();
    this.#policies = stores.projects.policies();
    this.#finishes = stores.finishes.list();
    for (const { user, session, time } of stores.seen.all()) {
      const marks = this.#seen.get(user) ?? new Map<string, number>();
      marks.set(session, time);
      this.#seen.set(user, marks);
    }
    this.#stops.push(
      index.observe((entry, previous) => this.#observe(entry, previous)),
      stores.projects.listen((change) => {
        for (const project of change.upsert) {
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
        }
      }),
      stores.finishes.listen(({ session, time }) => {
        this.#finishes[session] = time;
      }),
      stores.seen.listen(({ user, session, time }) => {
        const marks = this.#seen.get(user) ?? new Map<string, number>();
        marks.set(session, time);
        this.#seen.set(user, marks);
      }),
    );
    for (const store of Object.values(stores)) {
      this.#stops.push(store.listen(() => this.#emit()));
    }
    this.#stops.push(stores.templates.listen(() => void this.#scan()));
    void this.#scan();
  }
  get user(): string {
    return typeof this.identity === "string" ? this.identity : this.identity();
  }
  #identity(): void {
    const user = this.user;
    if (user === this.#user) return;
    this.stores.projects.materialize(user);
    this.#user = user;
  }
  get(): InboxSnapshot {
    this.#identity();
    const s = this.stores;
    const projects = s.projects.list(this.user);
    this.#policies = s.projects.policies();
    return {
      projects,
      tasks: s.tasks.list(),
      seen: s.seen.list(this.user),
      finishes: s.finishes.list(),
      pathTemplates: s.templates.list(),
      discovered: [...this.#discovered],
      ...(this.#discoveryError ? { discoveryError: this.#discoveryError } : {}),
    };
  }
  snapshot(): Extract<ServerFrame, { t: "inbox" }> {
    return { t: "inbox", inbox: this.get() };
  }
  listen(listener: (frame: ServerFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  close(): void {
    this.#closed = true;
    for (const stop of this.#stops.splice(0)) stop();
    this.#listeners.clear();
  }
  #emit(): void {
    if (this.#scheduled || !this.#listeners.size || this.#closed) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#closed) return;
      const frame = this.snapshot();
      for (const listener of this.#listeners) listener(frame);
    });
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
        (this.#finishes[entry.id] ?? 0) > (marks.get(entry.id) ?? 0)
      ) ||
      (this.#finishes[entry.id] ?? 0) >
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
          (this.#finishes[entry.id] ?? 0) >
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
      const paths = await this.scan(this.stores.templates.list());
      if (this.#closed || version !== this.#scanVersion) return;
      this.#discovered = paths;
    } catch (error) {
      if (this.#closed || version !== this.#scanVersion) return;
      this.#discoveryError = errorMessage(error);
    }
    this.#emit();
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
      handler: () => this.get(),
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
      handler: (_ctx, directory) => s.tasks.list(directory),
    });
    rpc.register("tasks.create", {
      execution: localExecution(
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
      execution: localExecution(
        (p: { sessionID: string; id: string }) => ({
          sessionID: p.sessionID,
          resource: p.id,
        }),
        taskReceipt,
      ),
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
      execution: localExecution(
        (p: { sessionID: string; id: string }) => ({
          sessionID: p.sessionID,
          resource: p.id,
        }),
        taskReceipt,
      ),
      params: member,
      handler: (ctx, p) =>
        localWrite(
          ctx,
          (tx) => s.tasks.removeSession(p.id, p.sessionID, tx),
          taskReceipt,
        ),
    });
    rpc.register("tasks.sessions", {
      execution: localExecution(
        (p: { id: string }) => ({ resource: p.id }),
        taskReceipt,
      ),
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
      execution: localExecution(
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
      handler: () => s.finishes.list(),
    });
  }
}
