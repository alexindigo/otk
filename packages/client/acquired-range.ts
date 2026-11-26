// SPDX-License-Identifier: LGPL-3.0-only
import {
  compareMessages,
  compareTranscriptVersion,
  type ContentClock,
  type Message,
  type MessageCursor,
  type MessagePage,
  type TranscriptVersion,
} from "@otk/protocol";

interface PageLink {
  groups: string[][];
  older: MessageCursor | null;
}

/** Owns coverage, not bodies. A cursor is the first unacquired boundary. */
export function createAcquiredRange() {
  const links = new Map<MessageCursor | undefined, PageLink>();
  // undefined: the newest boundary needs reading; null: native exhaustion.
  let next: MessageCursor | null | undefined;
  const known = (link: PageLink, matches: (id: string) => boolean) =>
    link.groups.some((ids) => ids.some(matches));
  const install = (
    before: MessageCursor | undefined,
    older: MessageCursor | null,
    groups: string[][],
  ) => {
    links.set(before, { groups, older });
    next = older;
  };
  function* acquired() {
    let before: MessageCursor | undefined;
    while (before !== next) {
      const link = links.get(before);
      if (!link) return;
      yield { before, link };
      if (link.older === null) return;
      before = link.older;
    }
  }
  const retireBeyondFrontier = () => {
    const proven = new Set([...acquired()].map(({ before }) => before));
    for (const before of links.keys()) {
      if (!proven.has(before)) links.delete(before);
    }
  };
  return {
    get next() {
      return next;
    },
    clear() {
      next = undefined;
      links.clear();
    },
    known: (id: string) =>
      [...links.values()].some((p) => known(p, (key) => key === id)),
    visit(visible: ReadonlySet<string>, visited: Set<string>) {
      for (const { groups } of links.values()) {
        for (const ids of groups) {
          if (ids.some((id) => visible.has(id))) {
            for (const id of ids) visited.add(id);
          }
        }
      }
    },
    replace(
      page: MessagePage,
      previous: readonly Message[],
      version: TranscriptVersion | undefined,
      clock: ContentClock | undefined,
    ) {
      const first = page.items[0];
      const exact = !!version && !!clock &&
        compareTranscriptVersion(version, page.version) === 0 &&
        page.from.epoch === clock.epoch && page.from.seq === clock.seq &&
        page.clock.epoch === clock.epoch && page.clock.seq === clock.seq;
      const held = new Set(previous.map((m) => m.id));
      const adjacent = page.older !== null &&
        [...acquired()].some(({ before }) => before === page.older);
      const overlap = page.items.some((m) => held.has(m.id));
      const prefix = exact && first && page.older !== null &&
          (adjacent || overlap)
        ? previous.filter((m) => compareMessages(m, first) < 0)
        : [];
      // Reuse the older frontier only if the joined prefix reaches it. When
      // reattaching the live tail, only the fresh cursor certifies the way back.
      const older = prefix.length && next !== undefined ? next : page.older;
      const groups = [page.items.map((m) => m.id)];
      if (prefix.length) {
        const remaining = new Set(prefix.map((m) => m.id));
        for (const { groups: prior } of links.values()) {
          for (const ids of prior) {
            const retained = ids.filter((id) => remaining.delete(id));
            if (retained.length) groups.push(retained);
          }
        }
        if (remaining.size) groups.push([...remaining]);
      }
      links.clear();
      install(undefined, older, groups);
      return { prefix, exact };
    },
    extend(
      before: MessageCursor,
      older: MessageCursor | null,
      messages: readonly Message[],
    ) {
      if (before !== next) throw new Error("Unacquired message boundary");
      retireBeyondFrontier();
      if (older !== null && (older === before || links.has(older))) {
        throw new Error("Message cursor did not advance");
      }
      install(before, older, [messages.map((m) => m.id)]);
    },
    evict(ordered: readonly string[], removed: ReadonlySet<string>) {
      const last = ordered.findLastIndex((id) => removed.has(id));
      const park = ordered.slice(0, last).filter((id) => !removed.has(id));
      const head = links.get(undefined);
      const covered = new Set(
        [...links.values()].flatMap((p) => p.groups.flat()),
      );
      if (
        [...removed].some((id) => !covered.has(id)) ||
        head && known(head, (id) => removed.has(id))
      ) {
        // Evicting a live-tail body can retire the head cursor itself.
        next = undefined;
        return park;
      }
      for (const { before, link } of acquired()) {
        if (known(link, (id) => removed.has(id))) {
          next = before;
          break;
        }
      }
      return park;
    },
  };
}
