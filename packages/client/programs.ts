// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ProgramMembership,
  ProgramsFrame,
  ServerFrame,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";

export interface ProjectProgram {
  id: string | null;
  by: ProgramMembership["by"];
}
export interface ProgramsReplica {
  readonly ready: boolean;
  readonly auto: boolean;
  readonly programs: readonly Readonly<ProgramsFrame["programs"][number]>[];
  member(id: string): ProjectProgram | undefined;
  receive(frame: ServerFrame): void;
  settled(revision: number): Promise<void>;
  stop(): void;
}

/** Per-sidecar replica. Membership, including explicit Other, is never inferred. */
export function createPrograms(
  factory: StateFactory = createState,
): ProgramsReplica {
  const clock = factory({ revision: 0 });
  let frame: ProgramsFrame | undefined;
  let members = new Map<string, ProjectProgram>();
  const waiters = new Set<{
    revision: number;
    resolve(): void;
    reject(error: Error): void;
  }>();
  function reset() {
    frame = undefined;
    members.clear();
    clock.update((s) => s.revision = 0);
    for (const waiter of waiters) {
      waiter.reject(new Error("Programs connection changed"));
    }
    waiters.clear();
  }
  return {
    get ready() {
      return clock.state.revision > 0;
    },
    get auto() {
      return clock.state.revision > 0 && !!frame?.auto;
    },
    get programs(): ReadonlyArray<Readonly<ProgramsFrame["programs"][number]>> {
      void clock.state.revision;
      return frame?.programs ?? [];
    },
    member(id: string): ProjectProgram | undefined {
      void clock.state.revision;
      return members.get(id);
    },
    receive(next: ServerFrame) {
      if (next.t === "welcome") reset();
      if (next.t !== "programs" || next.revision <= clock.state.revision) {
        return;
      }
      frame = next;
      const previous = members;
      members = new Map(
        Object.entries(next.members).map(([project, { program, by }]) => {
          const old = previous.get(project);
          return [
            project,
            old && old.id === program && old.by === by
              ? old
              : { id: program, by },
          ];
        }),
      );
      clock.update((s) => s.revision = next.revision);
      for (const waiter of waiters) {
        if (waiter.revision <= next.revision) {
          waiters.delete(waiter);
          waiter.resolve();
        }
      }
    },
    settled(revision: number): Promise<void> {
      if (clock.state.revision >= revision) return Promise.resolve();
      return new Promise((resolve, reject) =>
        waiters.add({ revision, resolve, reject })
      );
    },
    stop: reset,
  };
}
