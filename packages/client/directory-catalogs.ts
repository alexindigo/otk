// SPDX-License-Identifier: LGPL-3.0-only
import type {
  CatalogChunk,
  CatalogChunkKinds,
  CatalogCodec,
  CatalogCodecs,
  CatalogValue,
  DirectoryCatalog,
  DirectoryCatalogKinds,
  ServerFrame,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import type { CatalogOwner, CatalogState } from "./catalog-resource.ts";
export interface DirectoryCatalogState {
  catalog?: DirectoryCatalog;
}
export interface DirectoryCatalogLease {
  readonly state: DirectoryCatalogState;
  subscribe(listener: () => void): () => void;
  ready(kind?: keyof DirectoryCatalogKinds): Promise<void>;
  refresh(): Promise<void>;
  view<K extends keyof DirectoryCatalogKinds>(
    kind: K,
    project?: (value: DirectoryCatalogKinds[K]) => DirectoryCatalogKinds[K],
  ): CatalogOwner<DirectoryCatalogKinds[K]>;
  release(): void;
}
export interface ClientDirectoryCatalogs {
  acquire(directory: string): DirectoryCatalogLease;
  receive(frame: ServerFrame): void;
  stop(): void;
}
type Kind = keyof DirectoryCatalogKinds & keyof CatalogChunkKinds;
interface Resource {
  directory: string;
  refs: number;
  alive: boolean;
  version: number;
  current: DirectoryCatalogState;
  state: DirectoryCatalogState;
  notify(): void;
  subscribe(listener: () => void): () => void;
  watch?: { result: Promise<DirectoryCatalog>; release(): void };
  work?: Promise<void>;
  refresh?: Promise<void>;
  staging: Map<
    Kind,
    {
      transfer: string;
      revision: number;
      next: number;
      append(items: never[]): void;
      finish(): unknown;
    }
  >;
  retired: Set<string>;
}
/** One demanded directory resource; volatile values and builders leave with its final borrower. */
export function createDirectoryCatalogs(o: {
  watch(
    directory: string,
  ): { result: Promise<DirectoryCatalog>; release(): void };
  refresh(directory: string): Promise<void>;
  codecs: CatalogCodecs;
  factory?: StateFactory;
  diagnostic?(cause: unknown): void;
}): ClientDirectoryCatalogs {
  const resources = new Map<string, Resource>();
  let stopped = false;
  const refresh = (r: Resource) => {
    if (r.refresh) return r.refresh;
    const work = Promise.resolve().then(() => o.refresh(r.directory)).finally(
      () => {
        if (r.refresh === work) r.refresh = undefined;
      },
    );
    r.refresh = work;
    return work;
  };
  const install = (r: Resource, catalog: DirectoryCatalog) => {
    const previous = r.current.catalog;
    if (
      !r.alive || catalog.directory !== r.directory ||
      r.retired.has(catalog.generation)
    ) return;
    if (
      previous?.generation === catalog.generation &&
      previous.revision > catalog.revision
    ) return;
    if (previous && previous.generation !== catalog.generation) {
      r.retired.add(previous.generation);
      r.staging.clear();
    }
    // Metadata-only updates retain the last complete value, never a partial list.
    const values = { ...catalog.values };
    for (const kind of Object.keys(values) as Kind[]) {
      const current = values[kind], old = previous?.values[kind];
      if (current && current.revision > (old?.revision ?? -1)) {
        r.staging.delete(kind);
      }
      if (current && current.value === undefined && old?.value !== undefined) {
        (values as Record<string, CatalogValue<unknown>>)[kind] = {
          ...current,
          value: old.value,
        };
      }
    }
    r.current.catalog = { ...catalog, values };
    r.notify();
  };
  const watch = (r: Resource) => {
    const at = ++r.version;
    r.watch?.release();
    r.staging.clear();
    const operation = o.watch(r.directory);
    r.watch = operation;
    r.work = operation.result.then((value) => {
      if (r.alive && at === r.version) install(r, value);
    })
      .catch((cause) => {
        if (r.alive && at === r.version) o.diagnostic?.(cause);
      });
  };
  const retire = (r: Resource) => {
    r.alive = false;
    r.version++;
    r.watch?.release();
    r.watch = undefined;
    r.staging.clear();
    r.current.catalog = undefined;
    r.notify();
    resources.delete(r.directory);
  };
  const chunk = <K extends Kind>(
    r: Resource,
    frame: CatalogChunk & { kind: K },
  ) => {
    const catalog = r.current.catalog;
    if (
      !catalog || catalog.generation !== frame.generation ||
      frame.revision < (catalog.values[frame.kind]?.revision ?? -1)
    ) return;
    const codec = o.codecs[frame.kind] as CatalogCodec<K> | undefined;
    if (!codec) return;
    let builder = r.staging.get(frame.kind);
    if (frame.part === 0) {
      const created = codec.create();
      builder = {
        transfer: frame.transfer,
        revision: frame.revision,
        next: 0,
        append: (items) => created.append(items),
        finish: () => created.finish(),
      };
      r.staging.set(frame.kind, builder);
    }
    if (
      !builder || builder.transfer !== frame.transfer ||
      builder.revision !== frame.revision || builder.next !== frame.part
    ) {
      r.staging.delete(frame.kind);
      void refresh(r).catch((cause) => o.diagnostic?.(cause));
      return;
    }
    try {
      builder.append(frame.items as never[]);
      builder.next++;
      if (!frame.last) return;
      const value = builder.finish();
      r.staging.delete(frame.kind);
      r.current.catalog = {
        ...catalog,
        revision: Math.max(catalog.revision, frame.revision),
        values: {
          ...catalog.values,
          [frame.kind]: { state: "ready", revision: frame.revision, value },
        },
      };
      r.notify();
    } catch (cause) {
      r.staging.delete(frame.kind);
      o.diagnostic?.(cause);
      void refresh(r).catch((error) => o.diagnostic?.(error));
    }
  };
  return {
    acquire(directory) {
      if (stopped) throw new Error("Directory catalogs are stopped");
      let r = resources.get(directory);
      if (!r) {
        const store = (o.factory ?? createState)({ revision: 0 });
        const current: DirectoryCatalogState = {};
        const state: DirectoryCatalogState = {
          get catalog() {
            void store.state.revision;
            return current.catalog;
          },
        };
        r = {
          directory,
          refs: 0,
          alive: true,
          version: 0,
          current,
          state,
          staging: new Map(),
          retired: new Set(),
          notify: () =>
            store.update((s) => {
              s.revision++;
            }),
          subscribe: (f) => store.subscribe(f),
        };
        resources.set(directory, r);
        watch(r);
      }
      const resource = r;
      resource.refs++;
      let alive = true;
      const releases = new Set<() => void>();
      const subscribe = (f: () => void) => {
        const stop = resource.subscribe(f);
        releases.add(stop);
        return () => {
          stop();
          releases.delete(stop);
        };
      };
      const ready = async (kind?: keyof DirectoryCatalogKinds) => {
        await resource.work;
        if (!kind || !alive || !resource.alive) return;
        if (
          !resource.current.catalog?.values[kind] ||
          resource.current.catalog.values[kind]?.state !== "digesting"
        ) return;
        await new Promise<void>((resolve) => {
          const stop = subscribe(() => {
            if (
              !alive || !resource.alive ||
              resource.current.catalog?.values[kind]?.state !== "digesting"
            ) {
              stop();
              resolve();
            }
          });
        });
      };
      const lease: DirectoryCatalogLease = {
        state: resource.state,
        subscribe,
        ready,
        refresh: () => alive ? refresh(resource) : Promise.resolve(),
        view<K extends keyof DirectoryCatalogKinds>(
          kind: K,
          project?: (
            value: DirectoryCatalogKinds[K],
          ) => DirectoryCatalogKinds[K],
        ): CatalogOwner<DirectoryCatalogKinds[K]> {
          const state = (): CatalogState<DirectoryCatalogKinds[K]> => {
            const current = lease.state.catalog?.values[kind];
            return {
              available: !!current,
              loading: current?.state === "digesting",
              error: current?.failure
                ? "Choices are unavailable. Try refreshing."
                : "",
              value: current?.value === undefined
                ? undefined
                : project
                ? project(current.value)
                : current.value,
            };
          };
          return {
            get state() {
              return state();
            },
            subscribe: (f) => subscribe(() => f(state())),
            connect() {},
            ready: () => ready(kind),
            refresh: async () => {
              await lease.refresh();
              await ready(kind);
            },
            dispose() {},
          };
        },
        release() {
          if (!alive) return;
          alive = false;
          // Wake kind readiness before releasing this borrower's callbacks.
          resource.notify();
          for (const stop of releases) stop();
          releases.clear();
          if (--resource.refs === 0) retire(resource);
        },
      };
      return lease;
    },
    receive(frame) {
      if (stopped) return;
      if (frame.t === "welcome") {
        for (const r of resources.values()) {
          r.retired.clear();
          r.current.catalog = undefined;
          watch(r);
          r.notify();
        }
      } else if (frame.t === "catalog.snapshot") {
        const r = resources.get(frame.catalog.directory);
        if (r) install(r, frame.catalog);
      } else if (frame.t === "catalog.chunk") {
        const r = resources.get(frame.directory);
        if (r) chunk(r, frame);
      }
    },
    stop() {
      stopped = true;
      for (const r of resources.values()) retire(r);
    },
  };
}
