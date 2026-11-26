// SPDX-License-Identifier: LGPL-3.0-only
import { createState } from "./state.ts";
import type {
  EntityState,
  HelperDisposition,
  TaskHelpers,
} from "@otk/protocol";
import { age, elapsed, metaList, type TimeText } from "./format.ts";

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

/** Display order and vocabulary shared by every form of the same counts. */
export function helperCountParts(counts: TaskHelpers["counts"]): readonly {
  kind: HelperDisposition;
  title: string;
  count: number;
  phrase: string;
}[] {
  return ([
    {
      kind: "running",
      title: "Running",
      count: counts.running,
      phrase: "running",
    },
    {
      kind: "needsYou",
      title: "Needs you",
      count: counts.needsYou,
      phrase: counts.needsYou === 1 ? "needs you" : "need you",
    },
    {
      kind: "notReturned",
      title: "Not returned",
      count: counts.notReturned,
      phrase: "not returned",
    },
  ] as const).filter(({ count }) => count > 0);
}

/** One vocabulary for the pill and its accessible name, from published counts. */
export function helperCountsLabel(
  counts: TaskHelpers["counts"],
  form: "visible" | "spoken" = "visible",
): string {
  const items = helperCountParts(counts).map(({ count, phrase }) =>
    `${count} ${phrase}`
  );
  return form === "spoken" ? items.join(", ") : metaList(items);
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
    case "notReturned":
      if (entity?.terminal !== undefined) {
        const time = age(entity.terminal, now);
        return { time, ago: !time.word };
      }
  }
}
