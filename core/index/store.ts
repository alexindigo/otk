// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexEntry, IndexOp } from "@otk/protocol";
import type { ServerFrame } from "@otk/protocol";
import { SessionIndex } from "@otk/harness";
export class IndexStore extends SessionIndex {
  #observers = new Set<(entry: IndexEntry, previous?: IndexEntry) => void>();
  /** Synchronous observations preserve transitions even within one wire batch. */
  observe(
    listener: (entry: IndexEntry, previous?: IndexEntry) => void,
  ): () => void {
    this.#observers.add(listener);
    return () => this.#observers.delete(listener);
  }
  #listeners = new Set<(frame: ServerFrame) => void>();
  #pending: IndexOp[] = [];
  #scheduled = false;
  rev = 0;
  listen(listener: (frame: ServerFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  snapshot(): Extract<ServerFrame, { t: "index.snapshot" }> {
    return {
      t: "index.snapshot",
      rev: this.rev,
      entries: [...this.values()],
    };
  }
  override reset(entries: IndexEntry[]): void {
    this.#pending = [];
    const changes = entries.map((entry) => ({
      entry,
      previous: this.get(entry.id),
    }));
    super.reset(entries);
    for (const { entry, previous } of changes) {
      for (const listener of this.#observers) {
        listener(structuredClone(entry), previous && structuredClone(previous));
      }
    }
    this.rev++;
    this.#emit(this.snapshot());
  }
  override upsert(entry: IndexEntry): void {
    const copy = structuredClone(entry);
    const previous = this.get(copy.id);
    super.upsert(copy);
    for (const listener of this.#observers) {
      listener(structuredClone(copy), previous && structuredClone(previous));
    }
    this.#queue({ op: "upsert", entry: copy });
  }
  override remove(id: string): void {
    super.remove(id);
    this.#queue({ op: "remove", id });
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
