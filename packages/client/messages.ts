// SPDX-License-Identifier: LGPL-3.0-only
import type { Message } from "@otk/protocol";
import { createTranscriptProjection } from "./transcript-projection.ts";
export function queuedMessages(
  messages: readonly Message[],
  busy: boolean,
): Set<string> {
  const projection = createTranscriptProjection();
  projection.replace(messages);
  projection.busy(busy);
  return projection.state.queuedIDs;
}
