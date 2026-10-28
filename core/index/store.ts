// SPDX-License-Identifier: LGPL-3.0-only
import type { DigestIndexDelta, IndexEntry, IndexOp } from "@otk/protocol";
import type { ServerFrame } from "@otk/protocol";
import { SessionIndex } from "@otk/harness";
export class IndexStore extends SessionIndex {
  #observers = new Set<(entry: IndexEntry, previous?: IndexEntry) => void>();
  #removals = new Set<(id: string) => void>();
  /** Explicit evictions are observed at their owner before wire publication. */
  observeRemoval(listener: (id: string) => void): () => void {
    this.#removals.add(listener);
    return () => {
      this.#removals.delete(listener);
    };
  }
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
    // A replacement baseline must never precede a queued patch it already covers.
    this.#flush();
    return {
      t: "index.snapshot",
      rev: this.rev,
      entries: [...this.snapshotEntries()],
    };
  }
  protected override resetPublished(
    entries: IndexEntry[],
    previous: ReadonlyMap<string, IndexEntry>,
  ): void {
    this.#pending = [];
    const changes = entries.map((entry) => ({
      entry,
      previous: previous.get(entry.id),
    }));
    for (const { entry, previous } of changes) {
      for (const listener of this.#observers) {
        listener(structuredClone(entry), previous && structuredClone(previous));
      }
    }
    this.rev++;
    // Observer writes are represented by this replacement snapshot too.
    this.#pending = [];
    this.#emit(this.snapshot());
  }
  protected override published(
    entry: IndexEntry,
    previous?: IndexEntry,
    delta?: DigestIndexDelta,
  ): void {
    const copy = structuredClone(entry);
    for (const listener of this.#observers) {
      listener(structuredClone(copy), previous && structuredClone(previous));
    }
    this.#queue(
      delta ? { op: "digest", ...delta } : { op: "upsert", entry: copy },
    );
  }
  protected override removed(id: string): void {
    for (const listener of this.#removals) listener(id);
    this.#queue({ op: "remove", id });
  }
  #emit(frame: ServerFrame): void {
    for (const listener of this.#listeners) listener(frame);
  }
  #flush(): void {
    if (!this.#pending.length) return;
    this.#emit({
      t: "index.patch",
      rev: this.rev,
      ops: this.#pending.splice(0),
    });
  }
  #queue(op: IndexOp): void {
    this.rev++;
    this.#pending.push(op);
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#flush();
    });
  }
}
