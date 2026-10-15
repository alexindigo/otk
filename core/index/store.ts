// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexEntry, IndexOp } from "@otk/protocol";
import type { ServerFrame } from "@otk/protocol";
import { SessionIndex } from "@otk/harness";
export class IndexStore extends SessionIndex {
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
    super.reset(entries);
    this.rev++;
    this.#emit(this.snapshot());
  }
  override upsert(entry: IndexEntry): void {
    const copy = structuredClone(entry);
    super.upsert(copy);
    this.#queue({ op: "upsert", entry: copy });
  }
  override remove(id: string): void {
    if (!this.get(id)) return;
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
