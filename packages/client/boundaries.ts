// SPDX-License-Identifier: LGPL-3.0-only
import type { Activity, Message, Part } from "@otk/protocol";

/** Producer-declared boundary facts, independent of the part's wording. */
export function boundaryActivity(part: Part): Activity | undefined {
  return part.kind === "external" && part.activity?.layout === "boundary"
    ? part.activity
    : undefined;
}

export function boundaryKey(part: Part): string {
  return part.id;
}

/** A context message whose records include a producer-declared boundary. */
export function sessionBoundary(
  message: Message,
): { part: Part; key: string } | undefined {
  if (message.role !== "context") return;
  const part = message.parts.find(boundaryActivity);
  return part && { part, key: boundaryKey(part) };
}
