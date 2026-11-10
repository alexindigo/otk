// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Transcript } from "../transcript.ts";
import { cfg } from "../../../tests/support/config.ts";

Deno.test("V2 first normal metadata observation establishes authority without retiring an opening page", async () => {
  const notices: unknown[] = [];
  const transcript = new Transcript({
    client() {
      throw new Error("No body reads");
    },
    policy: cfg().messages,
    content() {},
    diagnostic() {},
    invalidated: (value) => notices.push(value),
  });
  const raw = {
    id: "ses_initial",
    projectID: "global",
    location: { directory: "/project" },
    time: { created: 1, updated: 1 },
  } as Parameters<Transcript["observe"]>[0];
  try {
    transcript.subscriptions("opcv2-ses_initial", 1);
    transcript.observe(raw);
    assertEquals(notices, []);
    transcript.observe({ ...raw, revert: { messageID: "msg_boundary" } });
    assertEquals(notices.length, 1);
  } finally {
    await transcript.stop();
  }
});
