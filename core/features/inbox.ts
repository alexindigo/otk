// SPDX-License-Identifier: LGPL-3.0-only
import type { InboxSnapshot, IndexEntry, ServerFrame } from "@otk/protocol";
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
import { text } from "../ws/params.ts";
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
  constructor(
    readonly stores: InboxStores,
    readonly index: IndexStore,
    readonly identity: string | (() => string),
  ) {
    this.#stops.push(
      index.observe((entry, previous) => this.#observe(entry, previous)),
    );
    for (const store of Object.values(stores)) {
      this.#stops.push(store.listen(() => this.#emit()));
    }
  }
  get user(): string {
    return typeof this.identity === "string" ? this.identity : this.identity();
  }
  get(): InboxSnapshot {
    const s = this.stores;
    return {
      projects: s.projects.list(this.user),
      tasks: s.tasks.list(),
      seen: s.seen.list(this.user),
      finishes: s.finishes.list(),
      pathTemplates: s.templates.list(),
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
    s.projects.discover(entry.directory);
    if (
      previous?.status !== undefined && previous.status !== "idle" &&
      entry.status === "idle"
    ) s.finishes.record(entry.id);
    const a = entry.attention;
    const active = entry.status !== "idle" || !!a.error ||
      a.permissions + a.questions + a.childPermissions + a.childQuestions > 0;
    for (const user of new Set([this.user, ...s.projects.users()])) {
      const project = s.projects.get(user, entry.directory);
      if (
        project.inactive &&
        (active || s.finishes.time(entry.id) > s.seen.time(user, entry.id))
      ) s.projects.inactive(user, entry.directory, false);
    }
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
      async handler(_ctx, directory) {
        if (!(await Deno.stat(directory)).isDirectory) {
          throw new HarnessError("params", "Expected a project directory");
        }
        return s.projects.add(user(), directory);
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
      params: (p) => projectPath(text(p, "directory")!),
      handler: (_ctx, directory) => s.projects.visit(user(), directory),
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
        sessions: p.sessions === undefined ? [] : strings(p, "sessions"),
      }),
      async handler(ctx, p) {
        s.projects.get(user(), p.directory);
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
      sessionID: text(p, "sessionID")!,
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
      params: (p) => ({ id: text(p, "id")!, sessions: strings(p, "sessions") }),
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
      params: (p) => text(p, "sessionID")!,
      async handler(ctx, id) {
        await ctx.sessionDirectory(id);
        return s.seen.mark(user(), id);
      },
    });
    rpc.register("sessions.finishes", {
      params: () => undefined,
      handler: () => s.finishes.list(),
    });
  }
}
