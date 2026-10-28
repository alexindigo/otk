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
  Tasks,
} from "@otk/store";
import type { IndexStore } from "../index/store.ts";
import type { FrameSource } from "../ws/connections.ts";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import { pathTemplate, projectPath, scanProjects } from "./project-scan.ts";
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
  constructor(
    readonly stores: InboxStores,
    readonly index: IndexStore,
    readonly identity: string | (() => string),
    readonly scan: (templates: readonly string[]) => Promise<string[]> =
      scanProjects,
    readonly promote?: (sessionID: string) => void,
  ) {
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
        if (!("user" in change)) return;
        const known = this.#policies.find((policy) =>
          policy.user === change.user &&
          policy.directory === change.project.directory
        );
        if (known) known.inactive = change.project.inactive;
        else {this.#policies.push({
            user: change.user,
            directory: change.project.directory,
            inactive: change.project.inactive,
          });}
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
  get(): InboxSnapshot {
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
  #observe(entry: IndexEntry, previous?: IndexEntry): void {
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
    ) this.promote?.(entry.id);
    for (const project of this.#policies) {
      if (
        project.directory === entry.directory && project.inactive &&
        (active ||
          (this.#finishes[entry.id] ?? 0) >
            (this.#seen.get(project.user)?.get(entry.id) ?? 0))
      ) {
        s.projects.reactivate(project.user, entry.directory);
      }
    }
  }
  /** Creation and successful action bookkeeping share the persisted project owner. */
  activate(directory: string): void {
    const project = this.stores.projects.find(this.user, directory);
    if (!project) this.stores.projects.add(this.user, directory);
    else if (project.inactive) {
      this.stores.projects.inactive(this.user, directory, false);
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
      params: () => undefined,
      handler: () => this.get(),
    });
    rpc.register("projects.list", {
      params: () => undefined,
      handler: () => s.projects.list(user()),
    });
    rpc.register("projects.add", {
      params: (p) => projectPath(text(p, "directory")!),
      handler: async (ctx, directory) => {
        if (!(await Deno.stat(directory)).isDirectory) {
          throw new HarnessError("params", "Expected a project directory");
        }
        // The existing Add project entry creates its initial session; empty
        // directory-only tracking is no longer a product operation.
        const session = await ctx.harness.core.createSession({ directory });
        this.activate(session.directory);
        return {
          ...s.projects.get(user(), session.directory),
          sessionID: session.id,
        };
      },
    });
    rpc.register("projects.inactive", {
      params(p) {
        if (typeof p.inactive !== "boolean") {
          throw new HarnessError("params", "Expected inactive boolean");
        }
        return {
          directory: projectPath(text(p, "directory")!),
          inactive: p.inactive,
        };
      },
      handler: (_ctx, p) => {
        const project = s.projects.inactive(user(), p.directory, p.inactive);
        for (const entry of this.index.values()) {
          if (entry.directory === p.directory) this.#observe(entry);
        }
        return s.projects.get(user(), project.directory);
      },
    });
    rpc.register("projects.visit", {
      params(p) {
        if (p.active !== undefined && typeof p.active !== "boolean") {
          throw new HarnessError("params", "Expected active boolean");
        }
        return {
          directory: projectPath(text(p, "directory")!),
          active: p.active === true,
        };
      },
      handler: (_ctx, p) => {
        if (p.active) this.activate(p.directory);
        return s.projects.find(user(), p.directory)
          ? s.projects.visit(user(), p.directory)
          : null;
      },
    });
    rpc.register("projects.scan", {
      params: () => undefined,
      handler: () => scanProjects(s.templates.list()),
    });
    rpc.register("projects.templates", {
      params: (p) => strings(p, "templates").map(pathTemplate),
      handler: (_ctx, templates) => s.templates.set(templates),
    });
    rpc.register("tasks.list", {
      params: (p) =>
        p.directory === undefined
          ? undefined
          : projectPath(text(p, "directory")!),
      handler: (_ctx, directory) => s.tasks.list(directory),
    });
    rpc.register("tasks.create", {
      params: (p) => ({
        directory: projectPath(text(p, "directory")!),
        name: text(p, "name")!,
        sessions: p.sessions === undefined ? [] : sessions(p),
      }),
      async handler(ctx, p) {
        for (const id of p.sessions) {
          if (await ctx.sessionDirectory(id) !== p.directory) {
            throw new HarnessError(
              "params",
              "Session belongs to another project",
            );
          }
        }
        return s.tasks.create(p.directory, p.name, p.sessions);
      },
    });
    rpc.register("tasks.rename", {
      params: (p) => ({ id: text(p, "id")!, name: text(p, "name")! }),
      handler: (_ctx, p) => s.tasks.rename(p.id, p.name),
    });
    rpc.register("tasks.reorder", {
      params: (p) => ({
        directory: projectPath(text(p, "directory")!),
        ids: strings(p, "ids"),
      }),
      handler: (_ctx, p) => s.tasks.reorder(p.directory, p.ids),
    });
    rpc.register("tasks.close", {
      params: (p) => text(p, "id")!,
      handler: (_ctx, id) => {
        s.tasks.close(id);
        return null;
      },
    });
    const member = (p: Record<string, unknown>) => ({
      id: text(p, "id")!,
      sessionID: sessionID(p)!,
    });
    rpc.register("tasks.addSession", {
      params: member,
      async handler(ctx, p) {
        const directory = s.tasks.get(p.id).directory;
        if (await ctx.sessionDirectory(p.sessionID) !== directory) {
          throw new HarnessError(
            "params",
            "Session belongs to another project",
          );
        }
        return s.tasks.addSession(p.id, p.sessionID);
      },
    });
    rpc.register("tasks.removeSession", {
      params: member,
      handler: (_ctx, p) => s.tasks.removeSession(p.id, p.sessionID),
    });
    rpc.register("tasks.sessions", {
      params: (p) => ({ id: text(p, "id")!, sessions: sessions(p) }),
      async handler(ctx, p) {
        const directory = s.tasks.get(p.id).directory;
        for (const id of p.sessions) {
          if (await ctx.sessionDirectory(id) !== directory) {
            throw new HarnessError(
              "params",
              "Session belongs to another project",
            );
          }
        }
        return s.tasks.sessions(p.id, p.sessions);
      },
    });
    rpc.register("sessions.seen", {
      params: (p) => sessionID(p)!,
      handler: async (ctx, id) => {
        if (!this.index.get(id)?.deleted) await ctx.sessionDirectory(id);
        return s.seen.mark(user(), id);
      },
    });
    rpc.register("sessions.finishes", {
      params: () => undefined,
      handler: () => s.finishes.list(),
    });
  }
}
