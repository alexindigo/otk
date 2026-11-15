// SPDX-License-Identifier: LGPL-3.0-only
import {
  type Message,
  type NativeSourceView,
  sourceEntries,
} from "@otk/protocol";
import { type FailureValue, failureValue } from "./failure-features.ts";
import { createState } from "./state.ts";

export type NativeSourceState =
  | { state: "idle" | "loading" }
  | { state: "ready"; value: NativeSourceView }
  | { state: "failed"; failure: FailureValue };
/** Borrowed preview authority. A retained open fold, never a mounted row, reads. */
export interface NativeSourceOwner {
  readonly state: NativeSourceState;
  subscribe(listener: (state: NativeSourceState) => void): () => void;
  retain(): () => void;
  retry(): void;
}
export interface NativeSources {
  get(ref: string): NativeSourceOwner;
  changed(messageID: string, partID?: string): void;
  sync(): void;
  invalidate(): void;
  clear(): void;
  stop(): void;
}

/** Transcript-lifetime cache. References stay opaque; canonical holders own freshness. */
export function createNativeSources(options: {
  messages(): Record<string, Message>;
  load(ref: string, signal: AbortSignal): Promise<NativeSourceView>;
  limit: number;
}): NativeSources {
  type Entry = {
    owner: NativeSourceOwner;
    message?: Message;
    path: string;
    readers: number;
    invalidate(): void;
    dispose(): void;
  };
  const entries = new Map<string, Entry>();
  let alive = true;
  const location = (message: Message, ref: string) => {
    for (const entry of sourceEntries(message)) {
      if (entry.ref === ref) return entry;
    }
  };
  const trim = () => {
    for (const [ref, entry] of entries) {
      if (entries.size <= options.limit) break;
      if (entry.readers) continue;
      entries.delete(ref);
      entry.dispose();
    }
  };
  const get = (ref: string): NativeSourceOwner => {
    const cached = entries.get(ref);
    if (cached) {
      entries.delete(ref);
      entries.set(ref, cached);
      return cached.owner;
    }
    const message = Object.values(options.messages()).find((m) =>
      location(m, ref) !== undefined
    );
    let current: NativeSourceState = { state: "idle" };
    const store = createState({ revision: 0 });
    const publish = (next: NativeSourceState) => {
      current = next;
      store.update((s) => s.revision++);
    };
    let active = alive && !!message, generation = 0, dirty = true;
    let pending: { abort: AbortController; generation: number } | undefined;
    const run = () => {
      if (!active || !entry.readers || pending || !dirty) return;
      const read = { abort: new AbortController(), generation };
      pending = read;
      dirty = false;
      publish({ state: "loading" });
      void Promise.resolve().then(() => {
        read.abort.signal.throwIfAborted();
        if (!entry.readers) {
          dirty = true;
          return;
        }
        return options.load(ref, read.abort.signal);
      }).then((value) => {
        if (value && active && generation === read.generation) {
          publish({ state: "ready", value });
        }
      }, (error) => {
        if (active && generation === read.generation) {
          publish({
            state: "failed",
            failure: failureValue(error, { action: "Load source" }),
          });
        }
      }).finally(() => {
        if (pending !== read) return;
        pending = undefined;
        run();
      });
    };
    const entry: Entry = {
      path: message
        ? [...sourceEntries(message)].find((v) => v.ref === ref)!.path
        : "",
      message,
      readers: 0,
      owner: {
        get state() {
          return current;
        },
        subscribe: (listener) => store.subscribe(() => listener(current)),
        retain() {
          if (!active) return () => {};
          entry.readers++;
          run();
          let retained = true;
          return () => {
            if (!retained) return;
            retained = false;
            entry.readers--;
            trim();
          };
        },
        retry() {
          entry.invalidate();
        },
      },
      invalidate() {
        if (!active) return;
        generation++;
        dirty = true;
        publish({ state: entry.readers ? "loading" : "idle" });
        // A burst of changes joins one pending read and one latest replacement.
        queueMicrotask(run);
      },
      dispose() {
        active = false;
        entry.message = undefined;
        generation++;
        pending?.abort.abort();
        pending = undefined;
        publish({ state: "idle" });
      },
    };
    if (active) {
      entries.set(ref, entry);
      // Trim on release, not before this caller can retain its just-borrowed owner.
      queueMicrotask(trim);
    } else {
      publish({
        state: "failed",
        failure: failureValue(new Error("Source retired"), {
          action: "Load source",
          reason: "This record's source is no longer available",
        }),
      });
    }
    return entry.owner;
  };
  return {
    get,
    changed(messageID: string, partID?: string) {
      for (const entry of entries.values()) {
        if (entry.message?.id !== messageID) continue;
        if (
          partID === undefined || entry.path === "" ||
          entry.path === `p:${partID}` || entry.path.startsWith(`p:${partID}/`)
        ) {
          entry.invalidate();
        }
      }
    },
    sync() {
      const messages = options.messages();
      for (const [ref, entry] of entries) {
        if (!entry.message) continue;
        const message = messages[entry.message.id];
        if (message === entry.message) continue;
        const next = message && location(message, ref);
        if (next === undefined) {
          entries.delete(ref);
          entry.dispose();
        } else {
          const previous = location(entry.message, ref);
          entry.message = message;
          if (JSON.stringify(next.owner) !== JSON.stringify(previous?.owner)) {
            entry.invalidate();
          }
        }
      }
    },
    invalidate() {
      for (const entry of entries.values()) entry.invalidate();
    },
    clear() {
      for (const entry of entries.values()) entry.dispose();
      entries.clear();
    },
    stop() {
      alive = false;
      this.clear();
    },
  };
}
