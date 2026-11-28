// SPDX-License-Identifier: LGPL-3.0-only
/** Each feature exports only its unsaved state, never credentials or server caches. */
export interface ReloadOwner {
  snapshot(): unknown;
  restore(value: unknown): void;
}

/** Checkpoint keyed owners without mounting detached identities on restore. */
export function keyedReload<T extends { id: string }>(options: {
  ids(): readonly string[];
  snapshot(id: string): T;
  restore(value: T): void;
}): ReloadOwner {
  const detached = new Map<string, T>();
  return {
    snapshot() {
      const saved = new Map(detached);
      for (const id of options.ids()) saved.set(id, options.snapshot(id));
      return [...saved.values()];
    },
    restore(value) {
      const ids = new Set(options.ids());
      for (const saved of value as T[]) {
        if (ids.has(saved.id)) {
          options.restore(saved);
          detached.delete(saved.id);
        } else detached.set(saved.id, saved);
      }
    },
  };
}
type Encoded = [string, unknown?];
// Tag every node, not user objects, so own-undefined Default and Sets round-trip
// without colliding with arbitrary user text or plugin field names.
function encode(value: unknown): Encoded {
  if (value === undefined) return ["undefined"];
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new Error("Unsaved state cannot be checkpointed");
    }
    return ["value", value];
  }
  if (value instanceof Set) return ["set", [...value].map(encode)];
  if (Array.isArray(value)) return ["array", value.map(encode)];
  return [
    "object",
    Object.entries(value).map(([key, item]) => [key, encode(item)]),
  ];
}
function decode(node: Encoded): unknown {
  const [kind, value] = node;
  if (kind === "undefined") return undefined;
  if (kind === "value") return value;
  if (kind === "array" || kind === "set") {
    const items = (value as Encoded[]).map(decode);
    return kind === "set" ? new Set(items) : items;
  }
  if (kind !== "object") throw new Error("Invalid reload checkpoint");
  return Object.fromEntries(
    (value as [string, Encoded][]).map(([key, item]) => [key, decode(item)]),
  );
}
export interface Reload {
  register(key: string, owner: ReloadOwner): () => void;
  checkpoint(): void;
  run(): Promise<void>;
}
export class ReloadRefused extends Error {}
/** A tab-local handoff, not a server receipt or permission to resubmit effects. */
export function createReload(options: {
  key?: string;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  navigate(): void;
  reachable?(): Promise<boolean>;
  owners?: Record<string, ReloadOwner>;
}): Reload {
  const key = options.key ?? "otk.reload.v1";
  const owners = new Map<string, ReloadOwner>();
  let saved: string | null | undefined;
  let unreadable = false;
  let pending = new Map<string, unknown>();
  try {
    saved = options.storage?.getItem(key);
    pending = new Map(
      saved ? decode(JSON.parse(saved)) as [string, unknown][] : [],
    );
  } catch (cause) {
    unreadable = true;
    console.error("Reload storage diagnostic", cause);
  }
  const register = (key: string, owner: ReloadOwner) => {
    if (owners.has(key)) throw new Error("Duplicate reload owner");
    if (pending.has(key)) {
      try {
        owner.restore(pending.get(key));
        pending.delete(key);
      } catch (cause) {
        unreadable = true;
        console.error("Reload restore diagnostic", key, cause);
      }
    }
    owners.set(key, owner);
    return () => {
      if (owners.get(key) !== owner) return;
      owners.delete(key);
    };
  };
  for (const [key, owner] of Object.entries(options.owners ?? {})) {
    register(key, owner);
  }
  const checkpoint = () => {
    if (unreadable) {
      throw new Error(
        "Saved tab work could not be restored; it has not been overwritten",
      );
    }
    if (!options.storage) {
      throw new Error(
        "Tab storage is unavailable; your work is still in this page",
      );
    }
    const values = new Map(pending);
    for (const [key, owner] of owners) values.set(key, owner.snapshot());
    const bytes = JSON.stringify(encode([...values]));
    options.storage.setItem(key, bytes);
    if (options.storage.getItem(key) !== bytes) {
      throw new Error("Tab storage did not retain your work");
    }
  };
  return {
    register,
    checkpoint,
    async run() {
      checkpoint();
      if (options.reachable && !(await options.reachable())) {
        throw new ReloadRefused("Still unreachable. Page not reloaded.");
      }
      options.navigate();
    },
  };
}
