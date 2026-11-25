// SPDX-License-Identifier: LGPL-3.0-only
import type { Activity } from "@otk/protocol";
import type { TranscriptReply } from "./transcript-projection.ts";

export interface ActivityGroup {
  key: string;
  members: string[];
  title: string;
  entity?: Activity["entity"];
  detail?: string;
  count?: number;
  time?: { first: number; last?: number };
  children?: ActivityGroup[];
  revision: number;
  direction?: Activity["direction"];
  category?: Activity["category"];
}
export interface RecordProjection {
  revision: number;
  keys: string[];
  groups: Record<string, ActivityGroup>;
  parents: Record<string, string[]>;
  owners: Record<string, string>;
  revisions: Record<string, number>;
}
/** Opaque native kinds are never decoded by the client. */
function foldable(reply: TranscriptReply | undefined): Activity | undefined {
  const message = reply?.message;
  if (
    !message || reply.pending || message.role !== "context" ||
    reply.messageIDs.length !== 1 || message.parts.length !== 1
  ) return;
  const part = message.parts[0];
  if (part.kind !== "external" || part.failure) return;
  const activity = part.activity;
  if (
    !activity?.summary || activity.layout !== "row" ||
    activity.tone === "error" ||
    activity.state?.facts.active ||
    activity.state && activity.state.facts.terminal !== true
  ) return;
  return activity;
}
// Full source facts, not headings, define equality. Record/part IDs and the
// envelope clock are identity, not content. Native source references remain facts.
function signature(reply: TranscriptReply): string {
  const part = reply.message.parts[0];
  const { id: _id, ...facts } = part;
  return JSON.stringify([facts, reply.message.source]);
}
const empty = (): RecordProjection => ({
  revision: 0,
  keys: [],
  groups: Object.create(null),
  parents: Object.create(null),
  owners: Object.create(null),
  revisions: Object.create(null),
});

/** Owned by the canonical transcript. Topology is assigned at first admission;
 * terminal updates never absorb an already presented individual record. */
export function createRecordProjection(): {
  clear(): void;
  retire(id: string): void;
  update(key: string, sourceRevision: number): RecordProjection;
  reconcile(
    ids: readonly string[],
    replies: Readonly<Record<string, TranscriptReply>>,
  ): RecordProjection;
} {
  let value = empty();
  const assignment = new Map<string, string>();
  const children = new Map<string, string>();
  const permanentRows = new Set<string>();
  const versions = new Map<string, { facts: string; revision: number }>();
  let presentationRevision = 0;
  const revision = (key: string, facts: unknown) => {
    const next = JSON.stringify(facts), old = versions.get(key);
    if (old?.facts === next) return old.revision;
    const revision = ++presentationRevision;
    versions.set(key, { facts: next, revision });
    return revision;
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
      children.delete(id);
      permanentRows.delete(id);
    },
    clear() {
      value = empty();
      assignment.clear();
      children.clear();
      permanentRows.clear();
      versions.clear();
    },
    reconcile(
      ids: readonly string[],
      replies: Readonly<Record<string, TranscriptReply>>,
    ): RecordProjection {
      const next = empty();
      const splitOrigins = new Map<string, string>();
      let previous: string | undefined;
      for (const id of ids) {
        const activity = foldable(replies[id]);
        let key = assignment.get(id);
        if (!activity) {
          permanentRows.add(id);
          key = id;
          children.delete(id);
        } else if (!key) {
          key = previous && next.groups[previous] &&
              next.groups[previous].direction === activity.direction
            ? previous
            : `activity:${id}`;
        }
        if (permanentRows.has(id)) key = id;
        // An explicit failure/removal may split a span, never reorder records
        // around the breakout row or reconnect across that boundary later.
        if (key !== id && next.groups[key!] && previous !== key) {
          const origin = key!;
          key = previous && splitOrigins.get(previous) === origin
            ? previous
            : `activity:${id}`;
          splitOrigins.set(key, origin);
          children.delete(id);
        }
        assignment.set(id, key!);
        next.owners[id] = key!;
        if (key === id) {
          next.keys.push(id);
          next.revisions[id] = revision(id, replies[id].revision);
        } else {
          let group = next.groups[key!];
          if (!group) {
            next.keys.push(key!);
            group = next.groups[key!] = {
              key: key!,
              members: [],
              title: "Activity",
              direction: activity!.direction,
              children: [],
              revision: 0,
            };
          }
          group.members.push(id);
          const prior = group.children!.at(-1);
          let childKey = children.get(id);
          if (
            childKey && (
              prior?.key === childKey
                ? signature(replies[prior.members[0]]) !==
                  signature(replies[id])
                : group.children!.some((row) => row.key === childKey)
            )
          ) {
            // Retained identity cannot reconnect a fold across intervening facts.
            childKey = undefined;
          }
          if (!childKey) {
            childKey = prior &&
                signature(replies[prior.members[0]]) === signature(replies[id])
              ? prior.key
              : `records:${id}`;
            children.set(id, childKey);
          }
          let child = group.children!.find((row) => row.key === childKey);
          if (!child) {
            child = {
              key: childKey,
              members: [],
              title: activity!.title,
              entity: activity!.entity,
              detail: activity!.detail,
              direction: activity!.direction,
              category: activity!.category,
              revision: 0,
            };
            group.children!.push(child);
          }
          child.members.push(id);
          child.count = child.members.length;
          next.parents[id] = [key!, childKey];
        }
        previous = key;
      }
      for (const group of Object.values(next.groups)) {
        if (group.members.length === 1) {
          const id = group.members[0];
          // A presented singleton is an individual record for its lifetime.
          // Later appends can start a span, never replace this row's component.
          permanentRows.add(id);
          assignment.set(id, id);
          children.delete(id);
          next.keys[next.keys.indexOf(group.key)] = id;
          next.owners[id] = id;
          delete next.parents[id];
          delete next.groups[group.key];
          next.revisions[id] = revision(id, replies[id].revision);
          continue;
        }
        const counts = new Map<
          string,
          { noun: string; plural: string; count: number }
        >();
        for (const id of group.members) {
          const summary = foldable(replies[id])?.summary;
          if (!summary) continue;
          const count = counts.get(summary.kind) ?? { ...summary, count: 0 };
          count.count++;
          counts.set(summary.kind, count);
        }
        group.detail = [...counts.values()].map((v) =>
          `${v.count} ${v.count === 1 ? v.noun : v.plural}`
        ).join(" · ");
        const first = replies[group.members[0]].message.time.created;
        const last = replies[group.members.at(-1)!].message.time.created;
        group.time = { first, ...(last === first ? {} : { last }) };
        for (const child of group.children!) {
          child.revision = revision(
            child.key,
            child.members.map((id) => [id, signature(replies[id])]),
          );
        }
        group.revision = revision(group.key, [
          group.members,
          group.detail,
          group.time,
          group.children,
        ]);
        next.revisions[group.key] = group.revision;
      }
      const retained = new Set(Object.values(next.parents).flat());
      for (const key of next.keys) retained.add(key);
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
