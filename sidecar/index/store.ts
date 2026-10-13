// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexEntry, IndexOp } from "@otk/protocol";
import type { ServerFrame } from "@otk/protocol";
import { sessionAncestors } from "@otk/protocol";
export class IndexStore {
  #entries = new Map<string, IndexEntry>();
  #listeners = new Set<(frame: ServerFrame) => void>();
  #pending: IndexOp[] = [];
  #scheduled = false;
  rev = 0;
  ancestors(id: string): string[] {
    return sessionAncestors(id, (id) => this.#entries.get(id));
  }
  listen(listener: (frame: ServerFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  snapshot(): Extract<ServerFrame, { t: "index.snapshot" }> {
    return {
      t: "index.snapshot",
      rev: this.rev,
      entries: [...this.#entries.values()].map((entry) =>
        structuredClone(entry)
      ),
    };
  }
  reset(entries: IndexEntry[]): void {
    this.#pending = [];
    this.#entries = new Map(entries.map((e) => [e.id, structuredClone(e)]));
    this.rev++;
    this.#emit(this.snapshot());
  }
  upsert(entry: IndexEntry): void {
    const copy = structuredClone(entry);
    this.#entries.set(entry.id, copy);
    this.#queue({ op: "upsert", entry: copy });
  }
  remove(id: string): void {
    if (this.#entries.delete(id)) this.#queue({ op: "remove", id });
  }
  #emit(frame: ServerFrame): void {
    for (const listener of this.#listeners) listener(frame);
  }
  #queue(op: IndexOp): void {
    this.rev++;
    this.#pending.push(op);
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#pending.length) {
        this.#emit({
          t: "index.patch",
          rev: this.rev,
          ops: this.#pending.splice(0),
        });
      }
    });
  }
}
