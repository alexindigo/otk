// SPDX-License-Identifier: LGPL-3.0-only
import type {
  BlockedCause,
  EntityRequestEvidence,
  EntityState,
  ProjectStatus,
  SessionEvidence,
} from "@otk/protocol";
import { rollupStatus } from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";

/** WP5: a permission is painted only after it has been pending this long. */
export const ATTENTION_GRACE_MS = 500;
/** The one grace rule: a request becomes visible at its client arrival plus
 * the grace. Every grace owner derives its deadline here. */
export function graceDeadline(arrivedAt: number): number {
  return arrivedAt + ATTENTION_GRACE_MS;
}

export interface EntityClock {
  now(): number;
  set(callback: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}
export interface EntityTransition {
  key: string;
  from: ProjectStatus;
  to: ProjectStatus;
  cause?: BlockedCause;
  origin: "live" | "historical" | "unknown";
}
export interface LampOptions {
  /** Kept for callers; WP5 applies one grace to every surface and motion. */
  surface?: "lamp" | "composer";
  reducedMotion?: boolean;
  now: number;
}
/** Presentation view of the inbox's entity replica (decision 62). The inbox
 * owns the revision-fenced states; this adds only client receipt times,
 * transitions, staleness and one grace timer. It never derives a state. */
export interface EntityStateStore {
  /** The inbox accepted these keys ("all" for a baseline). */
  observe(
    keys: readonly string[] | "all",
    origin: EntityTransition["origin"],
  ): void;
  /** Connection lost: every selector reads "none" until fresh state (D6). */
  stale(value: boolean): void;
  get(key: string): EntityState | undefined;
  /** Client receipt time of the entity's current state. */
  since(key: string): number | undefined;
  /** Client arrival time of a request, from the request-lifetime owner. */
  arrival(id: string): number | undefined;
  readonly isStale: boolean;
  /** Reactive dependency: changes on every accepted change and at each grace
   * deadline. */
  readonly revision: number;
  subscribe(listener: (transition: EntityTransition) => void): () => void;
  /** Evidence and stale changes, including changes with no lamp transition. */
  observeChanges(
    listener: (keys: readonly string[] | "all") => void,
  ): () => void;
  stop(): void;
}

export function createEntityStateStore(o: {
  read: () => Readonly<Record<string, EntityState>> | undefined;
  clock?: EntityClock;
  factory?: StateFactory;
  arrival?: (id: string) => number | undefined;
  /** The connection's reactive state; a lost link makes every state stale. */
  connected?: () => boolean;
}): EntityStateStore {
  const clock = o.clock ?? {
    now: () => performance.now(),
    set: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clear: (timer: unknown) => clearTimeout(timer as number),
  };
  const store = (o.factory ?? createState)({ revision: 0 });
  /** Last observed state and its receipt time per key: transition memory. */
  const known = new Map<string, { state: ProjectStatus; since: number }>();
  const listeners = new Set<(transition: EntityTransition) => void>();
  const observers = new Set<(keys: readonly string[] | "all") => void>();
  let stale = false, stopped = false, timer: unknown;
  const arrival = (id: string) => o.arrival?.(id);
  const read = (k: string) => o.read()?.[k];
  const bump = () => store.update((s) => s.revision++);
  // One timer for the earliest pending grace; a lamp re-reads at its deadline.
  const schedule = () => {
    clock.clear(timer);
    timer = undefined;
    if (stopped) return;
    const now = clock.now();
    let next = Infinity;
    for (const [k, value] of Object.entries(o.read() ?? {})) {
      if (value.state !== "blocked" || value.cause !== "permission") continue;
      const entered = known.get(k)?.since ?? now;
      const requests = permissionRequests(value);
      for (
        const due of requests.length
          ? requests.map((r) => graceDeadline(arrival(r.id) ?? entered))
          : [graceDeadline(entered)]
      ) if (due > now) next = Math.min(next, due);
    }
    if (next === Infinity) return;
    timer = clock.set(() => {
      if (stopped) return;
      bump();
      schedule();
    }, next - now);
  };
  return {
    observe(keys, origin) {
      if (stopped) return;
      const transitions: EntityTransition[] = [];
      const names = keys === "all"
        ? new Set([...known.keys(), ...Object.keys(o.read() ?? {})])
        : keys;
      for (const k of names) {
        const value = read(k), before = known.get(k);
        if (!value) {
          known.delete(k);
          if (before && before.state !== "none") {
            transitions.push({
              key: k,
              from: before.state,
              to: "none",
              origin,
            });
          }
          continue;
        }
        if (before?.state === value.state) continue;
        known.set(k, { state: value.state, since: clock.now() });
        if ((before?.state ?? "none") === value.state) continue;
        transitions.push({
          key: k,
          from: before?.state ?? "none",
          to: value.state,
          ...(value.cause ? { cause: value.cause } : {}),
          origin,
        });
      }
      bump();
      schedule();
      for (const observer of observers) observer(keys);
      for (const transition of transitions) {
        for (const listener of listeners) listener(transition);
      }
    },
    stale(value) {
      if (stale === value) return;
      stale = value;
      bump();
      for (const observer of observers) observer("all");
    },
    get(k) {
      void store.state.revision;
      return read(k);
    },
    since: (k) => known.get(k)?.since,
    arrival,
    get isStale() {
      void store.state.revision;
      return stale || o.connected?.() === false;
    },
    get revision() {
      return store.state.revision;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    observeChanges(listener) {
      observers.add(listener);
      return () => {
        observers.delete(listener);
      };
    },
    stop() {
      stopped = true;
      clock.clear(timer);
      listeners.clear();
      observers.clear();
    },
  };
}

/** A state held by a standalone consumer without a connection (an embedded
 * component or fixture), presented through the same selectors. */
export function presentedEntity(
  kind: EntityState["kind"],
  id: string,
  state: ProjectStatus,
  unseen = false,
): EntityState {
  return {
    kind,
    id,
    state,
    previous: state,
    counts: {
      blocked: state === "blocked" ? 1 : 0,
      working: state === "working" ? 1 : 0,
      finished: state === "finished" ? 1 : 0,
      unseen: unseen ? 1 : 0,
    },
  };
}

/** The permission identities an entity's grace is measured against. */
function permissionRequests(
  value: EntityState,
): readonly EntityRequestEvidence[] {
  return value.kind === "session"
    ? value.evidence?.requests?.permissions ?? []
    : value.requests ?? [];
}

/** The lamp state of an entity. Absent or stale state is grey (D6). A state
 * blocked only by permissions keeps its previous state until one of those
 * requests has been pending for the grace (WP5, addendum 1): each request is
 * timed from its own client arrival, so a replacement starts a new grace.
 * Questions, forms, operations and failed helpers are immediate. */
export function lamp(
  store: EntityStateStore,
  k: string,
  options: LampOptions,
): ProjectStatus {
  const value = store.get(k);
  if (!value || store.isStale) return "none";
  if (value.state !== "blocked" || value.cause !== "permission") {
    return value.state;
  }
  const entered = store.since(k) ?? options.now;
  const requests = permissionRequests(value);
  const ready = requests.length
    ? requests.some((request) =>
      options.now >= graceDeadline(store.arrival(request.id) ?? entered)
    )
    : options.now >= graceDeadline(entered);
  return ready ? "blocked" : value.previous;
}

/** One label dictionary, keyed by state; the cause refines nothing yet. */
export function entityState(store: EntityStateStore, k: string): ProjectStatus {
  return store.isStale ? "none" : store.get(k)?.state ?? "none";
}

/** Presentation only: summarize the lamps in the D66 disclosure. This is not
 * the task's state, which includes members outside the disclosure. */
export function visibleLampStatus(
  states: readonly ProjectStatus[],
): ProjectStatus {
  return rollupStatus(...states);
}

/** Own-session evidence only. Descendant counts retain their explicit scope. */
export function sessionEvidence(
  store: EntityStateStore,
  k: string,
): SessionEvidence | undefined {
  return store.isStale ? undefined : store.get(k)?.evidence;
}

/** Compatibility observation for session-row consumers. This is work evidence,
 * not the supervision lamp: a blocked session can still have fresh work. */
export function sessionWorkStatus(
  store: EntityStateStore,
  k: string,
): "idle" | "busy" | "retry" | undefined {
  const evidence = sessionEvidence(store, k);
  if (!evidence) return undefined;
  return evidence.retry ? "retry" : evidence.work ? "busy" : "idle";
}

/** Run evidence excludes background shell work, not V1's native execution. */
export function sessionRunning(store: EntityStateStore, key: string): boolean {
  const evidence = sessionEvidence(store, key);
  return !!evidence?.work &&
    (!evidence.liveWork?.length ||
      evidence.liveWork.some((item) => item.kind !== "shell"));
}

export const ENTITY_LABELS: Readonly<Record<ProjectStatus, string>> = {
  blocked: "Needs you",
  working: "Working",
  finished: "Finished, not seen",
  none: "No known activity",
};
export function label(state: ProjectStatus, _cause?: BlockedCause): string {
  return ENTITY_LABELS[state];
}
/** Names are emphasized while the entity has unseen finishes. */
export function emphasis(store: EntityStateStore, k: string): boolean {
  const value = store.get(k);
  return !store.isStale && (value?.counts.unseen ?? 0) > 0;
}
/** Sessions that need the user: blocked, or finished and not seen. */
export function attention(
  store: EntityStateStore,
  k: string,
): { blocked: number; finished: number } {
  const value = store.isStale ? undefined : store.get(k)?.counts;
  return { blocked: value?.blocked ?? 0, finished: value?.finished ?? 0 };
}
export function liveWork(
  store: EntityStateStore,
  k: string,
): SessionEvidence["liveWork"] {
  if (store.isStale) return undefined;
  return store.get(k)?.evidence?.liveWork;
}
