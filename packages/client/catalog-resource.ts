// SPDX-License-Identifier: LGPL-3.0-only
import { createState, type StateFactory } from "./state.ts";

export interface CatalogState<T> {
  value?: T;
  available: boolean;
  loading: boolean;
  error: string;
}
export interface CatalogConnection {
  key: unknown;
  connected: boolean;
  available: boolean;
}
/** One session/directory's resource, shared by all catalog consumers. */
export interface CatalogOwner<T> {
  readonly state: CatalogState<T>;
  subscribe(listener: (state: CatalogState<T>) => void): () => void;
  connect(connection?: CatalogConnection): void;
  ready(): Promise<void>;
  refresh(): Promise<void>;
  dispose(): void;
}

export function createCatalogResource<T>(options: {
  connection(): CatalogConnection;
  load(signal: AbortSignal): Promise<T>;
  factory?: StateFactory;
}): CatalogOwner<T> {
  let current: CatalogState<T> = {
    available: false,
    loading: false,
    error: "",
  };
  // Keep reads invocation-current even with a deferred framework notification.
  const store = (options.factory ?? createState)({ revision: 0 });
  const update = (change: (state: CatalogState<T>) => void) => {
    current = { ...current };
    change(current);
    store.update((state) => {
      state.revision++;
    });
  };
  let alive = true, generation = 0, attempted = -1;
  let connection: CatalogConnection | undefined;
  let pending: {
    generation: number;
    work: Promise<void>;
    abort: AbortController;
  } | undefined;
  let changed!: () => void;
  let invalidated = new Promise<void>((resolve) => {
    changed = resolve;
  });
  const refresh = (): Promise<void> => {
    if (!alive || !connection?.connected || !current.available) {
      return Promise.resolve();
    }
    if (pending?.generation === generation) return pending.work;
    const at = generation, abort = new AbortController();
    attempted = at;
    const work = Promise.resolve().then(() => {
      if (abort.signal.aborted) throw new Error("Catalog request cancelled");
      return options.load(abort.signal);
    }).then((value) => {
      connect();
      if (alive && at === generation) {
        update((state) => {
          state.value = value;
        });
      }
    }).catch((error: unknown) => {
      connect();
      if (alive && at === generation) {
        update((state) => {
          state.error = (error as Error).message;
        });
      }
    }).finally(() => {
      if (alive && at === generation) {
        pending = undefined;
        update((state) => {
          state.loading = false;
        });
      }
    });
    pending = { generation: at, work, abort };
    // Reserve the shared work before notifying synchronous consumers.
    update((state) => {
      state.loading = true;
      state.error = "";
    });
    return work;
  };
  const connect = (next = options.connection()) => {
    if (!alive) return;
    if (
      connection && Object.is(next.key, connection.key) &&
      next.connected === connection.connected &&
      next.available === connection.available
    ) return;
    connection = { ...next };
    generation++;
    pending?.abort.abort();
    pending = undefined;
    attempted = -1;
    changed();
    invalidated = new Promise<void>((resolve) => {
      changed = resolve;
    });
    update((state) => {
      state.available = next.available;
      state.loading = false;
      state.error = "";
    });
    void refresh();
  };
  return {
    get state() {
      void store.state.revision;
      return current;
    },
    subscribe: (listener) => store.subscribe(() => listener(current)),
    connect,
    async ready() {
      while (alive) {
        connect();
        if (!connection?.connected || !current.available) return;
        const at = generation;
        await Promise.race([
          pending?.generation === at
            ? pending.work
            : attempted === at
            ? Promise.resolve()
            : refresh(),
          invalidated,
        ]);
        connect();
        if (at === generation && !current.loading) return;
      }
    },
    refresh() {
      connect();
      return refresh();
    },
    dispose() {
      alive = false;
      generation++;
      pending?.abort.abort();
      pending = undefined;
      changed();
    },
  };
}
