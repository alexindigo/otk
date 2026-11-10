// SPDX-License-Identifier: LGPL-3.0-only
import type { ProviderReadPort } from "./provider-reads.ts";
import type {
  CatalogValue,
  DirectoryCatalog,
  DirectoryCatalogKinds,
} from "@otk/protocol";
import { CatalogFiles } from "./catalog-files.ts";

export type CatalogContributions = {
  [K in keyof DirectoryCatalogKinds]?: (
    directory: string,
    signal: AbortSignal,
    owner: string,
  ) => Promise<DirectoryCatalogKinds[K]>;
};
interface KindState {
  state: CatalogValue<unknown>;
  dirty: boolean;
  work?: Promise<unknown>;
}
interface Resource {
  directory: string;
  generation: string;
  revision: number;
  refs: number;
  owner: string;
  controller: AbortController;
  kinds: Map<keyof DirectoryCatalogKinds, KindState>;
  listeners: Set<() => void>;
  files?: CatalogFiles;
  watcher?: { close(): void };
  watch?: Promise<void>;
  watchFailure?: unknown;
  fileRefs: number;
  fileEpoch: number;
  fileController: AbortController;
}
export interface CatalogLease {
  snapshot(): DirectoryCatalog;
  subscribe(listener: () => void): () => void;
  get<K extends keyof DirectoryCatalogKinds>(
    kind: K,
    signal?: AbortSignal,
  ): Promise<DirectoryCatalogKinds[K]>;
  refresh(signal?: AbortSignal): Promise<void>;
  release(): void;
}
export interface DirectoryCatalogOptions {
  pending: number;
  contributions?: CatalogContributions;
  /** Only project file discovery is filesystem-driven. Native config is event-driven. */
  watchFiles?: boolean;
  watch?: (paths: readonly string[]) => Deno.FsWatcher;
  diagnostic?: (error: unknown) => void;
}
function detached<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work.then((value) => structuredClone(value));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void work.then((value) => {
      signal.removeEventListener("abort", abort);
      if (!signal.aborted) resolve(structuredClone(value));
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}
/** One canonical volatile value per directory/kind, borrowed by every consumer. */
export class DirectoryCatalogs {
  #resources = new Map<string, Resource>();
  #legacy = new Map<string, CatalogLease>();
  #callers = new Map<string, number>();
  #pending = new Set<Promise<unknown>>();
  #contributions: CatalogContributions;
  constructor(
    readonly reads: ProviderReadPort,
    readonly options: DirectoryCatalogOptions,
  ) {
    this.#contributions = {
      agents: (directory, signal, owner) =>
        reads.read("catalog.agents", { directory }, {
          owner,
          priority: "visible",
          signal,
        }),
      commands: (directory, signal, owner) =>
        reads.read("catalog.commands", { directory }, {
          owner,
          priority: "visible",
          signal,
        }),
      skills: (directory, signal, owner) =>
        reads.read("catalog.skills", { directory }, {
          owner,
          priority: "visible",
          signal,
        }),
      models: (directory, signal, owner) =>
        reads.read("catalog.models", { directory }, {
          owner,
          priority: "visible",
          signal,
        }),
      resources: (directory, signal, owner) =>
        reads.read("catalog.resources", { directory }, {
          owner,
          priority: "visible",
          signal,
        }),
      files: (directory, signal) =>
        this.#resources.get(directory)!.files!.read(signal),
      ...options.contributions,
    };
  }
  get size(): number {
    return this.#resources.size;
  }
  /** Last complete native value, including while refreshing; never a readiness signal or new demand. */
  peek<K extends keyof DirectoryCatalogKinds>(
    directory: string,
    kind: K,
  ): DirectoryCatalogKinds[K] | undefined {
    const item = this.#resources.get(directory)?.kinds.get(kind);
    if (!item || item.state.value === undefined) return;
    return structuredClone(item.state.value) as DirectoryCatalogKinds[K];
  }
  acquire(directory: string): CatalogLease {
    let resource = this.#resources.get(directory);
    if (!resource) {
      const owner = JSON.stringify([
        "directory",
        directory,
        crypto.randomUUID(),
      ]);
      resource = {
        directory,
        owner,
        generation: crypto.randomUUID(),
        revision: 0,
        refs: 0,
        fileRefs: 0,
        fileEpoch: 0,
        fileController: new AbortController(),
        controller: new AbortController(),
        kinds: new Map(),
        listeners: new Set(),
      };
      resource.files = new CatalogFiles(
        directory,
        this.reads,
        owner,
        this.options.pending,
      );
      this.#resources.set(directory, resource);
    }
    resource.refs++;
    const value = resource;
    let live = true;
    let files = false;
    const listeners = new Set<() => void>();
    const check = () => {
      if (!live || value.controller.signal.aborted) {
        throw new DOMException("Catalog lease released", "AbortError");
      }
    };
    return {
      snapshot: () => {
        check();
        return this.#snapshot(value);
      },
      subscribe: (listener) => {
        check();
        value.listeners.add(listener);
        listeners.add(listener);
        return () => {
          value.listeners.delete(listener);
          listeners.delete(listener);
        };
      },
      get: async (kind, signal) => {
        check();
        if (kind === "files" && !files) {
          files = true;
          if (value.fileRefs++ === 0) {
            value.fileController = new AbortController();
          }
        }
        return await detached(this.#get(value, kind), signal);
      },
      refresh: async (signal) => {
        check();
        signal?.throwIfAborted();
        this.invalidate(directory);
        await detached(
          Promise.all(
            [...value.kinds.keys()].map((kind) => this.#get(value, kind)),
          ),
          signal,
        );
      },
      release: () => {
        if (!live) return;
        live = false;
        for (const listener of listeners) value.listeners.delete(listener);
        listeners.clear();
        if (files && --value.fileRefs === 0) {
          value.fileEpoch++;
          value.fileController.abort();
          value.watcher?.close();
          value.watcher = undefined;
          value.watch = undefined;
          value.watchFailure = undefined;
          value.kinds.delete("files");
          value.files = new CatalogFiles(
            value.directory,
            this.reads,
            value.owner,
            this.options.pending,
          );
        }
        if (--value.refs === 0) this.#retire(value);
      },
    };
  }
  /** Compatibility facades borrow one retained directory lease, not a session cache. */
  async get<K extends keyof DirectoryCatalogKinds>(
    directory: string,
    kind: K,
    signal?: AbortSignal,
  ): Promise<DirectoryCatalogKinds[K]> {
    signal?.throwIfAborted();
    let lease = this.#legacy.get(directory);
    if (!lease) this.#legacy.set(directory, lease = this.acquire(directory));
    this.#callers.set(directory, (this.#callers.get(directory) ?? 0) + 1);
    try {
      return await lease.get(kind, signal);
    } finally {
      const callers = (this.#callers.get(directory) ?? 1) - 1;
      if (callers) this.#callers.set(directory, callers);
      else {
        this.#callers.delete(directory);
        const resource = this.#resources.get(directory);
        if (
          resource &&
          ![...resource.kinds.values()].some((item) =>
            item.state.value !== undefined
          )
        ) {
          if (this.#legacy.get(directory) === lease) {
            this.#legacy.delete(directory);
            lease.release();
          }
        }
      }
    }
  }
  #snapshot(resource: Resource): DirectoryCatalog {
    return structuredClone({
      directory: resource.directory,
      generation: resource.generation,
      revision: resource.revision,
      paths: Deno.build.os === "windows"
        ? { style: "win32", separator: "\\" }
        : { style: "posix", separator: "/" },
      values: Object.fromEntries(
        (Object.keys(this.#contributions) as (keyof DirectoryCatalogKinds)[])
          .filter((kind) => !!this.#contributions[kind])
          .map((
            kind,
          ) => [
            kind,
            resource.kinds.get(kind)?.state ??
              { state: "digesting", revision: 0 },
          ]),
      ),
    }) as DirectoryCatalog;
  }
  #publish(resource: Resource): void {
    if (resource.controller.signal.aborted) return;
    resource.revision++;
    for (const listener of resource.listeners) {
      try {
        listener();
      } catch (error) {
        this.options.diagnostic?.(error);
      }
    }
  }
  #get<K extends keyof DirectoryCatalogKinds>(
    resource: Resource,
    kind: K,
  ): Promise<DirectoryCatalogKinds[K]> {
    const acquire = this.#contributions[kind];
    if (!acquire) return Promise.reject(new Error("Catalog kind not selected"));
    if (
      kind === "files" && !resource.watch &&
      (this.options.watch || this.options.watchFiles)
    ) {
      const watch = this.#watch(resource).finally(() => {
        if (resource.watch === watch) resource.watch = undefined;
      });
      resource.watch = watch;
    }
    let item = resource.kinds.get(kind);
    if (!item) {
      item = { state: { state: "digesting", revision: 0 }, dirty: true };
      resource.kinds.set(kind, item);
    }
    if (!item.dirty && item.state.state === "ready") {
      return Promise.resolve(item.state.value as DirectoryCatalogKinds[K]);
    }
    const current = item;
    if (!current.work) {
      const controller = resource.controller, owner = resource.owner;
      const signal = kind === "files"
        ? AbortSignal.any([controller.signal, resource.fileController.signal])
        : controller.signal;
      const work = Promise.resolve().then(async () => {
        do {
          signal.throwIfAborted();
          current.dirty = false;
          current.state = {
            ...current.state,
            state: "digesting",
            failure: undefined,
          };
          this.#publish(resource);
          try {
            const value = await acquire(
              resource.directory,
              signal,
              owner,
            );
            signal.throwIfAborted();
            if (kind === "files" && resource.watchFailure) {
              throw resource.watchFailure;
            }
            if (!current.dirty) {
              current.state = {
                state: "ready",
                revision: current.state.revision + 1,
                value,
              };
              this.#publish(resource);
            }
          } catch (error) {
            signal.throwIfAborted();
            current.state = {
              ...current.state,
              state: "unavailable",
              failure: {
                code: "native.unavailable",
                retry: "same-intent",
                diagnosticID: crypto.randomUUID(),
              },
            };
            this.options.diagnostic?.(error);
            this.#publish(resource);
            throw error;
          }
        } while (current.dirty);
        return current.state.value;
      }).finally(() => {
        if (current.work === work) current.work = undefined;
      });
      current.work = work;
      this.#pending.add(work);
      void work.then(
        () => this.#pending.delete(work),
        () => this.#pending.delete(work),
      );
    }
    return current.work as Promise<DirectoryCatalogKinds[K]>;
  }
  invalidate(
    directory: string,
    kinds?: readonly (keyof DirectoryCatalogKinds)[],
    paths?: readonly string[],
  ): void {
    const resource = this.#resources.get(directory);
    if (!resource) return; // Idle directories are never bootstrapped by invalidation.
    if (!kinds || kinds.includes("files")) resource.files?.invalidate(paths);
    for (const [kind, item] of resource.kinds) {
      if (kinds && !kinds.includes(kind)) continue;
      item.dirty = true;
      if (!item.work) {
        void this.#get(resource, kind).catch(
          () => {/* the resource publishes unavailable */},
        );
      }
    }
  }
  invalidateAll(kinds?: readonly (keyof DirectoryCatalogKinds)[]): void {
    for (const directory of this.#resources.keys()) {
      this.invalidate(directory, kinds);
    }
  }
  update<K extends keyof DirectoryCatalogKinds>(
    directory: string,
    kind: K,
    value: DirectoryCatalogKinds[K],
  ): void {
    const resource = this.#resources.get(directory),
      item = resource?.kinds.get(kind);
    if (!resource || !item) return;
    item.state = {
      state: "ready",
      revision: item.state.revision + 1,
      value: structuredClone(value),
    };
    this.#publish(resource);
  }
  /** Native lifecycle authority renews values while preserving borrowed leases. */
  reset(directory?: string): void {
    for (const resource of this.#resources.values()) {
      if (directory !== undefined && resource.directory !== directory) continue;
      resource.controller.abort();
      this.reads.release(resource.owner);
      resource.controller = new AbortController();
      resource.generation = crypto.randomUUID();
      resource.owner = JSON.stringify([
        "directory",
        resource.directory,
        resource.generation,
      ]);
      resource.revision = 0;
      resource.files = new CatalogFiles(
        resource.directory,
        this.reads,
        resource.owner,
        this.options.pending,
      );
      for (const item of resource.kinds.values()) {
        item.dirty = true;
        item.work = undefined;
        item.state = { ...item.state, state: "digesting" };
      }
      this.#publish(resource);
      for (const kind of resource.kinds.keys()) {
        void this.#get(resource, kind).catch(
          () => {/* resource owns unavailable state */},
        );
      }
    }
  }
  async #watch(resource: Resource): Promise<void> {
    let reconcile = false;
    const epoch = resource.fileEpoch;
    const retired = () =>
      resource.controller.signal.aborted || !resource.fileRefs ||
      resource.fileEpoch !== epoch;
    for (;;) {
      if (retired()) return;
      let watcher: Deno.FsWatcher;
      try {
        watcher = (this.options.watch ?? ((paths) =>
          Deno.watchFs([...paths], { recursive: true })))([resource.directory]);
        resource.watchFailure = undefined;
      } catch (error) {
        resource.watchFailure = error;
        resource.files?.invalidate();
        const item = resource.kinds.get("files");
        if (item) {
          item.dirty = true;
          item.state = {
            ...item.state,
            state: "unavailable",
            failure: {
              code: "native.unavailable",
              retry: "same-intent",
              diagnosticID: crypto.randomUUID(),
            },
          };
        }
        this.options.diagnostic?.(error);
        this.#publish(resource);
        return;
      }
      resource.watcher = watcher;
      if (reconcile) this.invalidate(resource.directory, ["files"]);
      try {
        for await (const event of watcher) {
          if (retired()) return;
          const ignore = event.paths.some((path) =>
            /(?:^|[/\\])(?:\.gitignore|\.ignore)$/.test(path)
          );
          this.invalidate(
            resource.directory,
            ["files"],
            event.kind === "other" || ignore ? undefined : event.paths,
          );
        }
        if (retired()) return;
        throw new Error("File watch ended before its demand lifetime");
      } catch (error) {
        if (retired()) return;
        this.options.diagnostic?.(error);
        resource.files?.invalidate();
        reconcile = true;
      } finally {
        if (resource.watcher === watcher) {
          resource.watcher = undefined;
          watcher.close();
        }
      }
    }
  }
  #retire(resource: Resource): void {
    if (resource.controller.signal.aborted) return;
    if (this.#resources.get(resource.directory) === resource) {
      this.#resources.delete(resource.directory);
    }
    resource.controller.abort();
    const watcher = resource.watcher;
    resource.watcher = undefined;
    watcher?.close();
    this.reads.release(resource.owner);
    resource.listeners.clear();
    resource.kinds.clear();
  }
  dispose(directory?: string): void {
    for (const [key, resource] of this.#resources) {
      if (directory === undefined || key === directory) {
        this.#legacy.delete(key);
        this.#retire(resource);
      }
    }
  }
  async stop(): Promise<void> {
    const tasks = [...this.#resources.values()].map((resource) =>
      resource.watch
    );
    this.dispose();
    await Promise.allSettled([...tasks, ...this.#pending]);
  }
}
