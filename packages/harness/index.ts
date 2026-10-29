// SPDX-License-Identifier: LGPL-3.0-only
import {
  type DigestIndexDelta,
  type IndexEntry,
  sessionAncestors,
  type SessionMetadata,
} from "@otk/protocol";

/** Freeze newly owned branches once; unchanged digest/turn branches are shared. */
function immutable<T extends object>(value: T): T {
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") immutable(child);
    }
  }
  return value;
}

/** One authoritative metadata index, shared by the harness and its consumer. */
export class SessionIndex {
  #digestListeners = new Set<(id: string) => void>();
  observeDigest(listener: (id: string) => void): () => void {
    this.#digestListeners.add(listener);
    return () => {
      this.#digestListeners.delete(listener);
    };
  }
  helper(id: string): import("@otk/protocol").HelperSummary | undefined {
    const entry = this.#entries.get(id);
    return entry?.deleted
      ? {
        state: "unavailable",
        revision: entry.digest.revision,
        toolCount: null,
      }
      : entry?.digest.helper && structuredClone(entry.digest.helper);
  }
  #entries = new Map<string, IndexEntry>();
  #children = new Map<string, Set<string>>();
  get(id: string): IndexEntry | undefined {
    const entry = this.#entries.get(id);
    return entry && structuredClone(entry);
  }
  /** Detached live metadata; status/topology reads never traverse turn history. */
  getMetadata(id: string): Omit<IndexEntry, "digest"> | undefined {
    const entry = this.#entries.get(id);
    if (!entry) return;
    const { digest: _digest, ...metadata } = entry;
    return structuredClone(metadata);
  }
  *values(): IterableIterator<IndexEntry> {
    for (const entry of this.#entries.values()) yield structuredClone(entry);
  }
  /** Stable, deeply immutable entries for serialization without a history clone. */
  snapshotEntries(): readonly IndexEntry[] {
    return Object.freeze([...this.#entries.values()]);
  }
  ancestors(id: string): string[] {
    return sessionAncestors(id, (id) => this.#entries.get(id));
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
  reset(entries: SessionMetadata[]): void {
    const previous = new Map(this.#entries);
    this.#entries = new Map(
      entries.map((entry) => [entry.id, this.#materialize(entry)]),
    );
    this.#children.clear();
    for (const entry of this.#entries.values()) {
      this.#edge(entry.id, entry.parentID);
    }
    this.resetPublished([...this.values()], previous);
  }
  protected resetPublished(
    _entries: IndexEntry[],
    _previous: ReadonlyMap<string, IndexEntry>,
  ): void {}
  protected published(
    _entry: IndexEntry,
    _previous?: IndexEntry,
    _delta?: DigestIndexDelta,
  ): void {}
  protected removed(_id: string): void {}
  #materialize(entry: SessionMetadata): IndexEntry {
    const previous = this.#entries.get(entry.id);
    const metadata = structuredClone(entry);
    Reflect.deleteProperty(metadata, "digest");
    Reflect.deleteProperty(metadata, "deleted");
    return immutable({
      ...metadata,
      digest: previous?.digest ??
        { state: "digesting", revision: 0, turns: {} },
      ...(previous?.deleted ? { deleted: previous.deleted } : {}),
    });
  }
  /** Catalog reconciliation retains absent identities; absence is not authority. */
  resetMetadata(entries: SessionMetadata[]): void {
    for (const entry of entries) this.upsertMetadata(entry);
  }
  upsertMetadata(entry: SessionMetadata): void {
    this.upsert(entry);
  }
  upsert(entry: SessionMetadata): void {
    const previous = this.get(entry.id);
    const copy = this.#materialize(entry);
    this.#edge(entry.id, this.#entries.get(entry.id)?.parentID, true);
    this.#entries.set(entry.id, copy);
    this.#edge(entry.id, entry.parentID);
    this.published(this.get(entry.id)!, previous);
  }
  applyDigest(delta: DigestIndexDelta): boolean {
    const entry = this.#entries.get(delta.id);
    if (!entry || delta.revision < entry.digest.revision) return false;
    const previous = this.get(delta.id);
    const turns =
      !Object.keys(delta.turns.upsert).length && !delta.turns.remove.length
        ? entry.digest.turns
        : {
          ...entry.digest.turns,
          ...structuredClone(delta.turns.upsert),
        };
    for (const id of delta.turns.remove) delete turns[id];
    const next: IndexEntry = {
      ...entry,
      digest: {
        ...entry.digest,
        ...structuredClone(delta.summary),
        revision: delta.revision,
        turns,
      },
    };
    if (delta.helper === null) delete next.digest.helper;
    else if (delta.helper) next.digest.helper = structuredClone(delta.helper);
    if (delta.deleted) next.deleted = structuredClone(delta.deleted);
    else delete next.deleted;
    this.#entries.set(delta.id, immutable(next));
    this.published(this.get(delta.id)!, previous, structuredClone(delta));
    for (const listener of this.#digestListeners) listener(delta.id);
    return true;
  }
  remove(id: string): void {
    this.#edge(id, this.#entries.get(id)?.parentID, true);
    this.#entries.delete(id);
    this.removed(id);
  }
}
