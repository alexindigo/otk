// SPDX-License-Identifier: LGPL-3.0-only
import { createState } from "./state.ts";
import {
  type EntityState,
  HELPER_LAMP_ORDER,
  type HelperDisposition,
  type TaskHelpers,
} from "@otk/protocol";
import { age, elapsed, type TimeText } from "./format.ts";

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
  stopShell?(): ((id: string) => Promise<void>) | undefined;
}): LiveWorkOwner {
  const state = createState({ pending: new Set<string>() });
  const pending = new Map<string, Promise<void>>();
  const action = (id: string) => {
    const item = input.items().find((item) => `${item.kind}/${item.id}` === id);
    if (!item) return;
    const stop = item.kind === "helper"
      ? input.stopHelper?.()
      : input.stopShell?.();
    if (stop) return () => stop(item.id);
  };
  return {
    items: input.items,
    canStop: (id) => !!action(id),
    stopping: (id) => state.state.pending.has(id),
    subscribe: (listener) => state.subscribe(listener),
    stop(id) {
      const admitted = pending.get(id);
      if (admitted) return admitted;
      const stop = action(id);
      if (!stop) return Promise.resolve();
      const work = Promise.resolve().then(stop)
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

const helperLabels = {
  needsYou: {
    title: "Needs you",
    singular: "needs you",
    plural: "need you",
  },
  running: { title: "Running", singular: "running", plural: "running" },
  finished: {
    title: "Finished",
    singular: "finished",
    plural: "finished",
  },
  opened: { title: "Opened", singular: "opened", plural: "opened" },
} as const;

/** Display order and vocabulary shared by every form of the same counts. */
export function helperCountParts(counts?: TaskHelpers["counts"]): readonly {
  kind: HelperDisposition;
  title: string;
  count: number;
  phrase: string;
}[] {
  if (!counts) return [];
  return HELPER_LAMP_ORDER.flatMap((kind) => {
    const { title, singular, plural } = helperLabels[kind];
    const count = counts[kind] ?? 0;
    return count > 0
      ? [{ kind, title, count, phrase: count === 1 ? singular : plural }]
      : [];
  });
}

/** One vocabulary for the pill and its accessible name, from published counts. */
export function helperCountsLabel(
  counts?: TaskHelpers["counts"],
): string {
  return helperCountParts(counts).map(({ count, phrase }) =>
    `${count} ${phrase}`
  ).join(", ");
}

/** One clock per published disposition; an earlier run cannot date a wait. */
export function helperClock(
  entity: EntityState | undefined,
  now: number,
): { time: TimeText; ago: boolean } | undefined {
  const evidence = entity?.evidence;
  switch (evidence?.helper) {
    case "running": {
      const run = evidence.run;
      if (run) {
        return {
          time: elapsed((run.endedAt ?? now) - run.startedAt),
          ago: false,
        };
      }
      break;
    }
    case "needsYou":
      if (evidence.waitingSince !== undefined) {
        return { time: elapsed(now - evidence.waitingSince), ago: false };
      }
      break;
    case "finished":
    case "opened":
      if (entity?.terminal !== undefined) {
        const time = age(entity.terminal, now);
        return { time, ago: !time.word };
      }
  }
}
