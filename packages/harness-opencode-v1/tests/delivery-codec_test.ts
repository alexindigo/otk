// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { deliveryReceipt } from "../delivery.ts";
const envelope = (state: string) =>
  `<task id="child" state="${state}">\n<${
    state === "error" ? "task_error" : "task_result"
  }>\nresult\n</${state === "error" ? "task_error" : "task_result"}>\n</task>`;
Deno.test("V1 completed task launch cannot acknowledge running or missing result envelopes", () => {
  const tool = {
    type: "tool",
    tool: "task",
    state: {
      status: "completed",
      metadata: { sessionId: "child" },
      output: envelope("running"),
      time: { start: 10, end: 30 },
    },
  };
  assertEquals(deliveryReceipt(tool, "call", 30), undefined);
  tool.state.output = envelope("completed");
  assert(deliveryReceipt(tool, "call", 30));
  tool.state.metadata.sessionId = "wrong";
  assertEquals(deliveryReceipt(tool, "call", 30), undefined);
  tool.state.output = "";
  assertEquals(deliveryReceipt(tool, "call", 30), undefined);
});
Deno.test("V1 received failure report acknowledges, but a failed call or ordinary text does not", () => {
  assert(
    deliveryReceipt(
      { type: "text", synthetic: true, text: envelope("error") },
      "report",
      40,
    ),
  );
  assertEquals(
    deliveryReceipt(
      { type: "text", text: envelope("completed") },
      "ordinary",
      40,
    ),
    undefined,
  );
  assertEquals(
    deliveryReceipt(
      {
        type: "tool",
        tool: "task",
        state: {
          status: "error",
          metadata: { sessionId: "child" },
          output: envelope("error"),
        },
      },
      "failed",
      40,
    ),
    undefined,
  );
});
