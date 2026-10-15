// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexEntry } from "@otk/protocol";

type Kind = "permissions" | "questions";
type Counts = Record<Kind, number>;
/** Request counters only; metadata and topology live in the shared index. */
export class Attention {
  #direct = new Map<string, Counts>();
  constructor(
    readonly get: (id: string) => IndexEntry | undefined,
    readonly publish: (entry: IndexEntry) => void,
    readonly erase: (id: string) => void,
    readonly descendants: (id: string) => Iterable<string>,
  ) {}
  #path(id: string, get = this.get): string[] {
    const path: string[] = [], seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const entry = get(id);
      if (!entry) break;
      path.push(id);
      if (!entry.parentID) break;
      id = entry.parentID;
    }
    return path;
  }
  reset(
    entries: IndexEntry[],
    permissions: Iterable<string>,
    questions: Iterable<string>,
  ): void {
    this.#direct.clear();
    const staged = new Map(entries.map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      entry.attention.permissions =
        entry.attention.questions =
        entry.attention.childPermissions =
        entry.attention.childQuestions =
          0;
    }
    for (
      const [kind, owners] of [["permissions", permissions], [
        "questions",
        questions,
      ]] as const
    ) {
      for (const id of owners) {
        const counts = this.#direct.get(id) ?? { permissions: 0, questions: 0 };
        counts[kind]++;
        this.#direct.set(id, counts);
        for (
          const [i, ancestor] of this.#path(id, (id) => staged.get(id))
            .entries()
        ) {
          staged.get(ancestor)!.attention[this.#key(kind, i)]++;
        }
      }
    }
  }
  #key(
    kind: Kind,
    depth: number,
  ): keyof Pick<
    IndexEntry["attention"],
    Kind | "childPermissions" | "childQuestions"
  > {
    return depth === 0
      ? kind
      : kind === "permissions"
      ? "childPermissions"
      : "childQuestions";
  }
  change(id: string, kind: Kind, delta: number): void {
    const counts = this.#direct.get(id) ?? { permissions: 0, questions: 0 };
    counts[kind] += delta;
    if (counts.permissions || counts.questions) this.#direct.set(id, counts);
    else this.#direct.delete(id);
    for (const [depth, ancestor] of this.#path(id).entries()) {
      const entry = this.get(ancestor)!;
      entry.attention[this.#key(kind, depth)] += delta;
      this.publish(entry);
    }
  }
  /** A topology change visits only this subtree and its old/new ancestors. */
  #move(id: string, mutate: () => void): void {
    const affected = new Set(this.descendants(id));
    const before = new Map([...affected].map((id) => [id, this.#path(id)]));
    mutate();
    const changes = new Map<string, Partial<IndexEntry["attention"]>>();
    for (const current of affected) {
      const counts = this.#direct.get(current);
      if (!counts) continue;
      for (
        const [path, sign] of [[before.get(current)!, -1], [
          this.#path(current),
          1,
        ]] as const
      ) {
        for (const [depth, ancestor] of path.entries()) {
          const change = changes.get(ancestor) ?? {};
          for (const kind of ["permissions", "questions"] as const) {
            const key = this.#key(kind, depth);
            change[key] = (change[key] ?? 0) + sign * counts[kind];
          }
          changes.set(ancestor, change);
        }
      }
    }
    for (const [ancestor, change] of changes) {
      const entry = this.get(ancestor);
      if (!entry) continue;
      let changed = false;
      for (
        const key of [
          "permissions",
          "questions",
          "childPermissions",
          "childQuestions",
        ] as const
      ) {
        if (change[key]) {
          entry.attention[key] += change[key]!;
          changed = true;
        }
      }
      if (changed) this.publish(entry);
    }
  }
  upsert(entry: IndexEntry): void {
    const old = this.get(entry.id);
    if (old?.parentID === entry.parentID && old) {
      this.publish(entry);
      return;
    }
    this.#move(entry.id, () => {
      this.publish(entry);
    });
  }
  remove(id: string): void {
    this.#move(id, () => {
      this.erase(id);
    });
  }
}
