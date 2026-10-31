// SPDX-License-Identifier: LGPL-3.0-only
import {
  type IndexEntry,
  isAttentionOp,
  type MessagePolicy,
  messagePolicy,
  type ServerFrame,
} from "@otk/protocol";
import type { SidecarConnection } from "./connection.ts";
import { sessionKey } from "./index.ts";
import type { IndexChanges } from "./index.ts";
import { createTranscript, type TranscriptOwner } from "./transcript.ts";
import { createState, type StateFactory } from "./state.ts";

export interface BodyTarget {
  sidecarId: string;
  sessionID: string;
}
export interface ScopeRef {
  sidecarId: string;
  directory: string;
  taskID?: string;
}
export type Temperature = "screen" | "warm" | "cold";
export interface TranscriptDemand {
  scope?: ScopeRef;
  sessions: readonly BodyTarget[];
  selected?: BodyTarget;
}
export interface TranscriptRange {
  first: string;
  last: string;
}
export interface TranscriptClock {
  now(): number;
  set(run: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}
export interface TranscriptsOwner {
  setDemand(value: TranscriptDemand): void;
  interact(scope: ScopeRef): void;
  preload(
    target: BodyTarget,
    scope: ScopeRef,
    sessions: readonly BodyTarget[],
  ): void;
  get(target: BodyTarget): TranscriptOwner | undefined;
  receive(sidecar: string, frame: ServerFrame, accepted: boolean): void;
  removeServer(sidecar: string): void;
  stop(): void;
}
const key = (target: BodyTarget) =>
  sessionKey(target.sidecarId, target.sessionID);
const scopeKey = (scope: ScopeRef) =>
  JSON.stringify([scope.sidecarId, scope.directory, scope.taskID]);
const systemClock: TranscriptClock = {
  now: Date.now,
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
interface Scope {
  ref: ScopeRef;
  targets: readonly BodyTarget[];
  interaction?: number;
  preload?: number;
  trigger?: string;
}
interface Job {
  id: string;
  target: BodyTarget;
  run(): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  signal: AbortSignal;
  abort(): void;
  order: number;
}

/** One body per identity; scope demand, queue admission and cooling are independent of views. */
export function createTranscripts(o: {
  connection(id: string): SidecarConnection;
  entry(sidecar: string, session: string): IndexEntry | undefined;
  factory?: StateFactory;
  clock?: TranscriptClock;
  changes?(server: string): IndexChanges | undefined;
}): TranscriptsOwner {
  const clock = o.clock ?? systemClock;
  const resources = new Map<
    string,
    { target: BodyTarget; owner: TranscriptOwner }
  >();
  const scopes = new Map<string, Scope>(),
    policies = new Map<string, MessagePolicy>();
  const queue: Job[] = [], active = new Map<string, number>();
  const queued = new Map<string, number>(),
    priorities = new Map<string, number>();
  let demand: TranscriptDemand = { sessions: [] },
    timer: unknown,
    stopped = false,
    serial = 0;
  const policy = (server: string) =>
    policies.get(server) ?? o.connection(server).messages;
  const rank = (id: string) => priorities.get(id) ?? Infinity;
  const dequeue = (server: string) => {
    const count = queued.get(server)! - 1;
    if (count) queued.set(server, count);
    else queued.delete(server);
  };
  const pump = () => {
    if (stopped) return;
    // Queue growth cannot admit work while every server is at capacity. In
    // particular, warming a large scope must not repeatedly sort its blocked queue.
    if (
      ![...queued.keys()].some((server) => {
        const limit = policy(server)?.concurrency;
        return limit !== undefined && (active.get(server) ?? 0) < limit;
      })
    ) return;
    queue.sort((a, b) => rank(a.id) - rank(b.id) || a.order - b.order);
    for (let i = 0; i < queue.length;) {
      const job = queue[i],
        server = job.target.sidecarId,
        limit = policy(server)?.concurrency;
      if (limit === undefined || (active.get(server) ?? 0) >= limit) {
        i++;
        continue;
      }
      queue.splice(i, 1);
      dequeue(server);
      job.signal.removeEventListener("abort", job.abort);
      if (job.signal.aborted) {
        job.reject(job.signal.reason);
        continue;
      }
      active.set(server, (active.get(server) ?? 0) + 1);
      void job.run().then(job.resolve, job.reject).finally(() => {
        active.set(server, (active.get(server) ?? 1) - 1);
        pump();
      });
    }
  };
  const acquire = <T>(
    target: BodyTarget,
    run: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (stopped || signal.aborted) {
        reject(signal.reason ?? new Error("Transcripts stopped"));
        return;
      }
      const job: Job = {
        id: key(target),
        target,
        run,
        signal,
        order: ++serial,
        resolve: (value) => resolve(value as T),
        reject,
        abort: () => {
          const at = queue.indexOf(job);
          if (at >= 0) {
            queue.splice(at, 1);
            dequeue(target.sidecarId);
          }
          signal.removeEventListener("abort", job.abort);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", job.abort, { once: true });
      queue.push(job);
      queued.set(target.sidecarId, (queued.get(target.sidecarId) ?? 0) + 1);
      pump();
    });
  const resource = (target: BodyTarget) => {
    let value = resources.get(key(target));
    if (!value) {
      value = {
        target,
        owner: createTranscript(
          target,
          o.connection,
          o.entry,
          (run, signal) => acquire(target, run, signal),
          o.factory ?? createState,
          () => policy(target.sidecarId),
        ),
      };
      resources.set(key(target), value);
    }
    return value.owner;
  };
  const reconcile = () => {
    if (stopped) return;
    if (timer !== undefined) clock.clear(timer);
    timer = undefined;
    const now = clock.now(), warm = new Map<string, BodyTarget>();
    priorities.clear();
    let deadline = Infinity;
    for (const [id, scope] of scopes) {
      const settings = policy(scope.ref.sidecarId);
      if (!settings) continue;
      const activeScope = demand.scope && scopeKey(demand.scope) === id;
      const cool = scope.interaction === undefined
        ? -Infinity
        : scope.interaction + settings.coolms;
      const preload = scope.preload === undefined
        ? -Infinity
        : scope.preload + settings.preloadms;
      if (preload <= now) {
        scope.preload = undefined;
        scope.trigger = undefined;
      }
      for (const target of scope.targets) {
        const id = key(target);
        priorities.set(id, Math.min(rank(id), -(scope.interaction ?? 0)));
      }
      if (scope.trigger && scope.preload !== undefined) {
        priorities.set(scope.trigger, -Number.MAX_VALUE);
      }
      if (activeScope || cool > now || preload > now) {
        for (const target of scope.targets) warm.set(key(target), target);
        if (!activeScope) {
          deadline = Math.min(deadline, Math.max(cool, preload));
        }
      }
    }
    const selectedID = demand.selected && key(demand.selected);
    if (demand.selected && selectedID) {
      warm.set(selectedID, demand.selected);
      priorities.set(selectedID, -Infinity);
    }
    const ordered = [...warm].sort(([a], [b]) => rank(a) - rank(b));
    for (const [id, target] of ordered) {
      if (
        !policy(target.sidecarId) ||
        o.entry(target.sidecarId, target.sessionID)?.deleted
      ) continue;
      resource(target).temperature(
        id === selectedID ? "screen" : "warm",
      );
    }
    for (const [id, value] of resources) {
      if (
        !warm.has(id) ||
        o.entry(value.target.sidecarId, value.target.sessionID)?.deleted
      ) value.owner.temperature("cold");
    }
    if (Number.isFinite(deadline) && deadline > now) {
      timer = clock.set(reconcile, deadline - now);
    }
    pump();
  };
  return {
    setDemand(value) {
      if (stopped) return;
      const previous = demand;
      demand = value;
      if (value.scope) {
        const id = scopeKey(value.scope), existing = scopes.get(id);
        const changed = !previous.scope || scopeKey(previous.scope) !== id ||
          (previous.selected && value.selected &&
            key(previous.selected) !== key(value.selected));
        scopes.set(id, {
          ...existing,
          ref: value.scope,
          targets: value.sessions,
          ...(changed ? { interaction: clock.now() } : {}),
        });
      }
      reconcile();
    },
    interact(ref) {
      if (stopped) return;
      const scope = scopes.get(scopeKey(ref));
      if (scope) {
        scope.interaction = clock.now();
        reconcile();
      }
    },
    preload(target, ref, sessions) {
      if (stopped || o.entry(target.sidecarId, target.sessionID)?.deleted) {
        return;
      }
      const id = scopeKey(ref), existing = scopes.get(id);
      scopes.set(id, {
        ...existing,
        ref,
        targets: [target, ...sessions.filter((t) => key(t) !== key(target))],
        preload: clock.now(),
        trigger: key(target),
      });
      reconcile();
    },
    get: (target) => resources.get(key(target))?.owner,
    receive(server, frame, accepted) {
      if (stopped || !accepted) return;
      const indexed = frame.t === "index.snapshot" || frame.t === "index.patch";
      const reduced = indexed ? o.changes?.(server) : undefined;
      const changes = indexed && reduced?.revision === frame.rev
        ? reduced
        : undefined;
      const ids = changes && new Set(changes.ids);
      if (frame.t === "welcome") {
        policies.set(server, messagePolicy(frame.messages));
      }
      if (frame.t === "content" && !isAttentionOp(frame.event)) {
        resources.get(sessionKey(server, frame.sessionID))?.owner.receive(
          server,
          frame,
        );
      } else {for (
          const value of indexed
            ? resources.values()
            : [...resources].sort(([a], [b]) => rank(a) - rank(b)).map((
              [, value],
            ) => value)
        ) {
          if (
            value.target.sidecarId === server &&
            (!ids || value.owner.usesMetadata(ids))
          ) value.owner.receive(server, frame);
        }}
      if (
        frame.t === "welcome" || (indexed && (!changes || changes.structural))
      ) reconcile();
    },
    removeServer(server) {
      for (const [id, value] of resources) {
        if (value.target.sidecarId === server) {
          value.owner.stop();
          resources.delete(id);
        }
      }
      for (const [id, scope] of scopes) {
        if (scope.ref.sidecarId === server) scopes.delete(id);
      }
      policies.delete(server);
      if (
        demand.scope?.sidecarId === server ||
        demand.selected?.sidecarId === server
      ) demand = { sessions: [] };
      reconcile();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clock.clear(timer);
      for (const value of resources.values()) value.owner.stop();
      resources.clear();
      scopes.clear();
      policies.clear();
      priorities.clear();
      queued.clear();
    },
  };
}
