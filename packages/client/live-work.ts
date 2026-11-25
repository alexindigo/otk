// SPDX-License-Identifier: LGPL-3.0-only
import { createState } from "./state.ts";

export interface RunningWork {
  id: string;
  kind: "helper" | "shell";
  label: string;
  title: string;
  sessionID: string;
  startedAt?: number;
}
export interface LiveWorkOwner {
  items(): readonly RunningWork[];
  canStop(id: string): boolean;
  stopping(id: string): boolean;
  stop(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}
/** Stop admission belongs to the work lifetime, not an open popover. */
export function createLiveWork(input: {
  items(): readonly RunningWork[];
  stopHelper?(): ((id: string) => Promise<void>) | undefined;
}): LiveWorkOwner {
  const state = createState({ pending: new Set<string>() });
  const pending = new Map<string, Promise<void>>();
  const item = (id: string) => input.items().find((item) => item.id === id);
  return {
    items: input.items,
    canStop: (id) => item(id)?.kind === "helper" && !!input.stopHelper?.(),
    stopping: (id) => state.state.pending.has(id),
    subscribe: (listener) => state.subscribe(listener),
    stop(id) {
      const admitted = pending.get(id);
      if (admitted) return admitted;
      const current = item(id), stop = input.stopHelper?.();
      if (current?.kind !== "helper" || !stop) return Promise.resolve();
      const work = Promise.resolve().then(() => stop(current.sessionID))
        .finally(() => {
          pending.delete(id);
          state.update((s) => s.pending.delete(id));
        });
      pending.set(id, work);
      state.update((s) => s.pending.add(id));
      return work;
    },
  };
}

export function runningWorkLabel(items: readonly RunningWork[]): string {
  return (["helper", "shell"] as const).flatMap((kind) => {
    const count = items.filter((item) => item.kind === kind).length;
    const label = kind === "helper" ? "subagent" : "shell";
    return count ? [`${count} ${label}${count === 1 ? "" : "s"}`] : [];
  }).join(", ");
}

/** Compact elapsed clock for live-work rows; the view supplies the live clock. */
