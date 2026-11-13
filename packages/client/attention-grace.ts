// SPDX-License-Identifier: LGPL-3.0-only
import type { SupervisionEvidence } from "@otk/protocol";
import type { InboxStatus } from "./inbox.ts";
import { createState, type StateFactory } from "./state.ts";

export const ATTENTION_GRACE_MS = 500;
export interface AttentionGraceClock {
  now(): number;
  set(callback: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}
export interface AttentionGrace {
  subscribe(listener: () => void): () => void;
  observe(
    server: string,
    session: string,
    evidence?: SupervisionEvidence,
  ): void;
  permission(server: string, session: string, id: string): boolean;
  settled(server: string, id: string): void;
  light(
    scope: string,
    state: InboxStatus,
    server: string,
    contains: (session: string) => boolean,
    reducedMotion: boolean,
    immediate?: boolean,
    permissionWaiting?: (session: string) => boolean,
  ): InboxStatus;
  removeServer(server: string): void;
  stop(): void;
}
/** Request lifetime, not a surface lifetime. Supervision and notification routing
 * remain immediate; consumers borrow only this presentation eligibility. */
export function createAttentionGrace(o: {
  clock?: AttentionGraceClock;
  factory?: StateFactory;
} = {}): AttentionGrace {
  const clock = o.clock ?? {
    now: () => performance.now(),
    set: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clear: (timer: unknown) => clearTimeout(timer as number),
  };
  const store = (o.factory ?? createState)({ revision: 0 });
  const pending = new Map<string, {
    server: string;
    session: string;
    id: string;
    due: number;
    ready: boolean;
  }>();
  const inputs = new Map<string, { server: string; session: string }>();
  const previous = new Map<string, { server: string; state: InboxStatus }>();
  const key = (server: string, id: string) => JSON.stringify([server, id]);
  let timer: unknown, stopped = false;
  const publish = () => store.update((s) => s.revision++);
  const schedule = () => {
    clock.clear(timer);
    timer = undefined;
    if (stopped) return;
    const deadlines = [...pending.values()].filter((p) => !p.ready);
    if (!deadlines.length) return;
    const due = Math.min(...deadlines.map((p) => p.due));
    timer = clock.set(() => {
      if (stopped) return;
      for (const p of pending.values()) {
        if (p.due <= clock.now()) p.ready = true;
      }
      schedule();
      publish();
    }, Math.max(0, due - clock.now()));
  };
  const arrive = (server: string, session: string, id: string) => {
    const k = key(server, id);
    let p = pending.get(k);
    if (!p && !stopped) {
      p = {
        server,
        session,
        id,
        due: clock.now() + ATTENTION_GRACE_MS,
        ready: false,
      };
      pending.set(k, p);
      schedule();
    }
    return p;
  };
  return {
    subscribe: store.subscribe,
    observe(server: string, session: string, evidence?: SupervisionEvidence) {
      if (stopped) return;
      const ids = new Set(evidence?.permissions?.keys ?? []);
      // A stale inventory owns neither new arrivals nor absence/settlement.
      for (const [k, p] of pending) {
        if (
          evidence?.permissions?.fresh && p.server === server &&
          p.session === session && !ids.has(p.id)
        ) {
          pending.delete(k);
        }
      }
      if (evidence?.permissions?.fresh) {
        for (const id of ids) arrive(server, session, id);
      }
      const k = key(server, session);
      if (evidence?.inputs?.fresh && evidence.inputs.keys.length) {
        inputs.set(k, { server, session });
      } else inputs.delete(k);
      schedule();
      publish();
    },
    permission(server: string, session: string, id: string): boolean {
      void store.state.revision;
      return arrive(server, session, id)?.ready ?? false;
    },
    settled(server: string, id: string) {
      if (stopped || !pending.delete(key(server, id))) return;
      schedule();
      publish();
    },
    light(
      scope: string,
      state: InboxStatus,
      server: string,
      contains: (session: string) => boolean,
      reducedMotion: boolean,
      immediate = false,
      permissionWaiting?: (session: string) => boolean,
    ): InboxStatus {
      void store.state.revision;
      if (state !== "blocked") previous.set(scope, { server, state });
      if (!reducedMotion || state !== "blocked" || immediate) return state;
      if (
        [...inputs.values()].some((p) =>
          p.server === server && contains(p.session)
        )
      ) {
        return state;
      }
      const requests = [...pending.values()].filter((p) =>
        p.server === server && contains(p.session) &&
        (permissionWaiting?.(p.session) ?? true)
      );
      if (!requests.length || requests.some((p) => p.ready)) return state;
      return previous.get(scope)?.state ?? "none";
    },
    removeServer(server: string) {
      for (const map of [pending, inputs, previous]) {
        for (const [k, p] of map) if (p.server === server) map.delete(k);
      }
      schedule();
      if (!stopped) publish();
    },
    stop() {
      stopped = true;
      clock.clear(timer);
      pending.clear();
      inputs.clear();
      previous.clear();
    },
  };
}
