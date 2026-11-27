// SPDX-License-Identifier: LGPL-3.0-only
import type { Activity, Message, Part } from "@otk/protocol";

/** Producer-declared boundary facts, independent of the part's wording. */
export function boundaryActivity(part: Part): Activity | undefined {
  return part.kind === "external" && part.activity?.layout === "boundary"
    ? part.activity
    : undefined;
}

export function boundaryKey(part: Part): string {
  return boundaryActivity(part)?.boundary?.key ?? part.id;
}

/** A context message whose records include a producer-declared boundary. */
export function sessionBoundary(
  message: Message,
): { part: Part; key: string } | undefined {
  if (message.role !== "context") return;
  const part = message.parts.find(boundaryActivity);
  return part && { part, key: boundaryKey(part) };
}

/** The first member anchors the entry; its newest record supplies the current
 * lifecycle and summary to the single-record renderer. */
export function boundaryRepresentative(
  members: readonly string[] | undefined,
): string | undefined {
  return members?.at(-1);
}
