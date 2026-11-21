// SPDX-License-Identifier: LGPL-3.0-only
export interface OrderFacts {
  /** Durable position, changed only by an explicit user move. */
  position?: number;
  /** Immutable creation clock; absent sources retain discovery order. */
  created?: number;
}

/** Presentation order has no activity/state inputs or timers. Existing rows
 * retain their relative order, arrivals append, and only saved moves reorder.
 * Counted holds retain departing targets until their last interaction ends. */
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
  let order: string[] = [], stopped = false, moved = false;
  const compare = (a: string, b: string) => {
    const aa = items.get(a)!.facts, bb = items.get(b)!.facts;
    return (aa.position ?? Infinity) - (bb.position ?? Infinity) ||
      (aa.created ?? Infinity) - (bb.created ?? Infinity) || 0;
  };
  const prune = () => {
    if (holds.size) return;
    for (const [id, item] of items) if (!item.present) items.delete(id);
    order = order.filter((id) => items.has(id));
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
      order.push(...arrivals);
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
      moved = false;
    },
    stop() {
      stopped = true;
      this.reset();
    },
  };
}
