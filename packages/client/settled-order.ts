// SPDX-License-Identifier: LGPL-3.0-only
import type { AttentionGraceClock } from "./attention-grace.ts";

export const ORDER_SETTLE_MS = 5000;
export interface OrderFacts {
  priority: number;
  activity: number;
  /** Stable identity tie-break, independent of live rank clocks. */
  tie?: string;
  /** Questions and failures are immediate; permissions retain their short grace. */
  urgentMs?: number;
}
export interface SettledOrderOptions {
  clock?: AttentionGraceClock;
  settleMs?: number;
}
type Pending = { value: number; due: number };

/** Presentation order, never supervision or membership authority. State and
 * recency settle independently: continuous traffic cannot starve a state edge.
 * Holds retain the permutation (and departing rows) across all its borrowers. */
export function createSettledOrder<T extends { id: string }>(
  changed: () => void,
  options: SettledOrderOptions = {},
) {
  const clock = options.clock ?? {
    now: () => performance.now(),
    set: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clear: (timer: unknown) => clearTimeout(timer as number),
  };
  const settle = options.settleMs ?? ORDER_SETTLE_MS;
  const items = new Map<string, {
    row: T;
    present: boolean;
    priority: number;
    activity: number;
    tie?: string;
    rank?: Pending;
    recent?: Pending;
  }>();
  const holds = new Set<object>();
  const sequences = new Map<
    string,
    {
      items: readonly { key: string; value: unknown }[];
      rows: unknown[];
      source: readonly unknown[];
      held: boolean;
    }
  >();
  let order: string[] = [], timer: unknown, deadline: number | undefined;
  let stopped = false;
  const prune = () => {
    if (holds.size) return;
    for (const [id, item] of items) if (!item.present) items.delete(id);
  };
  const schedule = () => {
    const next = Math.min(
      ...[...items.values()].filter((i) => i.present).flatMap((i) =>
        [i.rank?.due, i.recent?.due].filter((v): v is number => v !== undefined)
      ),
    );
    const due = Number.isFinite(next) ? next : undefined;
    if (deadline === due) return;
    clock.clear(timer);
    timer = undefined;
    deadline = due;
    if (stopped || due === undefined) return;
    timer = clock.set(() => {
      deadline = undefined;
      timer = undefined;
      if (stopped) return;
      for (const item of items.values()) {
        if (!item.present) continue;
        if (item.rank && item.rank.due <= clock.now()) {
          item.priority = item.rank.value;
          delete item.rank;
        }
        if (item.recent && item.recent.due <= clock.now()) {
          item.activity = item.recent.value;
          delete item.recent;
        }
      }
      schedule();
      changed();
    }, Math.max(0, due - clock.now()));
  };
  const stage = (
    value: number,
    current: number,
    pending: Pending | undefined,
    ms: number,
  ): Pending | undefined =>
    value === current
      ? undefined
      : pending?.value === value
      ? pending
      : { value, due: clock.now() + ms };
  return {
    /** A structural list borrows the same hold, including native page refreshes
     * that change sibling chronology without changing task rank. */
    sequence<R>(
      scope: string,
      rows: readonly R[],
      key: (row: R) => string,
    ): R[] {
      const cached = sequences.get(scope);
      const held = holds.size > 0;
      if (cached?.source === rows && cached.held === held) {
        return cached.rows as R[];
      }
      const latest = new Map(rows.map((row) => [key(row), row]));
      const previous = cached?.items ?? [];
      const result = holds.size
        ? [
          ...previous.map((item) => ({
            key: item.key,
            value: latest.get(item.key) ?? item.value,
          })),
          ...rows.filter((row) =>
            !previous.some((item) => item.key === key(row))
          ).map((row) => ({ key: key(row), value: row })),
        ]
        : rows.map((row) => ({ key: key(row), value: row }));
      if (
        cached && result.length === previous.length &&
        result.every((item, i) =>
          item.key === previous[i].key && item.value === previous[i].value
        )
      ) {
        cached.source = rows;
        cached.held = held;
        return cached.rows as R[];
      }
      const projected = result.map((item) => item.value as R);
      sequences.set(scope, {
        items: result,
        rows: projected,
        source: rows,
        held,
      });
      return projected;
    },
    order(rows: readonly T[], facts: (row: T) => OrderFacts): T[] {
      if (stopped) return [];
      for (const item of items.values()) item.present = false;
      for (const row of rows) {
        const value = facts(row);
        const item = items.get(row.id);
        if (!item) {
          items.set(row.id, { row, present: true, ...value });
          continue;
        }
        item.row = row;
        item.present = true;
        const delay = value.urgentMs ?? settle;
        item.rank = stage(value.priority, item.priority, item.rank, delay);
        if (item.rank && delay === 0) {
          item.priority = value.priority;
          delete item.rank;
        }
        item.recent = stage(value.activity, item.activity, item.recent, settle);
        if (item.recent && settle === 0) {
          item.activity = value.activity;
          delete item.recent;
        }
      }
      prune();
      schedule();
      const sorted = [...items.keys()].sort((a, b) => {
        const aa = items.get(a)!, bb = items.get(b)!;
        return aa.priority - bb.priority || bb.activity - aa.activity ||
          (aa.tie ?? a).localeCompare(bb.tie ?? b);
      });
      order = holds.size
        ? [
          ...order.filter((id) => items.has(id)),
          ...sorted.filter((id) => !order.includes(id)),
        ]
        : sorted;
      return order.map((id) => items.get(id)!.row);
    },
    hold() {
      const token = {};
      holds.add(token);
      return () => {
        if (!holds.delete(token) || stopped || holds.size) return;
        prune();
        schedule();
        changed();
      };
    },
    reset() {
      clock.clear(timer);
      timer = undefined;
      deadline = undefined;
      items.clear();
      sequences.clear();
      order = [];
      holds.clear();
    },
    stop() {
      stopped = true;
      this.reset();
    },
  };
}
