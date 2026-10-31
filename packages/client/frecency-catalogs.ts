// SPDX-License-Identifier: LGPL-3.0-only
import type { FrecencyEntry, ServerFrame } from "@otk/protocol";
import type { InboxRpc } from "./inbox.ts";
import { createState, type StateFactory } from "./state.ts";
export interface FrecencyCatalogLease {
  readonly entries: FrecencyEntry[];
  readonly scores: ReadonlyMap<string, FrecencyEntry>;
  readonly revision: number;
  subscribe(listener: () => void): () => void;
  ready(): Promise<void>;
  release(): void;
}
export function createFrecencyCatalogs(
  rpc: InboxRpc,
  factory: StateFactory = createState,
): {
  acquire(directory: string): FrecencyCatalogLease;
  receive(frame: ServerFrame): void;
  stop(): void;
} {
  const resources = new Map<
    string,
    {
      refs: number;
      epoch: number;
      revision: number;
      entries: Map<string, FrecencyEntry>;
      values: FrecencyEntry[];
      controller: AbortController;
      work?: Promise<void>;
      observed: number;
      track(): number;
      notify(): void;
      subscribe(f: () => void): () => void;
    }
  >();
  const load = (
    directory: string,
    r: NonNullable<ReturnType<typeof resources.get>>,
  ) => {
    if (r.work) return r.work;
    const at = r.epoch;
    const work = (async () => {
      for (;;) {
        const value = await rpc.call(
          "frecency.list",
          { directory },
          r.controller.signal,
        );
        if (at !== r.epoch || r.controller.signal.aborted) return;
        if (value.revision < r.observed) continue;
        if (value.revision >= r.revision) {
          r.revision = value.revision;
          r.entries = new Map(
            value.entries.map((entry) => [entry.path, entry]),
          );
          r.values = [...r.entries.values()];
          r.notify();
        }
        return;
      }
    })().finally(() => {
      if (r.work === work) r.work = undefined;
    });
    r.work = work;
    void work.catch(() => {/* readiness caller owns failure */});
    return work;
  };
  return {
    acquire(directory) {
      let r = resources.get(directory);
      if (!r) {
        const clock = factory({ revision: 0 });
        r = {
          refs: 0,
          epoch: 0,
          revision: -1,
          entries: new Map(),
          values: [],
          controller: new AbortController(),
          observed: -1,
          track: () => clock.state.revision,
          notify: () =>
            clock.update((s) => {
              s.revision++;
            }),
          subscribe: (f) => clock.subscribe(f),
        };
        resources.set(directory, r);
        void load(directory, r);
      }
      r.refs++;
      const resource = r;
      let live = true;
      const subscriptions = new Set<() => void>();
      const track = () => resource.track();
      return {
        get entries() {
          track();
          return resource.values;
        },
        get scores() {
          track();
          return resource.entries;
        },
        get revision() {
          track();
          return resource.revision;
        },
        subscribe(listener) {
          const stop = resource.subscribe(listener);
          subscriptions.add(stop);
          return () => {
            stop();
            subscriptions.delete(stop);
          };
        },
        ready: () =>
          !live
            ? Promise.resolve()
            : resource.work ?? (resource.revision < 0
              ? load(directory, resource)
              : Promise.resolve()),
        release() {
          if (!live) return;
          live = false;
          for (const stop of subscriptions) stop();
          subscriptions.clear();
          if (--resource.refs === 0) {
            resource.epoch++;
            resource.controller.abort();
            resources.delete(directory);
            resource.entries.clear();
            resource.values = [];
          }
        },
      };
    },
    receive(frame) {
      if (frame.t === "welcome") {
        for (const [directory, r] of resources) {
          r.epoch++;
          r.controller.abort();
          r.controller = new AbortController();
          r.work = undefined;
          r.revision = -1;
          r.observed = -1;
          void load(directory, r);
        }
      } else if (frame.t === "frecency.patch") {
        const r = resources.get(frame.directory);
        if (!r || frame.revision <= r.revision) return;
        r.observed = Math.max(r.observed, frame.revision);
        if (frame.revision !== r.revision + 1) {
          void load(frame.directory, r);
          return;
        }
        for (const path of frame.remove) r.entries.delete(path);
        for (const entry of frame.upsert) r.entries.set(entry.path, entry);
        r.revision = frame.revision;
        r.values = [...r.entries.values()];
        r.notify();
      }
    },
    stop() {
      for (const r of resources.values()) {
        r.epoch++;
        r.controller.abort();
        r.entries.clear();
        r.values = [];
      }
      resources.clear();
    },
  };
}
