// SPDX-License-Identifier: LGPL-3.0-only
import type { SavedBranch } from "./branch-history.ts";
import {
  createTranscriptProjection,
  type TranscriptProjectionState,
} from "./transcript-projection.ts";
import {
  type MessagePresentation,
  messagePresentation,
  savedCost,
} from "./message-presentation.ts";

/** All saved-view presentation is admitted here, never through live inference. */
export function savedBranchProjection(
  branch?: Pick<SavedBranch, "messages" | "turns">,
  showCost = true,
): TranscriptProjectionState & {
  presentations: Record<string, MessagePresentation>;
} {
  const owner = createTranscriptProjection();
  owner.replace(branch?.messages ?? []);
  owner.boundaries(
    Object.values(branch?.turns ?? {}).map((turn) => turn.boundary),
  );
  const presentations: Record<string, MessagePresentation> = Object.create(
    null,
  );
  for (const id of owner.state.replyIDs) {
    const message = owner.state.repliesByID[id].message;
    const turnID = message.role === "assistant"
      ? message.replyTo ?? message.id
      : message.id;
    const summary = branch?.turns[turnID]?.summary;
    const presentation = messagePresentation(message, summary, "saved");
    const cost = showCost ? savedCost(summary) : undefined;
    if (cost !== undefined) {
      presentation.facts.push(cost);
    }
    presentations[id] = presentation;
  }
  return { ...owner.state, presentations };
}
