// SPDX-License-Identifier: LGPL-3.0-only
import {
  compareMessages,
  type Message,
  type MessageCursor,
  type MessagePage,
} from "@otk/protocol";

// Keep only the fields used by the canonical message comparator, never bodies.
type Position = Pick<Message, "id" | "sourceOrder" | "time">;
const compare = compareMessages as (a: Position, b: Position) => number;
const position = ({ id, sourceOrder, time }: Message): Position => ({
  id,
  sourceOrder,
  time: { created: time.created },
});
type Frontier = MessageCursor | null | undefined;

interface PageLink {
  groups: string[][];
  lower: Position | undefined;
}

interface Range {
  key: string;
  // In acquisition order. Links at or after `next` are parked, not proof.
  links: Map<MessageCursor | undefined, PageLink>;
  next: Frontier;
  ids: Map<string, Position>;
  observed: Set<string>;
}

export interface CoverageGap {
  key: string;
  newer: string;
  older: string;
}

const has = (link: PageLink, matches: (id: string) => boolean) =>
  link.groups.some((ids) => ids.some(matches));

function* acquired(range: Range) {
  for (const entry of range.links) {
    if (entry[0] === range.next) return;
    yield entry;
  }
}

function install(
  range: Range,
  before: MessageCursor | undefined,
  older: MessageCursor | null,
  messages: readonly Message[],
  groups = [messages.map((m) => m.id)],
) {
  const link = {
    groups,
    lower: messages[0]
      ? position(messages[0])
      : [...acquired(range)].at(-1)?.[1].lower,
  };
  range.links.set(before, link);
  range.next = older;
  for (const message of messages) range.ids.set(message.id, position(message));
}

function newest(messages: readonly Message[]): Range {
  return {
    key: `range:${messages.at(-1)?.id ?? ""}`,
    links: new Map(),
    ids: new Map(),
    observed: new Set(),
    next: undefined,
  };
}

function joins(
  range: Range,
  items: readonly Message[],
  older: MessageCursor | null,
  same: boolean,
) {
  return items.some(({ id }) => range.ids.has(id)) ||
    (same && older !== null && range.links.has(older));
}

function absorb(
  range: Range,
  prior: Range,
  same: boolean,
  loaded: ReadonlySet<string>,
) {
  for (const [id, value] of prior.ids) {
    if (!range.ids.has(id)) range.ids.set(id, value);
  }
  if (!same) return;
  for (const id of prior.observed) range.observed.add(id);

  const links = [...acquired(prior)];
  const end = links.at(-1)?.[1].lower;
  const last = [...acquired(range)].at(-1)?.[1];
  if (!last || !links.length) return;
  // Keep the deeper frontier. An exhausted fresh page cannot be reopened
  // by overlapping a shorter, previously acquired interval.
  const reuse = range.next !== null && prior.next !== undefined &&
    (prior.next === null || !last.lower ||
      (end && compare(end, last.lower) <= 0)) &&
    (prior.next === null || !range.links.has(prior.next));
  for (const [before, link] of links) {
    const groups = link.groups.flatMap((ids) => {
      const retained = ids.filter((id) => !loaded.has(id));
      return retained.length ? [retained] : [];
    });
    if (reuse && before !== undefined && !range.links.has(before)) {
      range.links.set(before, { groups, lower: link.lower });
    } else {
      last.groups.push(...groups);
    }
  }
  if (reuse) {
    range.next = prior.next;
    // The prior frontier may belong to its root link, folded into ours.
    const frontierLink = [...acquired(range)].at(-1)?.[1];
    if (frontierLink) frontierLink.lower = end ?? frontierLink.lower;
  }
}

function absent(
  held: Iterable<Position>,
  items: readonly Message[],
  older: MessageCursor | null,
  upper?: Position,
) {
  const lower = items[0];
  if (older !== null && !lower) return [];
  const present = new Set(items.map((item) => item.id));
  const deleted: string[] = [];
  for (const row of held) {
    if (
      !present.has(row.id) && (!upper || compare(row, upper) < 0) &&
      (older === null || compare(row, lower) >= 0)
    ) deleted.push(row.id);
  }
  return deleted;
}

/** Owns coverage, not bodies. A cursor is the first unacquired boundary. */
export function createAcquiredRange() {
  let ranges: Range[] = [];

  const prune = (
    deleted: readonly string[],
    pageIDs: readonly Message[],
    owner: Range,
  ) => {
    const installed = new Set(pageIDs.map((message) => message.id));
    for (const range of ranges) {
      const removed = new Set(deleted.filter((id) => range.ids.delete(id)));
      if (range !== owner) {
        for (const id of installed) {
          if (range.ids.delete(id)) removed.add(id);
        }
      }
      if (!removed.size) continue;
      for (const id of removed) range.observed.delete(id);
      for (const link of range.links.values()) {
        link.groups = link.groups.map((ids) =>
          ids.filter((id) => !removed.has(id))
        );
      }
    }
    ranges = ranges.filter((range, i) => i === 0 || range.ids.size > 0);
  };

  const bounds = () =>
    ranges.flatMap(({ key, ids, next }) => {
      let oldest: Position | undefined;
      let latest: Position | undefined;
      for (const row of ids.values()) {
        if (!oldest || compare(row, oldest) < 0) oldest = row;
        if (!latest || compare(row, latest) > 0) latest = row;
      }
      return oldest && latest
        ? [{ key, first: oldest.id, last: latest.id, next }]
        : [];
    });

  function extend(
    key: string,
    before: MessageCursor,
    older: MessageCursor | null,
    messages: readonly Message[],
  ) {
    const index = ranges.findIndex((range) => range.key === key);
    const range = ranges[index];
    if (!range || before !== range.next) {
      throw new Error("Unacquired message boundary");
    }
    const proof = [...acquired(range)];
    if (
      older !== null &&
      (older === before || proof.some(([key]) => key === older))
    ) {
      throw new Error("Message cursor did not advance");
    }
    // `before` is opaque. Its preceding acquired page witnesses an exclusive
    // upper bound; without that witness, absence does not establish deletion.
    const upper = proof.at(-1)?.[1].lower;
    const deleted = upper
      ? absent(
        ranges.slice(index).flatMap((r) => [...r.ids.values()]),
        messages,
        older,
        upper,
      )
      : [];
    range.links = new Map(proof);
    install(range, before, older, messages);
    const loaded = new Set(messages.map((message) => message.id));
    let count = 0;
    for (const prior of ranges.slice(index + 1)) {
      if (!joins(prior, messages, older, true)) break;
      absorb(range, prior, true, loaded);
      count++;
    }
    ranges.splice(index + 1, count);
    prune(deleted, messages, range);
    return { joined: count > 0, deleted };
  }

  return {
    get next() {
      return ranges.length === 1 ? ranges[0].next : undefined;
    },
    clear() {
      ranges = [];
    },
    head(
      page: Pick<MessagePage, "items" | "older">,
      held: readonly Message[],
      { same }: { same: boolean },
    ) {
      const head = newest(page.items);
      install(head, undefined, page.older, page.items);
      const loaded = new Set(head.ids.keys());
      let count = 0;
      for (const range of ranges) {
        if (!joins(range, page.items, page.older, same)) break;
        absorb(head, range, same, loaded);
        count++;
      }
      const retained = ranges.slice(count);
      if (!same) {
        for (const range of retained) {
          range.links.clear();
          range.observed.clear();
          if (range.next !== null) range.next = undefined;
        }
      }
      const deleted = absent(held, page.items, page.older);
      ranges = [head, ...retained];
      prune(deleted, page.items, head);
      return { joined: count > 0, deleted };
    },
    extend,
    ranges: bounds,
    gaps(): readonly CoverageGap[] {
      const rows = bounds();
      return rows.slice(1).map((older, i) => ({
        key: `gap:${older.last}`,
        newer: rows[i].first,
        older: older.last,
      }));
    },
    known: (id: string) => ranges.some((range) => range.ids.has(id)),
    observe(message: Message) {
      // Only the first accepted live upsert proves a newly acquired body.
      // A header on its own does not revalidate any previously acquired row.
      const head = ranges[0];
      if (head && !ranges.some((range) => range.ids.has(message.id))) {
        head.ids.set(message.id, position(message));
        head.observed.add(message.id);
      }
    },
    remove(id: string) {
      if (ranges[0]) prune([id], [], ranges[0]);
    },
    current: (id: string) =>
      ranges.some((range) =>
        range.observed.has(id) ||
        [...acquired(range)].some(([, link]) => has(link, (key) => key === id))
      ),
    visit(visible: ReadonlySet<string>, visited: Set<string>) {
      for (const range of ranges) {
        for (const { groups } of range.links.values()) {
          for (const ids of groups) {
            if (ids.some((id) => visible.has(id))) {
              for (const id of ids) visited.add(id);
            }
          }
        }
      }
    },
    evict(ordered: readonly string[], removed: ReadonlySet<string>) {
      const park: string[] = [];
      const olderIDs = new Set(
        ranges.slice(1).flatMap((range) => [...range.ids.keys()]),
      );
      for (const [i, range] of ranges.entries()) {
        const belongs = i === 0
          ? (id: string) => !olderIDs.has(id)
          : (id: string) => range.ids.has(id);
        const ids = ordered.filter(belongs);
        const last = ids.findLastIndex((id) => removed.has(id));
        park.push(
          ...ids.slice(0, Math.max(last, 0)).filter((id) => !removed.has(id)),
        );
        const evicted = [...removed].filter(belongs);
        if (!evicted.length) continue;
        for (const id of evicted) range.observed.delete(id);
        const covered = new Set(
          [...range.links.values()].flatMap((link) => link.groups.flat()),
        );
        if (evicted.some((id) => !covered.has(id))) {
          // A live-tail body may not yet be part of any page link.
          range.next = undefined;
          continue;
        }
        for (const [before, link] of acquired(range)) {
          if (has(link, (id) => removed.has(id))) {
            range.next = before;
            break;
          }
        }
      }
      const parked = new Set(park);
      return ordered.filter((id) => parked.has(id));
    },
  };
}
