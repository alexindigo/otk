// SPDX-License-Identifier: LGPL-3.0-only
import { randomID } from "@otk/protocol";
// Browser history is owned here: cancelling traversal returns to the accepted
// entry, without replacing (and losing) the destination in the history stack.
interface Position {
  owner: string;
  position: number;
  page?: true;
}
function position(history: Pick<History, "state">): Position | undefined {
  const value = history.state?.otkNavigation;
  return value && typeof value.owner === "string" &&
      Number.isSafeInteger(value.position) && value.position >= 0
    ? value
    : undefined;
}
export interface NavigationEntry {
  hash: string;
  /** A deliberate project page, not a pending project default. */
  page?: true;
  title?: string;
  project?: string;
}
export interface NavigationHistory {
  at: number;
  back?: NavigationEntry | "unrecorded";
  forward?: NavigationEntry;
}
export interface NavigationEnvironment {
  history: Pick<History, "state" | "pushState" | "replaceState" | "go">;
  location: Pick<Location, "hash" | "pathname" | "search">;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  listen(changed: () => void): () => void;
}
type Mode = "push" | "replace";
export interface Navigation {
  open(
    hash: string,
    mode?: Mode,
    entry?: Pick<NavigationEntry, "page">,
  ): boolean;
  go(delta: -1 | 1): boolean;
  /** Resolves after route acceptance or after returning from a declined guard. */
  traverse(delta: -1 | 1): Promise<boolean>;
  current(): NavigationEntry | undefined;
  describe(hash: string, label: { title: string; project: string }): void;
  history(): NavigationHistory;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
}
const limit = 50;
function sessionStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}
function validEntry(value: unknown): value is NavigationEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<NavigationEntry>;
  return typeof entry.hash === "string" &&
    (entry.page === undefined || entry.page === true) &&
    (entry.title === undefined || typeof entry.title === "string") &&
    (entry.project === undefined || typeof entry.project === "string");
}
export function createNavigation(
  options: {
    accept(hash: string): boolean;
    apply(hash: string, entry: NavigationEntry): void;
    intent(): void;
  },
  environment: NavigationEnvironment = {
    history: globalThis.history,
    location: globalThis.location,
    storage: sessionStorage(),
    listen(changed) {
      globalThis.addEventListener("popstate", changed);
      globalThis.addEventListener("hashchange", changed);
      return () => {
        globalThis.removeEventListener("popstate", changed);
        globalThis.removeEventListener("hashchange", changed);
      };
    },
  },
): Navigation {
  const { history, location, storage } = environment;
  const entries = new Map<number, NavigationEntry>();
  const listeners = new Set<() => void>();
  let unlisten: (() => void) | undefined;
  let current = location.hash,
    at = 0,
    owner = "",
    stopped = false,
    restoring = false,
    floor = 0;
  let queued: Parameters<Navigation["open"]> | undefined;
  let traversal: {
    position: number;
    settle(accepted: boolean): void;
    fail(error: unknown): void;
  } | undefined;
  const storageKey = () => `otk.navigation.v1:${owner}`;
  const state = (index: number, page?: true) => ({
    ...history.state,
    otkNavigation: { owner, position: index, ...(page ? { page } : {}) },
  });
  const truncate = (index: number) => {
    for (const key of entries.keys()) if (key > index) entries.delete(key);
  };
  const publish = () => {
    // Chrome drops the oldest entries, even if a later traversal moves back
    // to the edge of that retained window.
    floor = Math.max(floor, at - limit + 1);
    for (const key of entries.keys()) if (key < floor) entries.delete(key);
    try {
      storage?.setItem(
        storageKey(),
        JSON.stringify({ floor, entries: [...entries] }),
      );
    } catch {
      // Labels are optional; native traversal does not depend on storage.
    }
    for (const listener of listeners) listener();
  };
  const snapshot = (): NavigationHistory => ({
    at,
    back: entries.get(at - 1) ?? (at > floor ? "unrecorded" : undefined),
    forward: entries.get(at + 1),
  });
  const open: Navigation["open"] = (hash, mode = "push", { page } = {}) => {
    if (stopped) return false;
    options.intent();
    if (restoring) {
      queued = [hash, mode, { page }];
      return false;
    }
    if (hash === current) {
      if (entries.get(at)?.page === page) return true;
      // Home (or a project click) can change the intent of the same URL.
      mode = "replace";
    } else if (!options.accept(hash)) return false;
    const url = location.pathname + location.search + hash;
    if (mode === "push") {
      history.pushState(state(at + 1, page), "", url);
      truncate(at);
      at++;
    } else history.replaceState(state(at, page), "", url);
    current = hash;
    const entry = { hash, ...(page ? { page } : {}) };
    entries.set(at, entry);
    options.apply(hash, entry);
    publish();
    return true;
  };
  const changed = () => {
    if (stopped) return;
    const candidate = position(history);
    const target = candidate?.owner === owner ? candidate : undefined;
    const hash = location.hash;
    if (
      target?.position === at && hash === current
    ) {
      if (restoring) traversal?.settle(false);
      restoring = false;
      if (queued !== undefined) {
        const next = queued;
        queued = undefined;
        open(...next);
      }
      return;
    }
    // Hash traversals may fire popstate and hashchange. While restoring,
    // the second notification must not re-run the guard for the refused URL.
    if (restoring) return;
    options.intent();
    const owned = target && target.position !== at;
    const next = owned ? target.position : at + 1;
    if (!options.accept(hash)) {
      const delta = at - next;
      if (delta) {
        restoring = true;
        history.go(delta);
      }
      return;
    }
    if (!owned) {
      history.replaceState(state(next), "");
      truncate(next);
    }
    current = hash;
    at = next;
    const recorded = entries.get(at), page = owned && target.page === true;
    const entry = owned && recorded?.hash === hash && !!recorded.page === page
      ? recorded
      : { hash, ...(page ? { page: true as const } : {}) };
    entries.set(at, entry);
    options.apply(hash, entry);
    publish();
    if (traversal?.position === at) traversal.settle(true);
    else {traversal?.fail(
        new Error("The browser moved to a different history entry."),
      );}
  };
  const canGo = (delta: -1 | 1) =>
    !stopped && !restoring && !traversal &&
    !!snapshot()[delta === -1 ? "back" : "forward"];
  return {
    open,
    go(delta) {
      if (!canGo(delta)) return false;
      history.go(delta);
      return true;
    },
    traverse(delta) {
      if (!canGo(delta)) return Promise.resolve(false);
      return new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(deadline);
          traversal = undefined;
        };
        const deadline = setTimeout(() => {
          traversal?.fail(
            new Error("The browser did not complete the history move."),
          );
        }, 10_000);
        traversal = {
          position: at + delta,
          settle(accepted) {
            finish();
            resolve(accepted);
          },
          fail(error) {
            finish();
            reject(error);
          },
        };
        try {
          history.go(delta);
        } catch (error) {
          traversal?.fail(error);
        }
      });
    },
    current: () => entries.get(at),
    describe(hash, label) {
      const entry = entries.get(at);
      if (
        entry?.hash !== hash ||
        (entry.title === label.title && entry.project === label.project)
      ) return;
      entries.set(at, { ...entry, ...label });
      publish();
    },
    history: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(): void {
      const previous = position(history);
      owner = previous?.owner ?? randomID();
      at = previous?.position ?? 0;
      current = location.hash;
      try {
        const saved = JSON.parse(storage?.getItem(storageKey()) ?? "null");
        if (Array.isArray(saved?.entries)) {
          if (
            Number.isSafeInteger(saved.floor) && saved.floor >= 0 &&
            saved.floor <= at
          ) {
            floor = saved.floor;
          }
          for (const row of saved.entries) {
            if (!Array.isArray(row)) continue;
            const [index, entry] = row;
            if (
              Number.isSafeInteger(index) && index >= 0 &&
              Math.abs(index - at) < limit && validEntry(entry)
            ) {
              entries.set(index, entry);
              floor = Math.max(floor, index - limit + 1);
            }
          }
        }
      } catch {
        // Blocked or corrupt storage must not prevent routing.
      }
      const recorded = entries.get(at), page = previous?.page === true;
      const entry = recorded?.hash === current && !!recorded.page === page
        ? recorded
        : { hash: current, ...(page ? { page: true as const } : {}) };
      entries.set(at, entry);
      history.replaceState(state(at, entry.page), "");
      unlisten = environment.listen(changed);
      options.apply(current, entry);
      publish();
    },
    stop(): void {
      stopped = true;
      traversal?.settle(false);
      queued = undefined;
      unlisten?.();
      listeners.clear();
    },
  };
}
