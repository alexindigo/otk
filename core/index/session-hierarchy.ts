// SPDX-License-Identifier: LGPL-3.0-only
import {
  autoApproveOwner,
  type HierarchySession,
  MAX_SESSION_LIST_SIZE,
  projectSessionHierarchy,
  sessionAncestors,
  type SessionHierarchyNode,
  type TaskRecord,
} from "@otk/protocol";
import type { SessionIdentity } from "@otk/harness";
import { ProjectIdentity } from "./project-identity.ts";

/** One source-free hierarchy owner, independent of socket/project partitions.
 * Only demanded scalar identities and index publications enter this owner. */
export class SessionHierarchy {
  #entries = new Map<string, HierarchySession>();
  #projections = new Map<boolean, ReadonlyMap<string, SessionHierarchyNode>>();
  #tasks: () => readonly TaskRecord[] = () => [];
  #mandatory: (id: string) => boolean = () => false;
  #identity = new ProjectIdentity();
  configure(
    identity: ProjectIdentity,
    tasks: () => readonly TaskRecord[],
    mandatory: (id: string) => boolean,
  ): void {
    this.#identity = identity;
    this.#tasks = tasks;
    this.#mandatory = mandatory;
    this.invalidate();
  }
  invalidate(): void {
    this.#projections.clear();
  }
  project(directory: string, repoID?: string): string {
    return this.#identity.leaf(directory, repoID);
  }
  entry(entry: HierarchySession): void {
    const before = this.#entries.get(entry.id);
    const projectID = entry.projectID ??
      (before?.directory === entry.directory ? before.projectID : undefined);
    if (
      before && before.parentID === entry.parentID &&
      before.directory === entry.directory && before.projectID === projectID
    ) return;
    this.#entries.set(entry.id, {
      id: entry.id,
      directory: entry.directory,
      parentID: entry.parentID,
      projectID,
    });
    this.invalidate();
  }
  reset(entries: readonly HierarchySession[]): void {
    this.#entries.clear();
    this.invalidate();
    for (const entry of entries) this.entry(entry);
  }
  remove(id: string): void {
    this.#entries.delete(id);
    this.invalidate();
  }
  ancestors(id: string): string[] {
    return sessionAncestors(id, (id) => this.#entries.get(id));
  }
  owner(id: string, enabled: ReadonlySet<string>): string | undefined {
    return autoApproveOwner(id, [...enabled], (id) => this.#entries.get(id));
  }
  node(id: string, followParent = false): SessionHierarchyNode | undefined {
    let nodes = this.#projections.get(followParent);
    if (!nodes) {
      nodes = projectSessionHierarchy(
        [...this.#entries.values()],
        this.#tasks(),
        {
          project: (directory, repoID) => this.project(directory, repoID),
          followParent,
        },
      );
      this.#projections.set(followParent, nodes);
    }
    const node = nodes.get(id);
    return node && { ...node, mandatory: this.#mandatory(id) };
  }
  /** Bounded keyed ancestry acquisition; never a catalog or transcript scan. */
  async prepare(
    rows: readonly HierarchySession[],
    read: (
      ids: readonly string[],
      signal?: AbortSignal,
    ) => Promise<SessionIdentity[]>,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const row of rows) this.entry(row);
    let frontier = rows.map((row) => row.id);
    const visited = new Set<string>();
    while (frontier.length) {
      signal?.throwIfAborted();
      const missing = new Set<string>(), next: string[] = [];
      for (const id of frontier) {
        if (visited.has(id)) continue;
        visited.add(id);
        const parent = this.#entries.get(id)?.parentID;
        if (!parent || visited.has(parent)) continue;
        if (this.#entries.has(parent)) next.push(parent);
        else missing.add(parent);
      }
      const ids = [...missing];
      for (let i = 0; i < ids.length; i += MAX_SESSION_LIST_SIZE) {
        const found = await read(
          ids.slice(i, i + MAX_SESSION_LIST_SIZE),
          signal,
        );
        signal?.throwIfAborted();
        for (const row of found) {
          this.entry(row);
          next.push(row.id);
        }
      }
      frontier = next;
    }
  }
}
