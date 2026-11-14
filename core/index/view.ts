// SPDX-License-Identifier: LGPL-3.0-only
import type {
  DigestIndexDelta,
  IndexEntry,
  IndexOp,
  ServerFrame,
  ViewLease,
} from "@otk/protocol";
import type { IndexStore } from "./store.ts";

/** Publication revisions belong to the recipient, not the global population. */
export class IndexView {
  #ids = new Set<string>();
  #rev = 0;
  #epoch = -1;
  #appliedRev = 0;
  #flight?: { epoch: number; rev: number; keys: string[] };
  #selected?: string;
  #pending = new Map<string, DigestIndexDelta | undefined>();
  #hierarchies = new Map<string, string>();
  #stops: (() => void)[];
  ids(): ReadonlySet<string> {
    return this.#ids;
  }
  constructor(
    readonly index: IndexStore,
    readonly view: () => ViewLease,
    readonly keys: (view: ViewLease) => readonly string[],
    readonly send: (frame: ServerFrame) => void,
    readonly project: (entry: IndexEntry, view: ViewLease) => IndexEntry = (
      entry,
    ) => entry,
  ) {
    this.#stops = [
      index.observe((entry, _previous, delta) => {
        const scope = view(),
          directory = scope.directory ??
            (scope.selected
              ? index.getMetadata(scope.selected)?.directory
              : undefined);
        if (
          entry.directory !== directory && !this.#ids.has(entry.id) &&
          entry.id !== scope.selected &&
          !scope.crumbs.includes(entry.id) && !scope.rows.includes(entry.id)
        ) return;
        if (delta && !this.#ids.has(entry.id)) return;
        if (delta && this.project(entry, scope).digest !== entry.digest) return;
        this.#pending.set(
          entry.id,
          this.#pending.has(entry.id) ? undefined : delta,
        );
      }),
      index.observeRemoval((id) => {
        if (this.#ids.has(id)) this.#pending.set(id, undefined);
      }),
    ];
  }
  close(): void {
    for (const stop of this.#stops) stop();
    this.#pending.clear();
    this.#hierarchies.clear();
    this.#flight = undefined;
  }
  /** Only consumer acceptance advances credit; socket send is not delivery. */
  applied(epoch: number, rev: number): void {
    const flight = this.#flight;
    if (!flight || flight.epoch !== epoch || flight.rev !== rev) return;
    this.#appliedRev = rev;
    this.#flight = undefined;
    this.refresh();
  }
  #wanted(): Set<string> {
    const view = this.view();
    const ids = new Set([...view.crumbs, ...view.rows, ...this.keys(view)]);
    if (view.selected) ids.add(view.selected);
    for (const id of [...ids]) {
      for (const parent of this.index.ancestors(id)) ids.add(parent);
    }
    return ids;
  }
  #entry(id: string): IndexEntry | undefined {
    const entry = this.index.snapshotEntry(id);
    if (!entry) return;
    const value = this.project(entry, this.view());
    this.#hierarchies.set(id, JSON.stringify(value.hierarchy));
    if (id === this.view().selected) return value;
    return { ...value, digest: { ...value.digest, turns: {} } };
  }
  snapshot(): void {
    this.index.flush();
    const entries = [...this.#wanted()].flatMap((id) => this.#entry(id) ?? []);
    this.#ids = new Set(entries.map((entry) => entry.id));
    this.#selected = this.view().selected;
    this.#pending.clear();
    this.#epoch = this.view().epoch;
    this.#flight = {
      epoch: this.#epoch,
      rev: this.#rev,
      keys: entries.map((entry) => entry.id),
    };
    this.send({
      t: "index.snapshot",
      rev: this.#rev,
      epoch: this.view().epoch,
      entries,
    });
  }
  refresh(frame?: ServerFrame): void {
    if (frame?.t === "index.snapshot") {
      this.snapshot();
      return;
    }
    const epoch = this.view().epoch;
    if (epoch !== this.#epoch) {
      // The old chunk may have been applied or dropped. Replay its keys from
      // current authority, including evictions, without resnapshotting the view.
      for (const id of this.#flight?.keys ?? []) {
        this.#pending.set(id, undefined);
        this.#ids.add(id);
      }
      this.#flight = undefined;
      this.#rev = this.#appliedRev;
      this.#epoch = epoch;
    }
    if (this.#flight) return;
    const wanted = this.#wanted(), ops = new Map<string, IndexOp>();
    // Parent/task/topology changes can revise a retained child's hierarchy even
    // without a new native row for that child. Compare only the bounded lease.
    for (const id of wanted) {
      const entry = this.index.snapshotEntry(id);
      if (
        entry && this.#ids.has(id) &&
        this.#hierarchies.get(id) !==
          JSON.stringify(this.project(entry, this.view()).hierarchy)
      ) {
        this.#pending.set(id, undefined);
      }
    }
    for (const id of this.#ids) {
      if (!wanted.has(id)) {
        ops.set(id, { op: "evict", id });
        this.#hierarchies.delete(id);
      }
    }
    for (const [id, delta] of this.#pending) {
      if (!this.index.snapshotEntry(id)) {
        if (this.#ids.has(id)) ops.set(id, { op: "remove", id });
      } else if (wanted.has(id)) {
        if (delta && this.#ids.has(id)) {
          ops.set(id, {
            op: "digest",
            ...delta,
            ...(id === this.view().selected
              ? {}
              : { turns: { upsert: {}, remove: [] } }),
          });
        } else {
          const entry = this.#entry(id);
          if (entry) ops.set(id, { op: "upsert", entry });
        }
      }
    }
    for (const id of wanted) {
      if (
        !this.#ids.has(id) ||
        this.#selected !== this.view().selected &&
          (id === this.#selected || id === this.view().selected)
      ) {
        const entry = this.#entry(id);
        if (entry) ops.set(id, { op: "upsert", entry });
      }
    }
    this.#selected = this.view().selected;
    if (!ops.size) {
      this.#pending.clear();
      return;
    }
    // One bounded chunk can be outstanding. Pending updates retain one value
    // per identity; repeated deltas become one authoritative upsert.
    const chunk: IndexOp[] = [];
    const keys: string[] = [];
    for (const id of ops.keys()) {
      if (!this.#pending.has(id)) this.#pending.set(id, undefined);
    }
    let bytes = 0;
    for (const [id, op] of ops) {
      const size = new TextEncoder().encode(JSON.stringify(op)).byteLength;
      if (chunk.length && (chunk.length >= 128 || bytes + size > 256 * 1024)) {
        break;
      }
      chunk.push(op);
      keys.push(id);
      bytes += size;
      this.#pending.delete(id);
      if (wanted.has(id) && this.index.snapshotEntry(id)) this.#ids.add(id);
      else this.#ids.delete(id);
    }
    for (const [id] of this.#pending) {
      if (!wanted.has(id) && !this.#ids.has(id)) this.#pending.delete(id);
    }
    const from = this.#rev;
    this.#rev += chunk.length;
    this.#flight = {
      epoch,
      rev: this.#rev,
      keys,
    };
    this.send({
      t: "index.patch",
      from,
      rev: this.#rev,
      epoch: this.view().epoch,
      ops: chunk,
    });
  }
}
