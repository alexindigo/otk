// SPDX-License-Identifier: LGPL-3.0-only
import type { Activity } from "@otk/protocol";
import type { TranscriptReply } from "./transcript-projection.ts";

export interface ActivityGroup {
  key: string;
  members: string[];
  title: string;
  detail?: string;
  count?: number;
  time?: { first: number; last: number };
  children?: ActivityGroup[];
}

/** Presentation of acquired records only; native states remain opaque. */
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
    !activity || activity.layout !== "row" || activity.tone === "error" ||
    activity.state?.facts.active ||
    activity.state && activity.state.facts.terminal !== true
  ) return;
  return activity;
}

function countText(kind: string, count: number): string {
  const labels: Record<string, [string, string]> = {
    "subagent result": ["helper finished", "helpers finished"],
    "shell result": ["shell", "shells"],
    shell: ["shell", "shells"],
    permission: ["permission", "permissions"],
    execution: ["run", "runs"],
    system: ["system update", "system updates"],
  };
  const word = kind.toLowerCase();
  const label = labels[word] ?? [word, word.endsWith("s") ? word : word + "s"];
  return `${count} ${label[count === 1 ? 0 : 1]}`;
}

/** One owner for span membership, identical subgroups and reveal ancestry. */
export function activitySpans(
  replyIDs: readonly string[],
  repliesByID: Readonly<Record<string, TranscriptReply>>,
) {
  const keys: string[] = [];
  const groups: Record<string, ActivityGroup> = Object.create(null);
  const parents: Record<string, string[]> = Object.create(null);
  const owners: Record<string, string> = Object.create(null);
  let pending: { key: string; activity: Activity }[] = [];
  const flush = () => {
    if (!pending.length) return;
    const members = pending.map((row) => row.key), key = members[0];
    keys.push(key);
    for (const member of members) owners[member] = key;
    if (members.length > 1) {
      const counts = new Map<string, number>();
      const children: ActivityGroup[] = [];
      let signature: string | undefined;
      for (const row of pending) {
        counts.set(
          row.activity.kindLabel,
          (counts.get(row.activity.kindLabel) ?? 0) + 1,
        );
        const next = JSON.stringify([
          row.activity.kindLabel,
          row.activity.title,
          row.activity.detail ?? "",
        ]);
        const previous = children.at(-1);
        if (previous && next === signature) {
          previous.members.push(row.key);
          previous.count = previous.members.length;
        } else {
          children.push({
            key: row.key,
            members: [row.key],
            title: row.activity.title,
            detail: row.activity.detail,
          });
        }
        signature = next;
      }
      groups[key] = {
        key,
        members,
        title: "Activity",
        detail: [...counts].map(([kind, count]) => countText(kind, count)).join(
          " · ",
        ),
        time: {
          first: repliesByID[key].message.time.created,
          last: repliesByID[members.at(-1)!].message.time.created,
        },
        children,
      };
      for (const child of children) {
        for (const member of child.members) {
          parents[member] = [
            key,
            ...(child.count ? [`records:${child.key}`] : []),
          ];
        }
      }
    }
    pending = [];
  };
  for (const key of replyIDs) {
    const activity = foldable(repliesByID[key]);
    if (activity) pending.push({ key, activity });
    else {
      flush();
      keys.push(key);
      owners[key] = key;
    }
  }
  flush();
  return { keys, groups, parents, owners };
}
