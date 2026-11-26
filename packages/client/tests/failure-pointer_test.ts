// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { PublicFailure } from "@otk/protocol";
import { composerPointer, presentFailure } from "../failure-features.ts";
import { createTranscriptProjection } from "../transcript-projection.ts";

const view = { sessionID: "opcv1-ses_pointer" };
const failure: PublicFailure = {
  code: "native.rejected",
  retry: "new-intent",
  diagnosticID: "rejected-send",
  facts: {
    actionLabel: "Sending prompt",
    origin: "composer",
    reason: "Invalid configuration",
    record: { messageID: "record" },
    target: view,
  },
};

for (const local of [false, true]) {
  Deno.test(
    `composer shows one failure after revert removes its record (${
      local ? "local" : "observed"
    })`,
    () => {
      const transcript = createTranscriptProjection();
      transcript.replace([{
        id: "record",
        sessionID: view.sessionID,
        role: "context",
        time: { created: 1 },
        parts: [],
      }]);
      const hasRecord = (id: string) =>
        transcript.state.messageIDs.includes(id);
      const show = () =>
        composerPointer(
          [failure],
          view,
          local ? presentFailure(failure) : undefined,
          hasRecord,
        );
      assertEquals(show()?.failure?.reference?.messageID, "record");

      // A revert publishes message removals through the transcript owner.
      transcript.apply({ op: "message.remove", messageID: "record" });
      const shown = show();
      assertEquals(shown?.failure?.reference, undefined);
      assertEquals(shown?.failure?.heading, "Sending prompt failed");
      assertEquals(shown?.failure?.reason, "Invalid configuration");
      assertEquals(shown?.diagnosticID, failure.diagnosticID);
    },
  );
}
