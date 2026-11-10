// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapTool } from "../map.ts";
Deno.test("V2 user interaction declines are denied while execution interruption remains an error", () => {
  for (
    const [message, expected] of [
      ["The user dismissed this question", "denied"],
      ["The user declined this tool call", "denied"],
      ["Interaction cancelled because the location shut down", "error"],
    ]
  ) {
    const tool = mapTool({
      type: "tool",
      id: "call_decline",
      name: "question",
      time: { created: 1, completed: 2 },
      state: {
        status: "error",
        input: { questions: [] },
        error: { type: "aborted", message },
      },
    });
    assertEquals(tool.status, expected);
  }
});
