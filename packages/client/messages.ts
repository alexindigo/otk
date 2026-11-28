// SPDX-License-Identifier: LGPL-3.0-only
import type { Message } from "@otk/protocol";
import { projectTranscript } from "./transcript-projection.ts";
export function queuedMessages(
  messages: readonly Message[],
  busy: boolean,
): Set<string> {
  return projectTranscript(messages, { busy }).queuedIDs;
}
