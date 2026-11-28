// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { deliveryReceipt } from "../delivery.ts";
Deno.test("V2 delivery requires a received result, not a completed background launch", () => {
  const tool = {
    type: "tool",
    name: "subagent",
    time: { created: 10, completed: 30 },
    state: {
      status: "completed",
      metadata: { sessionID: "child", status: "running" },
      content: [{ type: "text", text: "result" }],
    },
  };
  assertEquals(deliveryReceipt(tool, "call", 30), undefined);
  tool.state.metadata.status = "completed";
  assertEquals(deliveryReceipt(tool, "call", 30)?.started, 10);
  tool.state.content = [];
  assertEquals(deliveryReceipt(tool, "call", 30), undefined);
});
Deno.test("V2 received failed and cancelled reports are delivery, but unknown identities and states are not", () => {
  for (const state of ["completed", "error", "cancelled"]) {
    assert(
      deliveryReceipt(
        {
          type: "synthetic",
          metadata: { source: "subagent", childID: "child", state },
        },
        "report",
        40,
      ),
    );
  }
  for (const state of ["running", "unknown"]) {
    assertEquals(
      deliveryReceipt(
        {
          type: "synthetic",
          metadata: { source: "subagent", childID: "child", state },
        },
        "report",
        40,
      ),
      undefined,
    );
  }
  assertEquals(
    deliveryReceipt(
      {
        type: "synthetic",
        metadata: { source: "subagent", childID: "bad/id", state: "completed" },
      },
      "report",
      40,
    ),
    undefined,
  );
  assertEquals(
    deliveryReceipt(
      {
        type: "job",
        metadata: { source: "subagent", childID: "child", state: "completed" },
      },
      "removed",
      40,
    ),
    undefined,
  );
});
