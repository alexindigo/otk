// SPDX-License-Identifier: LGPL-3.0-only
import type { ProjectRecord, ProjectStatus } from "@otk/protocol";
import { age, type TimeText } from "./format.ts";

export type SidebarTiming =
  & { time: TimeText }
  & (
    | { kind: "run"; tone: "muted" }
    | { kind: "attention" | "visit"; tone: "default" }
  );

/** D79: choose a clock and tone from the published lamp, never from age. */
export function sidebarTimer(
  status: ProjectStatus,
  runStartedAt: number | undefined,
  now: number,
  record?: ProjectRecord,
): SidebarTiming | undefined {
  if (status === "working") {
    return runStartedAt === undefined ? undefined : {
      kind: "run",
      tone: "muted",
      time: age(runStartedAt, now, "run"),
    };
  }
  if (!record) return;
  const inactive = status === "none" && record.inactive;
  const attention = status === "blocked" || status === "finished";
  return {
    kind: attention ? "attention" : "visit",
    tone: "default",
    time: age(
      record.lastVisit,
      inactive ? record.inactiveAt ?? record.lastVisit : now,
      inactive ? "inactive" : attention ? "attention" : "now",
    ),
  };
}
