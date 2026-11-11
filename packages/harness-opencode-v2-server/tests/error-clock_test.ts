// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Transcript } from "../transcript.ts";
import { cfg } from "../../../tests/support/config.ts";

Deno.test("V2 session diagnostics use the body replay clock without forcing page replacement", async () => {
  const frames: { op: string; seq?: number }[] = [];
  const transcript = new Transcript({
    client() {
      throw new Error("Diagnostics require no body read");
    },
    policy: cfg().messages,
    content: (_id, event, clock) =>
      frames.push({ op: event.op, seq: clock?.seq }),
    invalidated() {
      throw new Error("Diagnostics must not invalidate acquired source");
    },
    diagnostic(error) {
      throw error;
    },
  });
  const id = "opcv2-ses_diagnostic";
  try {
    transcript.subscriptions(id, 1);
    transcript.error(id, { revision: 1, observations: [] });
    transcript.error(id, { revision: 2, observations: [] });
    assertEquals(frames, [
      { op: "session.error", seq: 1 },
      { op: "session.error", seq: 2 },
    ]);
  } finally {
    await transcript.stop();
  }
});
