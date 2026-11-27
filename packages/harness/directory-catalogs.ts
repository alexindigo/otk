// SPDX-License-Identifier: LGPL-3.0-only
import type { ProviderReadPort } from "./provider-reads.ts";
import { preserveFailure } from "@otk/protocol";
import type {
  CatalogDemand,
  CatalogDemandIntent,
  CatalogValue,
  DirectoryCatalog,
  DirectoryCatalogKinds,
} from "@otk/protocol";
import { CatalogFiles } from "./catalog-files.ts";
import { CatalogFileWatch } from "./catalog-file-watch.ts";

export type CatalogContributions = {
  [K in keyof DirectoryCatalogKinds]?: (
    directory: string,
    signal: AbortSignal,
    owner: string,
    intent: CatalogDemandIntent,
  ) => Promise<DirectoryCatalogKinds[K]>;
};
interface KindState {
  state: CatalogValue<unknown>;
  dirty: boolean;
  work?: Promise<unknown>;
  intent: CatalogDemandIntent;
  acquisition?: AbortController;
}
const promoted = Symbol("catalog consumer demand");
interface Resource {
  directory: string;
  generation: string;
  revision: number;
  refs: number;
  subscriptions: number;
  owner: string;
  controller: AbortController;
  kinds: Map<keyof DirectoryCatalogKinds, KindState>;
  listeners: Set<() => void>;
  files?: CatalogFiles;
  observation?: CatalogFileWatch;
  fileRefs: number;
  fileObservers: number;
  fileController: AbortController;
}
export interface CatalogLease {
  snapshot(): DirectoryCatalog;
  subscribe(listener: () => void): () => void;
  get<K extends keyof DirectoryCatalogKinds>(
    kind: K,
    signal?: AbortSignal,
    intent?: CatalogDemandIntent,
  ): Promise<DirectoryCatalogKinds[K]>;
  refresh(
    signal?: AbortSignal,
    kinds?: readonly (keyof DirectoryCatalogKinds)[],
  ): Promise<void>;
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
      agents: (directory, signal, owner, intent) =>
        reads.read("catalog.agents", { directory }, {
          owner,
          priority: intent === "warm" ? "background" : "user",
          signal,
        }),
      commands: (directory, signal, owner, intent) =>
        reads.read("catalog.commands", { directory }, {
          owner,
          priority: intent === "warm" ? "background" : "user",
          signal,
        }),
      skills: (directory, signal, owner, intent) =>
        reads.read("catalog.skills", { directory }, {
          owner,
          priority: intent === "warm" ? "background" : "user",
          signal,
        }),
      models: (directory, signal, owner, intent) =>
        reads.read("catalog.models", { directory }, {
          owner,
          priority: intent === "warm" ? "background" : "user",
          signal,
        }),
      resources: (directory, signal, owner, intent) =>
        reads.read("catalog.resources", { directory }, {
          owner,
          priority: intent === "warm" ? "background" : "user",
          signal,
        }),
      files: (directory, signal, _owner, intent) =>
        this.#resources.get(directory)!.files!.read(
          signal,
          intent === "warm" ? "background" : "user",
          this.#resources.get(directory)!.observation,
        ),
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
  acquire(
    directory: string,
    subscription = false,
    fileMode: "observe" | "read" | "retain" = subscription ? "read" : "observe",
  ): CatalogLease {
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
        subscriptions: 0,
        fileRefs: 0,
        fileObservers: 0,
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
    if (subscription) resource.subscriptions++;
    const value = resource;
    let live = true;
    let files = false;
    const observe = fileMode !== "read";
    const borrowFiles = () => {
      if (files) return;
      files = true;
      if (value.fileRefs++ === 0) value.fileController = new AbortController();
      if (observe && value.fileObservers++ === 0 && value.kinds.has("files")) {
        value.files?.invalidate();
        value.kinds.get("files")!.dirty = true;
      }
    };
    if (fileMode === "retain") borrowFiles();
    const listeners = new Set<() => void>();
    const check = () => {
      if (!live || value.controller.signal.aborted) {
        throw new DOMException("Catalog lease released", "AbortError");
      }
    };
    const read = <K extends keyof DirectoryCatalogKinds>(
      kind: K,
      intent: CatalogDemandIntent = "consumer",
    ): Promise<DirectoryCatalogKinds[K]> => {
      check();
      if (kind === "files") borrowFiles();
      return this.#get(value, kind, intent);
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
      get: async (kind, signal, intent = "consumer") => {
        return await detached(read(kind, intent), signal);
      },
      refresh: async (signal, kinds) => {
        check();
        signal?.throwIfAborted();
        const selected = kinds ?? [...value.kinds.keys()];
        this.invalidate(directory, selected);
        await detached(
          Promise.all(
            selected.map((kind) => read(kind, "consumer")),
          ),
          signal,
        );
      },
      release: () => {
        if (!live) return;
        live = false;
        for (const listener of listeners) value.listeners.delete(listener);
        listeners.clear();
        if (files) this.#releaseFiles(value, observe);
        if (subscription) value.subscriptions--;
        if (--value.refs === 0) this.#retire(value);
      },
    };
  }
  retainFiles(directory: string, signal: AbortSignal): DirectoryCatalog {
    signal.throwIfAborted();
    const lease = this.acquire(directory, false, "retain");
    signal.addEventListener("abort", lease.release, { once: true });
    return lease.snapshot();
  }

  /** File demand never upgrades a passive directory subscription into an observer. */
  async demand(
    directory: string,
    demand: CatalogDemand,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const resource = this.#resources.get(directory);
    const lease = this.acquire(directory, false, "read");
    try {
      await detached(
        Promise.all(
          demand.kinds.map((kind) =>
            kind !== "files" && resource?.subscriptions
              ? this.#get(resource, kind, demand.intent)
              : lease.get(kind, signal, demand.intent)
          ),
        ),
        signal,
      );
    } finally {
      lease.release();
    }
  }
  async get<K extends keyof DirectoryCatalogKinds>(
    directory: string,
    kind: K,
    signal?: AbortSignal,
  ): Promise<DirectoryCatalogKinds[K]> {
    signal?.throwIfAborted();
    if (kind === "files") {
      const lease = this.acquire(directory, false, "read");
      try {
        return await lease.get(kind, signal);
      } finally {
        lease.release();
      }
    }
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
  #releaseFiles(resource: Resource, observe: boolean): void {
    if (observe && --resource.fileObservers === 0) {
      resource.observation?.close();
      resource.observation = undefined;
    }
    if (--resource.fileRefs !== 0) return;
    resource.fileController.abort();
    resource.kinds.delete("files");
    resource.files = new CatalogFiles(
      resource.directory,
      this.reads,
      resource.owner,
      this.options.pending,
    );
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
    intent?: CatalogDemandIntent,
  ): Promise<DirectoryCatalogKinds[K]> {
    const acquire = this.#contributions[kind];
    if (!acquire) return Promise.reject(new Error("Catalog kind not selected"));
    if (
      kind === "files" && resource.fileObservers && !resource.observation &&
      (this.options.watch || this.options.watchFiles)
    ) {
      resource.observation = new CatalogFileWatch(
        resource.directory,
        (paths) => this.invalidate(resource.directory, ["files"], paths),
        (work) => this.#track(work),
        this.options.diagnostic,
        this.options.watch,
      );
    }
    let item = resource.kinds.get(kind);
    if (!item) {
      item = {
        state: { state: "digesting", revision: 0 },
        dirty: true,
        intent: intent ?? "consumer",
      };
      resource.kinds.set(kind, item);
    }
    if (intent === "consumer" && item.intent === "warm") {
      item.intent = "consumer";
      item.acquisition?.abort(promoted);
    }
    if (
      kind === "files" && intent && !item.work && resource.observation?.degraded
    ) {
      resource.files?.invalidate();
      item.dirty = true;
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
          const acquisition = new AbortController();
          current.acquisition = acquisition;
          const attempt = AbortSignal.any([signal, acquisition.signal]);
          try {
            const value = await acquire(
              resource.directory,
              attempt,
              owner,
              current.intent,
            );
            attempt.throwIfAborted();
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
            if (acquisition.signal.reason === promoted) {
              current.dirty = true;
              continue;
            }
            current.state = {
              ...current.state,
              state: "unavailable",
              failure: preserveFailure(error, {
                code: "native.unavailable",
                retry: "same-intent",
                diagnosticID: crypto.randomUUID(),
              }),
            };
            this.options.diagnostic?.(error);
            this.#publish(resource);
            throw error;
          } finally {
            if (current.acquisition === acquisition) {
              current.acquisition = undefined;
            }
          }
        } while (current.dirty);
        return current.state.value;
      }).finally(() => {
        if (current.work === work) current.work = undefined;
      });
      current.work = work;
      this.#track(work);
    }
    return current.work as Promise<DirectoryCatalogKinds[K]>;
  }
  #track(work: Promise<unknown>): void {
    this.#pending.add(work);
    void work.then(
      () => this.#pending.delete(work),
      () => this.#pending.delete(work),
    );
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
  #retire(resource: Resource): void {
    if (resource.controller.signal.aborted) return;
    if (this.#resources.get(resource.directory) === resource) {
      this.#resources.delete(resource.directory);
    }
    resource.controller.abort();
    resource.observation?.close();
    resource.observation = undefined;
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
    this.dispose();
    await Promise.allSettled(this.#pending);
  }
}
