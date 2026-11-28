// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import {
  OTHER_PROGRAM_ID,
  type ProgramAssign,
  type ProgramCreate,
  type ProgramMove,
  type ProgramsFrame,
  type ProjectMoveTarget,
} from "@otk/protocol";
import type { ProgramStore, ProjectOrderStore, StoreWrite } from "@otk/store";
import type { ProjectIdentity } from "../index/project-identity.ts";
import {
  localResultExecution,
  localWrite,
  metadataReceipt,
} from "../requests/policies.ts";
import { text } from "../ws/params.ts";
import type { RpcRegistry } from "../ws/registry.ts";

const changed = metadataReceipt("program-changed", (value) => {
  if (value !== true) throw new TypeError("Invalid program change receipt");
  return true;
});
const created = metadataReceipt("program-created", (value) => {
  if (typeof value !== "string" || !value) {
    throw new TypeError("Invalid created program receipt");
  }
  return value;
});
function moveTarget(
  params: Record<string, unknown>,
): ProjectMoveTarget | undefined {
  const before = text(params, "before", true),
    after = text(params, "after", true);
  if (
    before === "" || after === "" ||
    (before !== undefined && after !== undefined)
  ) {
    throw new HarnessError("params", "Expected one move target");
  }
  return before !== undefined
    ? { before }
    : after !== undefined
    ? { after }
    : undefined;
}

/** The sole programs and membership owner. Orders and remote identity are inputs. */
export class ProjectPrograms {
  #frames = new Map<string, ProgramsFrame>();
  #groups = new Map<string, Map<string, string[]>>();
  #listeners = new Set<(user: string) => void>();
  #stops: (() => void)[];
  constructor(
    readonly store: ProgramStore,
    readonly order: ProjectOrderStore,
    readonly identity: Pick<ProjectIdentity, "owner">,
  ) {
    this.#stops = [
      store.listen(({ user }) => this.#publish(user)),
      order.listen(({ user, removed }) => {
        this.#reconcile(user, removed);
      }),
    ];
  }
  close(): void {
    for (const stop of this.#stops) stop();
    this.#listeners.clear();
  }
  listen(listener: (user: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  frame(user: string): ProgramsFrame {
    return this.#frames.get(user) ?? this.#publish(user);
  }
  groups(user: string): ReadonlyMap<string, readonly string[]> {
    this.frame(user);
    return this.#groups.get(user)!;
  }
  identityChanged(user: string): void {
    this.#reconcile(user);
  }
  #reconcile(user: string, removed: readonly string[] = []): void {
    const missing = this.#missingOwners(user);
    if (removed.length || missing.length) {
      this.store.db.write((tx) => {
        if (removed.length) this.store.forget(user, removed, tx);
        for (const owner of missing) this.store.ensureAuto(user, owner, tx);
      });
    }
    this.#publish(user);
  }
  #missingOwners(user: string): string[] {
    if (!this.store.auto(user)) return [];
    const known = new Set(this.store.list(user).map((p) => p.owner));
    const chosen = this.store.members(user);
    const missing = new Set<string>();
    for (const { id, root } of this.order.list(user)) {
      if (chosen.has(id)) continue;
      const owner = this.identity.owner(root);
      if (owner && !known.has(owner)) missing.add(owner);
    }
    return [...missing];
  }
  #publish(user: string): ProgramsFrame {
    const before = this.#frames.get(user);
    const auto = this.store.auto(user);
    const rows = this.store.list(user).filter((p) => !p.dismissed);
    const automatic = new Map(
      rows.flatMap((p) => p.owner ? [[p.owner, p.id]] : []),
    );
    const chosen = this.store.members(user);
    const used = new Set<string>();
    const members: ProgramsFrame["members"] = Object.create(null);
    const projects = this.order.list(user).sort((a, b) =>
      a.id.localeCompare(b.id)
    );
    for (const { id, root } of projects) {
      if (chosen.has(id)) {
        const program = chosen.get(id)!;
        members[id] = { program, by: "user" };
        if (program) used.add(program);
      } else if (auto) {
        const program = automatic.get(this.identity.owner(root) ?? "");
        if (!program) continue;
        members[id] = { program, by: "auto" };
        used.add(program);
      }
    }
    const programs: ProgramsFrame["programs"] = rows.filter((p) =>
      !p.owner || used.has(p.id)
    ).map((p) => ({
      id: p.id,
      name: (p.name ?? p.owner)!,
      named: p.name !== null,
      ...(p.owner
        ? { origin: "auto" as const, owner: p.owner }
        : { origin: "user" as const }),
    }));
    const changed = !before || auto !== before.auto ||
      JSON.stringify(programs) !== JSON.stringify(before.programs) ||
      JSON.stringify(members) !== JSON.stringify(before.members);
    const frame: ProgramsFrame = changed
      ? {
        t: "programs",
        revision: (before?.revision ?? 0) + 1,
        auto,
        programs,
        members,
      }
      : before;
    const groups = new Map(programs.map(({ id }) => [id, [] as string[]]));
    if (groups.size) {
      groups.set(OTHER_PROGRAM_ID, []);
      for (const { id, root } of projects) {
        groups.get(members[id]?.program ?? OTHER_PROGRAM_ID)!.push(root);
      }
    }
    const oldGroups = this.#groups.get(user);
    this.#frames.set(user, frame);
    this.#groups.set(user, groups);
    if (
      changed ||
      JSON.stringify([...oldGroups ?? []]) !== JSON.stringify([...groups])
    ) {
      for (const listener of this.#listeners) listener(user);
    }
    return frame;
  }
  #projectIDs(user: string, ids: readonly string[]): void {
    if (!ids.length) return;
    const known = new Set(this.order.list(user).map(({ id }) => id));
    if (ids.some((id) => !known.has(id))) throw new Error("Unknown project");
  }
  create(user: string, params: ProgramCreate, tx?: StoreWrite): string {
    return this.store.db.write((scope) => {
      this.#projectIDs(user, params.projects ?? []);
      const id = this.store.create(user, params.name, scope);
      for (const project of params.projects ?? []) {
        this.store.assign(user, project, id, scope);
      }
      return id;
    }, tx);
  }
  rename(user: string, id: string, name: string, tx?: StoreWrite): void {
    this.store.rename(user, id, name, tx);
  }
  delete(user: string, id: string, tx?: StoreWrite): void {
    this.store.db.write((scope) => {
      const row = this.store.list(user).find((p) =>
        p.id === id && !p.dismissed
      );
      if (!row) throw new Error("Unknown program");
      if (row.owner) {
        const choices = this.store.members(user);
        this.store.dismiss(user, id, scope);
        // D84: a project manually brought in from another GitHub owner goes
        // to Other as well, not straight into that owner's automatic group.
        for (const project of this.order.list(user)) {
          const fallback = this.identity.owner(project.root);
          if (
            choices.get(project.id) === id && fallback && fallback !== row.owner
          ) {
            this.store.assign(user, project.id, null, scope);
          }
        }
      } else this.store.remove(user, id, scope);
      for (const owner of this.#missingOwners(user)) {
        this.store.ensureAuto(user, owner, scope);
      }
    }, tx);
  }
  move(
    user: string,
    id: string,
    target: ProjectMoveTarget,
    tx?: StoreWrite,
  ): void {
    this.store.move(user, id, target, tx);
  }
  assign(user: string, params: ProgramAssign, tx?: StoreWrite): void {
    this.store.db.write((scope) => {
      this.#projectIDs(user, [params.project]);
      this.store.assign(user, params.project, params.program, scope);
      if ("before" in params && params.before !== undefined) {
        this.order.move(user, params.project, { before: params.before }, scope);
      }
      if ("after" in params && params.after !== undefined) {
        this.order.move(user, params.project, { after: params.after }, scope);
      }
    }, tx);
  }
  unassign(user: string, project: string, tx?: StoreWrite): void {
    this.store.db.write((scope) => {
      this.store.unassign(user, project, scope);
      for (const owner of this.#missingOwners(user)) {
        this.store.ensureAuto(user, owner, scope);
      }
    }, tx);
  }
  setAuto(user: string, value: boolean, tx?: StoreWrite): void {
    this.store.db.write((scope) => {
      this.store.setAuto(user, value, scope);
      for (const owner of this.#missingOwners(user)) {
        this.store.ensureAuto(user, owner, scope);
      }
    }, tx);
  }

  register(
    rpc: RpcRegistry,
    user: () => string,
    orderRevision: () => number,
  ): void {
    const saved = () => ({ revision: this.frame(user()).revision });
    const assigned = () => ({ ...saved(), orderRevision: orderRevision() });
    const scope = () => ({ resource: "programs" });
    const createdResult = (id: string) => ({ id, ...saved() });
    rpc.register("programs.create", {
      execution: localResultExecution(scope, created, createdResult),
      params(p): ProgramCreate {
        const { projects } = p;
        if (
          projects !== undefined && (!Array.isArray(projects) ||
            projects.some((id) => typeof id !== "string" || !id) ||
            new Set(projects).size !== projects.length)
        ) {
          throw new HarnessError("params", "Expected unique project IDs");
        }
        return { name: text(p, "name")!, projects };
      },
      handler: (ctx, p) =>
        createdResult(
          localWrite(ctx, (tx) => this.create(user(), p, tx), created),
        ),
    });
    rpc.register("programs.rename", {
      execution: localResultExecution(scope, changed, saved),
      params: (p) => ({ id: text(p, "id")!, name: text(p, "name")! }),
      handler: (ctx, p) => {
        localWrite(ctx, (tx) => {
          this.rename(user(), p.id, p.name, tx);
          return true as const;
        }, changed);
        return saved();
      },
    });
    rpc.register("programs.delete", {
      execution: localResultExecution(scope, changed, saved),
      params: (p) => text(p, "id")!,
      handler: (ctx, id) => {
        localWrite(ctx, (tx) => {
          this.delete(user(), id, tx);
          return true as const;
        }, changed);
        return saved();
      },
    });
    rpc.register("programs.move", {
      execution: localResultExecution(scope, changed, saved),
      params(p): ProgramMove {
        const target = moveTarget(p);
        if (!target) {
          throw new HarnessError("params", "Expected one program move target");
        }
        return { id: text(p, "id")!, ...target };
      },
      handler: (ctx, p) => {
        localWrite(ctx, (tx) => {
          this.move(user(), p.id, p, tx);
          return true as const;
        }, changed);
        return saved();
      },
    });
    rpc.register("programs.assign", {
      execution: localResultExecution(scope, changed, assigned),
      params: (p): ProgramAssign => ({
        project: text(p, "project")!,
        program: p.program === null ? null : text(p, "program")!,
        ...moveTarget(p),
      }),
      handler: (ctx, p) => {
        localWrite(ctx, (tx) => {
          this.assign(user(), p, tx);
          return true as const;
        }, changed);
        return assigned();
      },
    });
    rpc.register("programs.auto", {
      execution: localResultExecution(scope, changed, saved),
      params(p) {
        if (typeof p.value !== "boolean") {
          throw new HarnessError("params", "Expected a boolean value");
        }
        return p.value;
      },
      handler: (ctx, value) => {
        localWrite(ctx, (tx) => {
          this.setAuto(user(), value, tx);
          return true as const;
        }, changed);
        return saved();
      },
    });
  }
}
