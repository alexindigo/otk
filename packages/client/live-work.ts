// SPDX-License-Identifier: LGPL-3.0-only
import {
  derivedValue,
  type InboxSnapshot,
  type IndexEntry,
  type Message,
  type ToolCall,
} from "@otk/protocol";
import { inboxStatus } from "./inbox.ts";
import type { ClientTabs } from "./tabs.ts";

export interface RunningWork {
  id: string;
  kind: "helper" | "shell";
  label: string;
  title: string;
  sessionID: string;
  startedAt?: number;
}

/** Borrow existing family, lamp and loaded tool evidence. No new content demand
 * or independent running-state cache; missing clocks remain unknown. */
export function runningWork(input: {
  tabs: ClientTabs;
  inbox: InboxSnapshot;
  sessionID: string;
  entry(id: string): IndexEntry | undefined;
  messages: readonly Message[];
  connected: boolean;
}): RunningWork[] {
  if (!input.connected) return [];
  const items: RunningWork[] = [];
  for (const crumb of input.tabs.family()) {
    const entry = input.entry(crumb.id);
    if (
      !crumb.helper || !entry || inboxStatus(entry, input.inbox) !== "working"
    ) continue;
    const progress = derivedValue(entry.digest.helper?.progress);
    items.push({
      id: `helper/${entry.id}`,
      kind: "helper",
      label: derivedValue(entry.digest.last)?.agent ?? "Helper",
      title: entry.title,
      sessionID: entry.id,
      startedAt: progress?.time?.end === undefined
        ? progress?.time?.start
        : undefined,
    });
  }
  const current = input.entry(input.sessionID);
  // Persisted running tool rows cannot outlive the session's fresh work evidence.
  if (!current || inboxStatus(current, input.inbox) !== "working") return items;
  const shells = new Set<string>();
  const tools = (calls: readonly ToolCall[]) => {
    for (const call of calls) {
      if (
        call.tool === "bash" && call.status === "running" &&
        !call.time.waitsForUser && !shells.has(call.callID)
      ) {
        shells.add(call.callID);
        items.push({
          id: `shell/${call.callID}`,
          kind: "shell",
          label: "Shell",
          title: call.description || call.title || call.command,
          sessionID: input.sessionID,
          startedAt: call.time.start,
        });
      }
      if (call.children) tools(call.children);
    }
  };
  for (const message of input.messages) {
    if (message.sessionID !== input.sessionID) continue;
    for (const part of message.parts) {
      if (part.kind === "tool") tools([part.call]);
      if (
        part.kind !== "external" || part.activity?.work?.kind !== "shell" ||
        part.activity.state?.facts.active !== true
      ) continue;
      items.push({
        id: `shell/${message.id}/${part.id}`,
        kind: "shell",
        label: "Shell",
        title: part.activity.detail || part.activity.title,
        sessionID: input.sessionID,
        startedAt: message.time.created,
      });
    }
  }
  return items;
}

export function runningWorkLabel(items: readonly RunningWork[]): string {
  return (["helper", "shell"] as const).flatMap((kind) => {
    const count = items.filter((item) => item.kind === kind).length;
    return count ? [`${count} ${kind}${count === 1 ? "" : "s"}`] : [];
  }).join(", ");
}
