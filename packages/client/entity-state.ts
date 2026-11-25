// SPDX-License-Identifier: LGPL-3.0-only
import type {
  BlockedCause,
  EntityState,
  HelperDisposition,
  ProjectStatus,
  SessionEvidence,
  TaskHelpers,
} from "@otk/protocol";
import { entityKey, rollupStatus } from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";

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
 * owns the revision-fenced states; this adds only transitions and staleness. */
export interface EntityStateStore {
  /** The inbox accepted these keys ("all" for a baseline). */
  observe(
    keys: readonly string[] | "all",
    origin: EntityTransition["origin"],
  ): void;
  /** Connection lost: every selector reads "none" until fresh state (D6). */
  stale(value: boolean): void;
  get(key: string): EntityState | undefined;
  readonly isStale: boolean;
  /** Reactive dependency: changes on every accepted change. */
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
  factory?: StateFactory;
  /** The connection's reactive state; a lost link makes every state stale. */
  connected?: () => boolean;
}): EntityStateStore {
  const store = (o.factory ?? createState)({ revision: 0 });
  const known = new Map<string, ProjectStatus>();
  const listeners = new Set<(transition: EntityTransition) => void>();
  const observers = new Set<(keys: readonly string[] | "all") => void>();
  let stale = false, stopped = false;
  const read = (k: string) => o.read()?.[k];
  const bump = () => store.update((s) => s.revision++);
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
          if (before && before !== "none") {
            transitions.push({
              key: k,
              from: before,
              to: "none",
              origin,
            });
          }
          continue;
        }
        if (before === value.state) continue;
        known.set(k, value.state);
        if ((before ?? "none") === value.state) continue;
        transitions.push({
          key: k,
          from: before ?? "none",
          to: value.state,
          ...(value.cause ? { cause: value.cause } : {}),
          origin,
        });
      }
      bump();
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

/** Read a published lamp, or roll up the published states of an explicit roster. */
export function lamp(
  store: EntityStateStore | undefined,
  key: string | readonly string[] | undefined,
): ProjectStatus {
  if (key === undefined || typeof key === "string") {
    return entityState(store, key);
  }
  if (!store || store.isStale) return "none";
  let state: ProjectStatus = "none";
  for (const member of key) {
    state = rollupStatus(state, store.get(member)?.state);
    if (state === "blocked") break;
  }
  return state;
}

export function permissionVisible(
  store: EntityStateStore,
  sessionID: string,
  id: string,
): boolean {
  return sessionEvidence(store, entityKey("session", sessionID))?.requests
    ?.permissions.some((request) => request.id === id) ?? false;
}

export function entityState(
  store: EntityStateStore | undefined,
  k: string | undefined,
): ProjectStatus {
  return !store || !k || store.isStale ? "none" : store.get(k)?.state ?? "none";
}

export function taskHelpers(
  store: EntityStateStore,
  key?: string,
): TaskHelpers | undefined {
  return store.isStale || !key ? undefined : store.get(key)?.helpers;
}

export function helperDisposition(
  store: EntityStateStore,
  key: string,
): HelperDisposition | undefined {
  return sessionEvidence(store, key)?.helper;
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
  dependencies: "Running in terminal",
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
