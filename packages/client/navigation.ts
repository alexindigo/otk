// SPDX-License-Identifier: LGPL-3.0-only
// Browser history is owned here: cancelling traversal returns to the accepted
// entry, without replacing (and losing) the destination in the history stack.
interface Position {
  owner: string;
  position: number;
}
function position(history: Pick<History, "state">): Position | undefined {
  const value = history.state?.otkNavigation;
  return value && typeof value.owner === "string" &&
      Number.isSafeInteger(value.position)
    ? value
    : undefined;
}
export interface NavigationEnvironment {
  history: Pick<History, "state" | "pushState" | "replaceState" | "go">;
  location: Pick<Location, "hash" | "pathname" | "search">;
  listen(changed: () => void): () => void;
}
export interface Navigation {
  open(hash: string): boolean;
  start(): void;
  stop(): void;
}
export function createNavigation(
  options: {
    accept(hash: string): boolean;
    apply(hash: string): void;
    intent(): void;
  },
  environment: NavigationEnvironment = {
    history: globalThis.history,
    location: globalThis.location,
    listen(changed) {
      globalThis.addEventListener("hashchange", changed);
      return () => globalThis.removeEventListener("hashchange", changed);
    },
  },
): Navigation {
  const { history, location } = environment;
  let unlisten: (() => void) | undefined;
  let current = location.hash,
    at = 0,
    owner = "",
    stopped = false,
    restoring = false;
  let queued: string | undefined;
  const state = (index: number) => ({
    ...history.state,
    otkNavigation: { owner, position: index },
  });
  const open = (hash: string): boolean => {
    if (stopped) return false;
    options.intent();
    if (restoring) {
      queued = hash;
      return false;
    }
    if (hash === current) return true;
    if (!options.accept(hash)) return false;
    at++;
    current = hash;
    history.pushState(
      state(at),
      "",
      location.pathname + location.search + hash,
    );
    options.apply(hash);
    return true;
  };
  const changed = () => {
    if (stopped) return;
    const target = position(history);
    if (
      restoring && target?.owner === owner && target.position === at &&
      location.hash === current
    ) {
      restoring = false;
      if (queued !== undefined) {
        const next = queued;
        queued = undefined;
        open(next);
      }
      return;
    }
    options.intent();
    let next = target?.owner === owner ? target.position : at + 1;
    if (next === at && location.hash !== current) next = at + 1;
    if (!target || target.owner !== owner || next !== target.position) {
      history.replaceState(state(next), "");
    }
    if (!options.accept(location.hash)) {
      const delta = at - next;
      if (delta) {
        restoring = true;
        history.go(delta);
      }
      return;
    }
    current = location.hash;
    at = next;
    options.apply(current);
  };
  return {
    open,
    start(): void {
      const previous = position(history);
      owner = previous?.owner ?? crypto.randomUUID();
      at = previous?.position ?? 0;
      current = location.hash;
      history.replaceState(state(at), "");
      unlisten = environment.listen(changed);
      options.apply(current);
    },
    stop(): void {
      stopped = true;
      queued = undefined;
      unlisten?.();
    },
  };
}
