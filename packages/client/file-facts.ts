// SPDX-License-Identifier: LGPL-3.0-only
import {
  type FileFact,
  type InlineImageFact,
  MAX_STAT_PATHS,
} from "@otk/protocol";
import { RequestFailure } from "./failures.ts";
import type { ClientImageFailure } from "./inline-images.ts";
import { createState, type StateFactory } from "./state.ts";

type RpcPort<M extends string, Fact> = {
  call(
    method: M,
    params: { sessionID: string; paths: string[] },
    signal?: AbortSignal,
  ): Promise<Fact[]>;
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
type FactLease<T> = Accessor<T | undefined> & { release(): void };
export type ImageFactLease = FactLease<InlineImageFact | ClientImageFailure>;
export interface FileFacts {
  fact(sessionID: string, path: string): FactLease<FileFact>;
  invalidate(sessionID: string, path: string): void;
  image(sessionID: string, path: string): ImageFactLease;
  imageFailed(sessionID: string, path: string): void;
  readonly supported: Accessor<boolean>;
  stop(): void;
}

const keyFor = (sessionID: string, path: string) => `${sessionID}\0${path}`;
type Demand = {
  key: string;
  sessionID: string;
  path: string;
  afterFailure: boolean;
};
type Settings = {
  factory?: StateFactory;
  diagnostic?: (error: unknown) => void;
};
const unsupported: ClientImageFailure = {
  status: "unavailable",
  reason: "unsupported",
};
const loadFailed: ClientImageFailure = {
  status: "unavailable",
  reason: "load-failed",
};

/** One sidecar's cache. Mounted cells outlive cache eviction, not their consumers. */
export function createFileFacts(
  rpc: RpcPort<"file.stat", FileFact>,
  clock = clockDefault,
  options: Settings & { images?: RpcPort<"file.images", InlineImageFact> } = {},
): FileFacts {
  const stat = batchCache("file.stat", rpc, clock, options, {
    ttl: (fact) => fact.status === "absent" ? 10_000 : 60_000,
  });
  const images = batchCache("file.images", options.images, clock, options, {
    ttl: (fact) => fact.status === "unavailable" ? 10_000 : 60_000,
    unsupported,
    recover: (fact) => fact?.status === "unavailable" ? fact : loadFailed,
    retryable: (fact) => fact.status === "image",
  });
  return {
    supported: stat.supported,
    fact: stat.fact,
    invalidate: stat.invalidate,
    image: images.fact,
    imageFailed: images.failed,
    stop() {
      stat.stop();
      images.stop();
    },
  };
}

function batchCache<
  M extends string,
  Fact extends { path: string; status: string },
  Failure = never,
>(
  method: M,
  rpc: RpcPort<M, Fact> | undefined,
  clock: Clock,
  options: Settings,
  policy: {
    ttl(fact: Fact | Failure): number;
    unsupported?: Failure;
    recover?(fact?: Fact): Fact | Failure;
    retryable?(fact: Fact | Failure): boolean;
  },
) {
  const factory = options.factory ?? createState;
  const lifetime = factory({ supported: !!rpc, stopped: false });
  const state = () => factory<{ fact?: Fact | Failure }>({});
  const cells = new Map<
    string,
    { users: number; value: ReturnType<typeof state> }
  >();
  const cache = new Map<string, { fact: Fact | Failure; expires: number }>();
  const pending = new Map<string, Demand>(),
    inFlight = new Map<string, Demand>();
  const active = new AbortController();
  let unschedule: (() => void) | undefined;
  const supported = () => lifetime.state.supported && !lifetime.state.stopped;
  const publish = (key: string, fact: Fact | Failure | undefined) => {
    cells.get(key)?.value.update((draft) => {
      draft.fact = fact;
    });
  };
  const remember = (key: string, fact: Fact | Failure) => {
    cache.delete(key);
    cache.set(key, {
      fact,
      expires: clock.now() + policy.ttl(fact),
    });
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  };
  const settle = (demand: Demand, fact?: Fact) => {
    if (inFlight.get(demand.key) !== demand) return;
    inFlight.delete(demand.key);
    if (!supported()) return;
    if (fact?.path !== demand.path || fact.status === "unknown") {
      fact = undefined;
    }
    const settled = demand.afterFailure ? policy.recover?.(fact) : fact;
    if (settled) remember(demand.key, settled);
    publish(demand.key, settled);
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
      const facts = await rpc!.call(method, {
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
  const demand = (
    key: string,
    sessionID: string,
    path: string,
    afterFailure = false,
  ) => {
    if (!supported() || pending.has(key) || inFlight.has(key)) return;
    pending.set(key, { key, sessionID, path, afterFailure });
    unschedule ??= clock.schedule(flush);
  };
  return {
    supported,
    fact(sessionID: string, path: string): FactLease<Fact | Failure> {
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
        () =>
          lifetime.state.stopped
            ? undefined
            : supported()
            ? owned.value.state.fact
            : policy.unsupported,
        {
          release() {
            if (released) return;
            released = true;
            if (!--owned.users) cells.delete(key);
          },
        },
      );
    },
    invalidate(sessionID: string, path: string) {
      const key = keyFor(sessionID, path);
      cache.delete(key);
      inFlight.delete(key);
      publish(key, undefined);
      if (cells.has(key)) demand(key, sessionID, path);
    },
    failed(sessionID: string, path: string) {
      const key = keyFor(sessionID, path);
      if (!cells.has(key) || pending.has(key) || inFlight.has(key)) return;
      const current = cells.get(key)?.value.state.fact;
      if (!current || !policy.retryable?.(current)) return;
      cache.delete(key);
      publish(key, undefined);
      demand(key, sessionID, path, true);
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
