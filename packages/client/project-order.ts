// SPDX-License-Identifier: LGPL-3.0-only
import type { ServerFrame } from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";

interface Slot {
  id: string;
  rank: number;
  ordinal: number;
}

/** One complete replica per connection; never creates an order from row arrivals. */
export function createProjectOrder(factory: StateFactory = createState) {
  let of = new Map<string, Slot>();
  const clock = factory({ revision: 0 });
  const waiters = new Set<{
    revision: number;
    resolve(): void;
    reject(error: Error): void;
  }>();
  function reset() {
    of = new Map();
    clock.update((s) => s.revision = 0);
    for (const waiter of waiters) {
      waiter.reject(new Error("Project order connection changed"));
    }
    waiters.clear();
  }
  return {
    get ready() {
      return clock.state.revision > 0;
    },
    slot(directory: string) {
      void clock.state.revision;
      return of.get(directory);
    },
    receive(frame: ServerFrame) {
      if (frame.t === "welcome") reset();
      if (
        frame.t !== "projects.order" || frame.revision <= clock.state.revision
      ) return;
      of = new Map();
      frame.projects.forEach(({ id, directories }, rank) => {
        directories.forEach((directory, ordinal) =>
          of.set(directory, { id, rank, ordinal })
        );
      });
      clock.update((s) => s.revision = frame.revision);
      for (const waiter of waiters) {
        if (waiter.revision <= frame.revision) {
          waiters.delete(waiter);
          waiter.resolve();
        }
      }
    },
    settled(revision: number): Promise<void> {
      if (clock.state.revision >= revision) return Promise.resolve();
      return new Promise((resolve, reject) =>
        waiters.add({ revision, resolve, reject })
      );
    },
    stop: reset,
  };
}

export function orderProjectRows<T extends { directory: string }>(
  rows: { row: T; serverOrder: number; slot?: Slot }[],
): T[] {
  const unknown = Number.MAX_SAFE_INTEGER;
  return rows.sort((a, b) =>
    a.serverOrder - b.serverOrder ||
    (a.slot?.rank ?? unknown) - (b.slot?.rank ?? unknown) ||
    (a.slot?.ordinal ?? unknown) - (b.slot?.ordinal ?? unknown) ||
    a.row.directory.localeCompare(b.row.directory)
  ).map(({ row }) => row);
}
