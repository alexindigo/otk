// SPDX-License-Identifier: LGPL-3.0-only
export interface OrderFacts {
  /** Durable rank of the answering source (e.g. configured server order). */
  source?: number;
  /** Durable position, changed only by an explicit user move. */
  position?: number;
  /** Immutable creation clock; absent sources retain discovery order. */
  created?: number;
}

/** True when saved keys both rows carry place `a` before `b`. Creation keys
 * only seed a batch: a late row never splits rows by creation time. */
function precedes(a: OrderFacts, b: OrderFacts): boolean {
  if (
    a.source !== undefined && b.source !== undefined && a.source !== b.source
  ) return a.source < b.source;
  return a.position !== undefined && b.position !== undefined &&
    a.position < b.position;
}

/** Presentation order has no activity/state inputs or timers. Existing rows
 * retain their relative order; only saved moves reorder. An arrival takes its
 * saved-key place among them (a late answer from one source lands where its
 * keys say, never by arrival time), otherwise the new-item place at the end.
 * Counted holds retain departing targets until their last interaction ends;
 * arrivals during a hold append and take their place once it ends. */
export function createStableOrder<T extends { id: string }>(
  changed: () => void,
) {
  const items = new Map<
    string,
    { row: T; present: boolean; facts: OrderFacts }
  >();
  const holds = new Set<object>();
  const sequences = new Map<string, {
    items: { key: string; value: unknown }[];
    rows: unknown[];
    source: readonly unknown[];
    held: boolean;
  }>();
  /** Arrivals appended during a hold, placed by their keys when it ends. */
  const pending = new Set<string>();
  let order: string[] = [], stopped = false, moved = false;
  const compare = (a: string, b: string) => {
    const aa = items.get(a)!.facts, bb = items.get(b)!.facts;
    return (aa.source ?? 0) - (bb.source ?? 0) ||
      (aa.position ?? Infinity) - (bb.position ?? Infinity) ||
      (aa.created ?? Infinity) - (bb.created ?? Infinity) || 0;
  };
  const place = (id: string) => {
    const facts = items.get(id)!.facts;
    const at = order.findIndex((other) =>
      precedes(facts, items.get(other)!.facts)
    );
    if (at < 0) order.push(id);
    else order.splice(at, 0, id);
  };
  const prune = () => {
    if (holds.size) return;
    for (const [id, item] of items) if (!item.present) items.delete(id);
    order = order.filter((id) => items.has(id) && !pending.has(id));
    for (const id of pending) if (items.has(id)) place(id);
    pending.clear();
  };
  return {
    sequence<R>(
      scope: string,
      rows: readonly R[],
      key: (row: R) => string,
    ): R[] {
      const cached = sequences.get(scope), held = holds.size > 0;
      if (cached?.source === rows && cached.held === held) {
        return cached.rows as R[];
      }
      const previous = cached?.items ?? [];
      const latest = new Map(rows.map((row) => [key(row), row]));
      const result = holds.size
        ? [
          ...previous.map((item) => ({
            key: item.key,
            value: latest.get(item.key) ?? item.value,
          })),
          ...rows.filter((row) =>
            !previous.some((item) => item.key === key(row))
          )
            .map((row) => ({ key: key(row), value: row })),
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
        const value = facts(row), previous = items.get(row.id);
        // Discovery becoming tracked is not a manual move of an existing row.
        if (
          previous?.facts.position !== undefined &&
          value.position !== undefined &&
          previous.facts.position !== value.position
        ) moved = true;
        items.set(row.id, { row, present: true, facts: value });
      }
      prune();
      const arrivals = [...items.keys()].filter((id) => !order.includes(id))
        .sort(compare);
      for (const id of arrivals) {
        if (!holds.size) place(id);
        else {
          // Appending displaces no held target.
          order.push(id);
          pending.add(id);
        }
      }
      if (moved) {
        // Reorder the positioned slots only; unpositioned rows keep their places.
        const positioned = order.filter((id) =>
          items.get(id)!.facts.position !== undefined
        ).sort(compare);
        let at = 0;
        order = order.map((id) =>
          items.get(id)!.facts.position === undefined ? id : positioned[at++]
        );
        moved = false;
        sequences.clear();
      }
      return order.map((id) => items.get(id)!.row);
    },
    hold() {
      const token = {};
      holds.add(token);
      return () => {
        if (!holds.delete(token) || stopped || holds.size) return;
        prune();
        changed();
      };
    },
    reset() {
      items.clear();
      sequences.clear();
      order = [];
      holds.clear();
      pending.clear();
      moved = false;
    },
    stop() {
      stopped = true;
      this.reset();
    },
  };
}
