// SPDX-License-Identifier: LGPL-3.0-only
import type {
  DigestIndexDelta,
  IndexEntry,
  IndexMetadata,
  IndexOp,
} from "@otk/protocol";
import type { ServerFrame } from "@otk/protocol";
import { SessionIndex } from "@otk/harness";
import type { SectionObserver } from "../diagnostics.ts";
export class IndexStore extends SessionIndex {
  #catalogs = new Map<string, readonly IndexMetadata[]>();
  /** Project-local structural inputs; never copy digests or retained turns. */
  catalog(directory: string): readonly IndexMetadata[] {
    let value = this.#catalogs.get(directory);
    if (!value) {
      value = this.snapshotEntries().filter((entry) =>
        entry.directory === directory
      )
        .map(({ digest: _digest, ...metadata }) => metadata);
      this.#catalogs.set(directory, value);
    }
    return value;
  }
  flush(): void {
    this.#flush();
  }
  #authority = new Set<(value: "current" | "stale" | "unknown") => void>();
  observeAuthority(
    listener: (value: "current" | "stale" | "unknown") => void,
  ): () => void {
    this.#authority.add(listener);
    return () => {
      this.#authority.delete(listener);
    };
  }
  projectAuthority(value: "current" | "stale" | "unknown"): void {
    for (const listener of this.#authority) listener(value);
  }
  constructor(readonly diagnostics?: SectionObserver) {
    super();
  }
  #observers = new Set<
    (entry: IndexEntry, previous?: IndexEntry, delta?: DigestIndexDelta) => void
  >();
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
    listener: (
      entry: IndexEntry,
      previous?: IndexEntry,
      delta?: DigestIndexDelta,
    ) => void,
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
    const start = performance.now();
    // A replacement baseline must never precede a queued patch it already covers.
    this.#flush();
    const frame: Extract<ServerFrame, { t: "index.snapshot" }> = {
      t: "index.snapshot",
      rev: this.rev,
      entries: [...this.snapshotEntries()],
    };
    this.diagnostics?.("index:snapshot", performance.now() - start);
    return frame;
  }
  protected override resetPublished(
    entries: IndexEntry[],
    previous: ReadonlyMap<string, IndexEntry>,
  ): void {
    const start = performance.now();
    this.#catalogs.clear();
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
    this.diagnostics?.("index:reset", performance.now() - start);
  }
  protected override published(
    entry: IndexEntry,
    previous?: IndexEntry,
    delta?: DigestIndexDelta,
  ): void {
    const start = performance.now();
    if (
      !delta ||
      JSON.stringify(entry.deleted) !== JSON.stringify(previous?.deleted)
    ) {
      this.#catalogs.delete(entry.directory);
      if (previous) this.#catalogs.delete(previous.directory);
    }
    const copy = structuredClone(entry);
    for (const listener of this.#observers) {
      listener(
        structuredClone(copy),
        previous && structuredClone(previous),
        delta,
      );
    }
    this.#queue(
      delta ? { op: "digest", ...delta } : { op: "upsert", entry: copy },
    );
    this.diagnostics?.("index:observers", performance.now() - start);
  }
  protected override removed(id: string): void {
    this.#catalogs.clear();
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
