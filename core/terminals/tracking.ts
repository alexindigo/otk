// SPDX-License-Identifier: LGPL-3.0-only
import type { PtyDaemon } from "./daemon.ts";
import type { ProcessInfo } from "./frames.ts";
import { terminalOwner, terminalRunning } from "./ownership.ts";

export interface TerminalCounts {
  sessions: ReadonlyMap<string, number>;
  checkouts: ReadonlyMap<string, number>;
}
export interface TerminalChange extends TerminalCounts {
  changedSessions: readonly string[];
  changedCheckouts: readonly string[];
}
export interface TrackingClock {
  schedule(run: () => void, ms: number): () => void;
}
type InventoryDaemon = Pick<PtyDaemon, "alive" | "request">;
const clock: TrackingClock = {
  schedule(run, ms) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};
const changed = (
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
) =>
  [...new Set([...a.keys(), ...b.keys()])].filter((key) =>
    a.get(key) !== b.get(key)
  );

/** One passive inventory lifetime per daemon. Never starts a daemon or holds a work turn. */
export class TerminalTracking {
  #daemon?: InventoryDaemon;
  #controller = new AbortController();
  #listeners = new Set<(change: TerminalChange) => void>();
  #processes: readonly ProcessInfo[] = [];
  #owners = new Map<string, readonly string[]>();
  #counts: TerminalCounts = { sessions: new Map(), checkouts: new Map() };
  #pending?: Promise<void>;
  #cancel?: () => void;
  #revision = 0;
  #dirty = false;
  #stopped = false;
  constructor(
    private diagnostic: (cause: unknown) => void,
    private batch = 128,
    private timing: TrackingClock = clock,
  ) {}
  get counts(): TerminalCounts {
    return this.#counts;
  }
  get processes(): readonly ProcessInfo[] {
    return this.#processes;
  }
  owners(directory: string): readonly string[] {
    return this.#owners.get(directory) ?? [];
  }
  listen(listener: (change: TerminalChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async bind(daemon: InventoryDaemon): Promise<void> {
    this.clear();
    if (this.#stopped) return;
    this.#daemon = daemon;
    this.#controller = new AbortController();
    await this.refresh();
  }
  clear(): void {
    this.#revision++;
    this.#daemon = undefined;
    this.#controller.abort();
    this.#cancel?.();
    this.#cancel = undefined;
    this.#processes = [];
    this.#owners.clear();
    this.#publish({ sessions: new Map(), checkouts: new Map() });
  }
  #publish(next: TerminalCounts): void {
    const changedSessions = changed(this.#counts.sessions, next.sessions);
    const changedCheckouts = changed(this.#counts.checkouts, next.checkouts);
    this.#counts = next;
    if (!changedSessions.length && !changedCheckouts.length) return;
    for (const listener of this.#listeners) {
      listener({ ...next, changedSessions, changedCheckouts });
    }
  }
  /** A mutation fences every earlier inventory before requesting its successor. */
  changed(): Promise<void> {
    this.#revision++;
    return this.refresh();
  }
  refresh(): Promise<void> {
    if (!this.#daemon || this.#stopped) return Promise.resolve();
    this.#cancel?.();
    this.#cancel = undefined;
    this.#dirty = true;
    if (this.#pending) return this.#pending;
    const work = Promise.resolve().then(async () => {
      while (this.#dirty && this.#daemon && !this.#stopped) {
        this.#dirty = false;
        const daemon = this.#daemon, revision = this.#revision;
        const signal = this.#controller.signal;
        try {
          const reply = await daemon.request(
            { op: "list", mode: "pty" },
            signal,
          );
          if (reply.type !== "processes") {
            throw new Error("Expected daemon process list");
          }
          const sessions = new Map<string, number>(),
            checkouts = new Map<string, number>();
          const processes: ProcessInfo[] = [];
          const owners = new Map<string, Set<string>>();
          for (let i = 0; i < reply.processes.length; i++) {
            if (i && i % this.batch === 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
            if (
              signal.aborted || daemon !== this.#daemon ||
              revision !== this.#revision
            ) break;
            const process = reply.processes[i],
              owner = terminalOwner(process.group_id);
            if (!owner || process.mode !== "pty") continue;
            processes.push(process);
            if (!terminalRunning(process)) continue;
            sessions.set(owner.session, (sessions.get(owner.session) ?? 0) + 1);
            checkouts.set(owner.dir, (checkouts.get(owner.dir) ?? 0) + 1);
            const ids = owners.get(owner.dir) ?? new Set<string>();
            ids.add(owner.session);
            owners.set(owner.dir, ids);
          }
          if (
            !signal.aborted && daemon === this.#daemon &&
            revision === this.#revision
          ) {
            this.#processes = processes;
            this.#owners = new Map(
              [...owners].map(([directory, ids]) => [directory, [...ids]]),
            );
            this.#publish({ sessions, checkouts });
          }
        } catch (cause) {
          if (!signal.aborted && daemon === this.#daemon && !this.#stopped) {
            this.diagnostic(cause);
          }
        }
      }
    }).finally(() => {
      if (this.#pending !== work) return;
      this.#pending = undefined;
      if (this.#daemon?.alive && !this.#stopped) {
        this.#cancel = this.timing.schedule(() => {
          void this.refresh();
        }, 2000);
      }
    });
    this.#pending = work;
    return work;
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    this.clear();
    await this.#pending;
    this.#listeners.clear();
  }
}
