// SPDX-License-Identifier: LGPL-3.0-only
import { createState, type StateFactory } from "./state.ts";
import type { ProjectSelection } from "./project-navigation.ts";

export interface ProjectPickerConnection {
  sidecarId: string;
  key: unknown;
  connected: boolean;
}
export interface ProjectPickerState {
  connected: boolean;
  paths: string[];
  loading: boolean;
  error: string;
}
export interface ProjectPickerOwner {
  readonly state: ProjectPickerState;
  subscribe(listener: (state: ProjectPickerState) => void): () => void;
  connect(connection?: ProjectPickerConnection): void;
  ready(): Promise<void>;
  refresh(): Promise<void>;
  add(project: ProjectSelection): Promise<void>;
  dispose(): void;
}

/** Directory discovery and captured add intent for one project-picker lifetime. */
export function createProjectPicker(options: {
  connection(): ProjectPickerConnection;
  scan(sidecarId: string, signal: AbortSignal): Promise<string[]>;
  add(sidecarId: string, directory: string): Promise<{ directory: string }>;
  open(project: ProjectSelection): void;
  close(): void;
  factory?: StateFactory;
}): ProjectPickerOwner {
  let current: ProjectPickerState = {
    connected: false,
    paths: [],
    loading: false,
    error: "",
  };
  const store = (options.factory ?? createState)({ revision: 0 });
  const update = (change: Partial<ProjectPickerState>) => {
    current = { ...current, ...change };
    store.update((state) => {
      state.revision++;
    });
  };
  let alive = true, generation = 0, attempted = -1;
  let connection: ProjectPickerConnection | undefined;
  let pending: { work: Promise<void>; abort: AbortController } | undefined;
  let addition: { project: ProjectSelection; work: Promise<void> } | undefined;
  let changed!: () => void;
  let invalidated = new Promise<void>((resolve) => {
    changed = resolve;
  });
  const refresh = (): Promise<void> => {
    if (!alive || !connection?.connected) return Promise.resolve();
    if (pending) return pending.work;
    const at = generation,
      sidecarId = connection.sidecarId,
      abort = new AbortController();
    attempted = at;
    const work = Promise.resolve().then(() => {
      if (abort.signal.aborted) throw new Error("Project scan cancelled");
      return options.scan(sidecarId, abort.signal);
    }).then((paths) => {
      connect();
      if (alive && at === generation) update({ paths: paths.slice() });
    }).catch((error: unknown) => {
      connect();
      if (alive && at === generation) {
        update({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }).finally(() => {
      if (alive && at === generation) {
        pending = undefined;
        update({ loading: false });
      }
    });
    pending = { work, abort };
    update({ loading: true, error: "" });
    return work;
  };
  const connect = (next = options.connection()) => {
    if (!alive) return;
    if (
      connection && next.sidecarId === connection.sidecarId &&
      Object.is(next.key, connection.key) &&
      next.connected === connection.connected
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
    update({ connected: next.connected, paths: [], loading: false, error: "" });
    void refresh();
  };
  return {
    get state(): ProjectPickerState {
      void store.state.revision;
      return current;
    },
    subscribe: (listener) => store.subscribe(() => listener(current)),
    connect,
    async ready() {
      while (alive) {
        connect();
        if (!connection?.connected) return;
        const at = generation;
        await Promise.race([
          pending?.work ?? (attempted === at ? Promise.resolve() : refresh()),
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
    add(input) {
      if (!alive) return Promise.reject(new Error("Project picker is closed"));
      const project = { ...input, directory: input.directory.trim() };
      if (addition) {
        return project.sidecarId === addition.project.sidecarId &&
            project.directory === addition.project.directory
          ? addition.work
          : Promise.reject(
            new Error("Project addition is already in progress"),
          );
      }
      const work = Promise.resolve().then(() => {
        if (!alive) return;
        return options.add(project.sidecarId, project.directory);
      }).then((added) => {
        if (!alive || !added) return;
        options.open({
          sidecarId: project.sidecarId,
          directory: added.directory,
        });
        options.close();
      }).finally(() => {
        addition = undefined;
      });
      addition = { project, work };
      return work;
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
