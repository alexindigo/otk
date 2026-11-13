// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexEntry, ServerFrame, ViewLease } from "@otk/protocol";
import type { IndexStore } from "../index/store.ts";
import type { FrameSource } from "../ws/connections.ts";

/** Pending user requests alone acquire cross-project routing metadata. */
export class RequestAttention implements FrameSource {
  #pending = new Set<string>();
  #routes = new Map<
    string,
    {
      permissions: number;
      questions: number;
      childPermissions: number;
      childQuestions: number;
    }
  >();
  #stops: (() => void)[];
  constructor(
    readonly index: IndexStore,
    readonly automatic: (id: string) => boolean,
  ) {
    const observe = (entry: IndexEntry) => {
      if (
        !entry.deleted &&
        (entry.attention.permissions || entry.attention.questions)
      ) this.#pending.add(entry.id);
      else this.#pending.delete(entry.id);
    };
    for (const entry of index.snapshotEntries()) observe(entry);
    this.#stops = [
      index.observe((entry, _before, delta) => {
        if (!delta) observe(entry);
      }),
      index.observeRemoval((id) => {
        this.#pending.delete(id);
      }),
    ];
  }
  keys(): string[] {
    this.#routes.clear();
    const ensure = (id: string) => {
      let value = this.#routes.get(id);
      if (!value) {
        this.#routes.set(
          id,
          value = {
            permissions: 0,
            questions: 0,
            childPermissions: 0,
            childQuestions: 0,
          },
        );
      }
      return value;
    };
    for (const id of this.#pending) {
      const entry = this.index.getMetadata(id);
      if (!entry || entry.deleted) continue;
      const permissions = this.automatic(id) ? 0 : entry.attention.permissions;
      const questions = entry.attention.questions;
      if (!permissions && !questions) continue;
      Object.assign(ensure(id), { permissions, questions });
      for (const parent of this.index.ancestors(id)) {
        const value = ensure(parent);
        value.childPermissions += permissions;
        value.childQuestions += questions;
      }
    }
    return [...this.#routes.keys()];
  }
  project(entry: IndexEntry, view: ViewLease): IndexEntry {
    const directory = view.directory ??
      (view.selected
        ? this.index.getMetadata(view.selected)?.directory
        : undefined);
    const attention = this.#routes.get(entry.id);
    if (
      !attention || entry.directory === directory ||
      entry.id === view.selected || view.crumbs.includes(entry.id) ||
      view.rows.includes(entry.id)
    ) return entry;
    return {
      id: entry.id,
      parentID: entry.parentID,
      title: entry.title,
      directory: entry.directory,
      projectID: entry.projectID,
      hierarchy: entry.hierarchy,
      status: "idle",
      archived: false,
      timeCreated: 0,
      timeUpdated: 0,
      attention: { ...attention },
      digest: { state: "digesting", revision: 0, turns: {} },
    };
  }
  listen(_listener: (frame: ServerFrame) => void): () => void {
    return () => {};
  }
  close(): void {
    for (const stop of this.#stops) stop();
    this.#pending.clear();
    this.#routes.clear();
  }
}
