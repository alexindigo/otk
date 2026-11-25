// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexEntry } from "@otk/protocol";
import { entityKey } from "@otk/protocol";
import {
  createEntityStateStore,
  ENTITY_LABELS,
  type EntityStateStore,
  lamp,
} from "@otk/client";
export const LIGHT_STATES = {
  blocked: { label: ENTITY_LABELS.blocked, shape: "cross" },
  working: { label: ENTITY_LABELS.working, shape: "half-disc" },
  finished: { label: ENTITY_LABELS.finished, shape: "check" },
  none: { label: ENTITY_LABELS.none, shape: "circle" },
} as const;
export type LightState = keyof typeof LIGHT_STATES;
const absent = createEntityStateStore({ read: () => undefined });
/** Lamps render the entity owner; metadata is never a fallback. */
export function sessionLight(
  entry: IndexEntry,
  entities: EntityStateStore = absent,
): LightState {
  return lamp(entities, entityKey("session", entry.id), {
    now: performance.now(),
  });
}
