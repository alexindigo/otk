// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapMessage } from "../map.ts";
import type { NativeMessage } from "../messages.ts";

Deno.test("native helper error envelopes carry public cause and recovery beside the activity", () => {
  const message = mapMessage(
    {
      id: "msg_helper",
      type: "synthetic",
      time: { created: 200 },
      description: "SD settings store helper",
      text:
        '<subagent sessionID="ses_child" state="error" description="SD settings store helper">\nUsage limit reached\n</subagent>',
      metadata: {
        source: "subagent",
        childID: "ses_child",
        agent: "junior",
        state: "error",
      },
    } as NativeMessage,
    "opcv2-ses_parent",
    { order: 1 },
  );
  const part = message.parts[0];
  assertEquals(part.kind, "external");
  if (part.kind !== "external") throw new Error("Missing record");
  assertEquals(part.activity?.title, "failed");
  assertEquals(part.activity?.summary?.plural, "helpers failed");
  assertEquals(part.failure?.facts?.reason, "Usage limit reached");
  assertEquals(part.failure?.facts?.target?.sessionID, "opcv2-ses_child");
  assertEquals(
    part.failure?.facts?.recovery,
    "Check your provider credits or usage limits, then retry the task.",
  );
});
