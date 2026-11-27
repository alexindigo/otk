// SPDX-License-Identifier: LGPL-3.0-only
import type { Activity } from "@otk/protocol";
import type { TranscriptReply } from "./transcript-projection.ts";
import { workLogBookkeeping } from "./record-folds.ts";
import { sessionBoundary } from "./boundaries.ts";

export interface ActivityGroup {
  key: string;
  members: string[];
  title: string;
  entity?: Activity["entity"];
  child?: Activity["child"];
  detail?: string;
  count?: number;
  time?: { first: number; last?: number };
  children?: ActivityGroup[];
  revision: number;
  direction?: Activity["direction"];
  category?: Activity["category"];
  /** One frame between conversation messages, independent of admission state. */
  interval?: boolean;
  silent?: boolean;
  completionOf?: string;
  breakouts?: string[];
  /** Client-owned failure wording, separate from producer summary nouns. */
  failureTitle?: string;
}
export interface RecordProjection {
  revision: number;
  keys: string[];
  groups: Record<string, ActivityGroup>;
  parents: Record<string, string[]>;
  /** Final measured child key, separate from its native/disclosure identity. */
  leaves: Record<string, string>;
  owners: Record<string, string>;
  revisions: Record<string, number>;
  /** Successful completion facts belong to the preceding reply's outcome. */
  completions: Record<string, string>;
}
function activity(reply: TranscriptReply | undefined): Activity | undefined {
  const part = reply?.message.parts[0];
  return reply?.message.parts.length === 1 && part?.kind === "external"
    ? part.activity
    : undefined;
}
/** Unknown, pending, active, blocked and failed facts remain visible in place. */
function foldable(reply: TranscriptReply): boolean {
  const value = activity(reply), part = reply.message.parts[0];
  return !!value?.summary && value.layout === "row" && !reply.pending &&
    !(part.kind === "external" && part.failure) && value.tone !== "error" &&
    !value.state?.facts.active &&
    (!value.state || value.state.facts.terminal === true);
}
// Source references and complete facts define equality, never the display title.
function signature(reply: TranscriptReply): string {
  const { id: _id, ...facts } = reply.message.parts[0];
  return JSON.stringify([facts, reply.message.source]);
}
function summary(
  ids: readonly string[],
  replies: Readonly<Record<string, TranscriptReply>>,
  failures = false,
): string {
  if (failures) {
    const count = ids.filter((id) => {
      return replies[id].message.parts.some((part) =>
        part.kind === "external" &&
        (!!part.failure || part.activity?.tone === "error")
      );
    }).length;
    return count ? `${count} failed` : "";
  }
  const counts = new Map<
    string,
    { noun: string; plural: string; count: number }
  >();
  for (const id of ids) {
    const reply = replies[id], value = activity(reply);
    const fact = foldable(reply) && !value?.fold &&
      workLogBookkeeping(reply.message.parts[0]) !== "completion" &&
      value?.summary;
    if (!fact) continue;
    const count = counts.get(fact.kind) ?? { ...fact, count: 0 };
    count.count++;
    counts.set(fact.kind, count);
  }
  return [...counts.values()].map((v) =>
    `${v.count} ${v.count === 1 ? v.noun : v.plural}`
  ).join(", ");
}
const empty = (): RecordProjection => ({
  revision: 0,
  keys: [],
  groups: Object.create(null),
  parents: Object.create(null),
  leaves: Object.create(null),
  owners: Object.create(null),
  revisions: Object.create(null),
  completions: Object.create(null),
});

/** Canonical interval identity is minted at first admission, not settlement.
 * Eligibility affects child presentation only, never the root partition. */
export function createRecordProjection(): {
  clear(): void;
  retire(id: string): void;
  update(key: string, sourceRevision: number): RecordProjection;
  reconcile(
    ids: readonly string[],
    replies: Readonly<Record<string, TranscriptReply>>,
    breaks?: ReadonlySet<string>,
  ): RecordProjection;
} {
  let value = empty(), presentationRevision = 0;
  const assignment = new Map<string, string>();
  const versions = new Map<string, { facts: string; revision: number }>();
  const revision = (key: string, facts: unknown) => {
    const next = JSON.stringify(facts), old = versions.get(key);
    if (old?.facts === next) return old.revision;
    const current = ++presentationRevision;
    versions.set(key, { facts: next, revision: current });
    return current;
  };
  return {
    update(key, sourceRevision) {
      if (value.owners[key] !== key) return value;
      const next = revision(key, sourceRevision);
      if (value.revisions[key] === next) return value;
      value = {
        ...value,
        revision: presentationRevision,
        revisions: { ...value.revisions, [key]: next },
      };
      return value;
    },
    retire(id) {
      assignment.delete(id);
    },
    clear() {
      value = empty();
      assignment.clear();
      versions.clear();
    },
    reconcile(ids, replies, breaks = new Set()) {
      const next = empty();
      // The projection owns one keyspace for conversation rows and intervals.
      const occupied = new Set(ids);
      const allocate = (id: string, assigned?: string) => {
        const base = `activity:${id}`;
        let key = assigned && !occupied.has(assigned) ? assigned : base;
        for (let n = 1; occupied.has(key); n++) key = `${base}:${n}`;
        occupied.add(key);
        return key;
      };
      let interval: ActivityGroup | undefined, conversation: string | undefined;
      let contextEnd = 0, contextHasContent = false;
      for (let index = 0; index < ids.length; index++) {
        if (index > 0 && breaks.has(ids[index - 1])) {
          interval = undefined;
          conversation = undefined;
        }
        const id = ids[index];
        const reply = replies[id];
        const boundary = sessionBoundary(reply.message);
        if (
          !boundary && reply.message.role === "context" && index >= contextEnd
        ) {
          contextEnd = index;
          contextHasContent = false;
          while (
            contextEnd < ids.length &&
            replies[ids[contextEnd]].message.role === "context" &&
            !sessionBoundary(replies[ids[contextEnd]].message)
          ) {
            contextHasContent ||= !!replies[ids[contextEnd]].message.parts
              .length;
            if (breaks.has(ids[contextEnd++])) break;
          }
        }
        // Headers alone cannot offer an activity disclosure. Once the interval
        // has content, retain every source row, including empty breakouts.
        if (
          boundary || reply.message.role !== "context" || !contextHasContent
        ) {
          interval = undefined;
          conversation = id;
          next.keys.push(id);
          next.owners[id] = id;
          next.revisions[id] = revision(id, reply.revision);
          continue;
        }
        if (!interval) {
          // Paging an older member must not replace the already minted frame.
          let assigned = assignment.get(id);
          if (!assigned) {
            for (let n = index + 1; n < contextEnd; n++) {
              assigned = assignment.get(ids[n]);
              if (assigned) break;
            }
          }
          const key = allocate(id, assigned);
          interval = next.groups[key] = {
            key,
            members: [],
            title: "",
            children: [],
            breakouts: [],
            interval: true,
            silent: true,
            revision: 0,
          };
          next.keys.push(key);
          if (
            conversation && replies[conversation].message.role === "assistant"
          ) {
            interval.completionOf = conversation;
            next.completions[conversation] = key;
          }
        }
        assignment.set(id, interval.key);
        if (!interval.members.length) {
          interval.direction = activity(reply)?.direction;
        } else if (interval.direction !== activity(reply)?.direction) {
          interval.direction = undefined;
        }
        interval.members.push(id);
        next.owners[id] = interval.key;
        const safe = foldable(reply), facts = activity(reply);
        if (!safe) interval.breakouts!.push(id);
        if (
          !safe || workLogBookkeeping(reply.message.parts[0]) !== "completion"
        ) {
          interval.silent = false;
        }
        const previous = interval.children!.at(-1);
        if (
          safe && previous && foldable(replies[previous.members[0]]) &&
          signature(replies[previous.members[0]]) === signature(reply)
        ) {
          previous.members.push(id);
          previous.count = previous.members.length;
        } else {
          interval.children!.push({
            key: `records:${id}`,
            members: [id],
            title: facts?.title ?? "",
            entity: facts?.entity,
            child: facts?.child,
            detail: facts?.detail,
            category: facts?.category,
            direction: facts?.direction,
            revision: 0,
          });
        }
      }
      for (const group of Object.values(next.groups)) {
        group.title = summary(group.members, replies);
        group.failureTitle = summary(group.members, replies, true);
        for (const child of group.children!) {
          for (const id of child.members) {
            next.parents[id] = child.count
              ? [group.key, child.key]
              : [group.key];
            next.leaves[id] = child.count ? id : child.key;
          }
          child.revision = revision(
            child.key,
            child.members.map((id) => [id, replies[id].revision]),
          );
        }
        group.revision = revision(group.key, [
          group.members,
          group.title,
          group.silent,
          group.breakouts,
          group.children,
          group.failureTitle,
          group.completionOf,
        ]);
        next.revisions[group.key] = group.revision;
        const previous = value.groups[group.key];
        if (previous?.revision === group.revision) {
          next.groups[group.key] = previous;
        }
      }
      const groupKeys = Object.keys(next.groups);
      if (
        groupKeys.length === Object.keys(value.groups).length &&
        groupKeys.every((key) => next.groups[key] === value.groups[key])
      ) {
        next.groups = value.groups;
      }
      const retained = new Set([
        ...next.keys,
        ...Object.values(next.parents).flat(),
        ...Object.values(next.groups).flatMap((group) =>
          group.children!.map((child) => child.key)
        ),
      ]);
      for (const key of versions.keys()) {
        if (!retained.has(key)) versions.delete(key);
      }
      next.revision = presentationRevision;
      value = next;
      return value;
    },
  };
}
/** Detached compatibility projection. Shipped views borrow canonical state. */
export function activitySpans(
  ids: readonly string[],
  replies: Readonly<Record<string, TranscriptReply>>,
): RecordProjection {
  return createRecordProjection().reconcile(ids, replies);
}
