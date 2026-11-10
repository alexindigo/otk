// SPDX-License-Identifier: LGPL-3.0-only
import { sessionAncestors, type SessionLookup } from "@otk/protocol";

/** One projection for native request ownership, including every loaded ancestor. */
export function pendingAttention(
  id: string,
  requests: Iterable<
    { sessionID: string; kind: "permission" | "form"; stale?: boolean }
  >,
  lookup: SessionLookup,
) {
  const attention = {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  };
  let stale = false;
  for (const request of requests) {
    const direct = request.sessionID === id;
    if (!direct && !sessionAncestors(request.sessionID, lookup).includes(id)) {
      continue;
    }
    stale ||= !!request.stale;
    if (request.kind === "permission") {
      if (direct) attention.permissions++;
      else attention.childPermissions++;
    } else if (direct) attention.questions++;
    else attention.childQuestions++;
  }
  return { attention, stale };
}
