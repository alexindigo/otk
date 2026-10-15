// SPDX-License-Identifier: LGPL-3.0-only
import { type IndexEntry, sessionAncestors } from "@otk/protocol";

/** One authoritative metadata index, shared by the harness and its consumer. */
export class SessionIndex {
  #entries = new Map<string, IndexEntry>();
  #children = new Map<string, Set<string>>();
  get(id: string): IndexEntry | undefined {
    const entry = this.#entries.get(id);
    return entry && structuredClone(entry);
  }
  *values(): IterableIterator<IndexEntry> {
    for (const entry of this.#entries.values()) yield structuredClone(entry);
  }
  ancestors(id: string): string[] {
    return sessionAncestors(id, (id) => this.get(id));
  }
  descendants(id: string): Set<string> {
    const ids = new Set([id]);
    for (const current of ids) {
      for (const child of this.#children.get(current) ?? []) ids.add(child);
    }
    return ids;
  }
  #edge(id: string, parent?: string, remove = false): void {
    if (!parent) return;
    if (remove) {
      const children = this.#children.get(parent);
      children?.delete(id);
      if (!children?.size) this.#children.delete(parent);
    } else {
      let children = this.#children.get(parent);
      if (!children) this.#children.set(parent, children = new Set());
      children.add(id);
    }
  }
  reset(entries: IndexEntry[]): void {
    this.#entries = new Map(
      entries.map((entry) => [entry.id, structuredClone(entry)]),
    );
    this.#children.clear();
    for (const entry of this.#entries.values()) {
      this.#edge(entry.id, entry.parentID);
    }
  }
  upsert(entry: IndexEntry): void {
    const copy = structuredClone(entry);
    this.#edge(entry.id, this.#entries.get(entry.id)?.parentID, true);
    this.#entries.set(entry.id, copy);
    this.#edge(entry.id, entry.parentID);
  }
  remove(id: string): void {
    this.#edge(id, this.#entries.get(id)?.parentID, true);
    this.#entries.delete(id);
  }
}
