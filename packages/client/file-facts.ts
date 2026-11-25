// SPDX-License-Identifier: LGPL-3.0-only
import { type FileFact, MAX_STAT_PATHS } from "@otk/protocol";
import { RequestFailure } from "./failures.ts";
import { createState, type StateFactory } from "./state.ts";

type RpcPort = {
  call(
    method: "file.stat",
    params: { sessionID: string; paths: string[] },
    signal?: AbortSignal,
  ): Promise<FileFact[]>;
};
type Clock = { now(): number; schedule(run: () => void): () => void };
const clockDefault: Clock = {
  now: () => performance.now(),
  schedule(run) {
    const timer = setTimeout(run, 0);
    return () => clearTimeout(timer);
  },
};
const MAX_ENTRIES = 1024;
type Accessor<T> = () => T;
type FactLease = Accessor<FileFact | undefined> & { release(): void };
export interface FileFacts {
  fact(sessionID: string, path: string): FactLease;
  invalidate(sessionID: string, path: string): void;
  readonly supported: Accessor<boolean>;
  stop(): void;
}

const keyFor = (sessionID: string, path: string) => `${sessionID}\0${path}`;
type Demand = { key: string; sessionID: string; path: string };

/** One sidecar's cache. Mounted cells outlive cache eviction, not their consumers. */
export function createFileFacts(
  rpc: RpcPort,
  clock = clockDefault,
  options: { factory?: StateFactory; diagnostic?: (error: unknown) => void } =
    {},
): FileFacts {
  const factory = options.factory ?? createState;
  const lifetime = factory({ supported: true, stopped: false });
  const state = () => factory<{ fact?: FileFact }>({});
  const cells = new Map<
    string,
    { users: number; value: ReturnType<typeof state> }
  >();
  const cache = new Map<string, { fact: FileFact; expires: number }>();
  const pending = new Map<string, Demand>(),
    inFlight = new Map<string, Demand>();
  const active = new AbortController();
  let unschedule: (() => void) | undefined;
  const supported = () => lifetime.state.supported && !lifetime.state.stopped;
  const publish = (key: string, fact: FileFact | undefined) => {
    cells.get(key)?.value.update((draft) => {
      draft.fact = fact;
    });
  };
  const remember = (key: string, fact: FileFact) => {
    cache.delete(key);
    cache.set(key, {
      fact,
      expires: clock.now() + (fact.status === "absent" ? 10_000 : 60_000),
    });
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  };
  const settle = (demand: Demand, fact?: FileFact) => {
    if (inFlight.get(demand.key) !== demand) return;
    inFlight.delete(demand.key);
    if (!supported()) return;
    if (fact?.path !== demand.path || fact.status === "unknown") {
      fact = undefined;
    }
    if (fact) remember(demand.key, fact);
    publish(demand.key, fact);
  };
  const retire = () => {
    unschedule?.();
    unschedule = undefined;
    pending.clear();
    inFlight.clear();
    cache.clear();
    active.abort();
  };
  const send = async (sessionID: string, group: Demand[]) => {
    try {
      const facts = await rpc.call("file.stat", {
        sessionID,
        paths: group.map((demand) => demand.path),
      }, active.signal);
      if (!supported()) return;
      if (facts.some((fact) => fact.status === "unknown")) {
        options.diagnostic?.(new Error("Local file checks timed out"));
      }
      group.forEach((demand, index) => settle(demand, facts[index]));
    } catch (cause) {
      if (!supported()) return;
      if (cause instanceof RequestFailure && cause.failure.code === "method") {
        lifetime.update((draft) => {
          draft.supported = false;
        });
        retire();
      } else {
        group.forEach((demand) => settle(demand));
        options.diagnostic?.(cause);
      }
    }
  };
  const flush = () => {
    unschedule = undefined;
    const sessions = new Map<string, Demand[]>();
    for (const demand of pending.values()) {
      const bySession = sessions.get(demand.sessionID) ?? [];
      bySession.push(demand);
      sessions.set(demand.sessionID, bySession);
      inFlight.set(demand.key, demand);
    }
    pending.clear();
    for (const [id, demands] of sessions) {
      for (let i = 0; i < demands.length; i += MAX_STAT_PATHS) {
        void send(id, demands.slice(i, i + MAX_STAT_PATHS));
      }
    }
  };
  const demand = (key: string, sessionID: string, path: string) => {
    if (!supported() || pending.has(key) || inFlight.has(key)) return;
    pending.set(key, { key, sessionID, path });
    unschedule ??= clock.schedule(flush);
  };
  return {
    supported,
    fact(sessionID, path) {
      const key = keyFor(sessionID, path);
      let cell = cells.get(key);
      if (!cell) cells.set(key, cell = { users: 0, value: state() });
      cell.users++;
      const existing = cache.get(key);
      if (existing) cache.delete(key);
      if (existing && clock.now() < existing.expires) {
        cache.set(key, existing);
        if (cell.value.state.fact !== existing.fact) {
          publish(key, existing.fact);
        }
      } else demand(key, sessionID, path);
      const owned = cell;
      let released = false;
      return Object.assign(
        () => supported() ? owned.value.state.fact : undefined,
        {
          release() {
            if (released) return;
            released = true;
            if (!--owned.users) cells.delete(key);
          },
        },
      );
    },
    invalidate(sessionID, path) {
      const key = keyFor(sessionID, path);
      cache.delete(key);
      inFlight.delete(key);
      publish(key, undefined);
      if (cells.has(key)) demand(key, sessionID, path);
    },
    stop() {
      lifetime.update((draft) => {
        draft.stopped = true;
      });
      retire();
      cells.clear();
    },
  };
}
