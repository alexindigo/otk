// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapTool, sharedToolName } from "../map.ts";

Deno.test("V2 tool names have one shared identity while retaining native source names", () => {
  for (
    const [native, shared] of [["shell", "bash"], ["subagent", "task"], [
      "read",
      "read",
    ], ["custom", "custom"]]
  ) {
    assertEquals(sharedToolName(native), shared);
  }
  for (const [name, kind] of [["shell", "bash"], ["subagent", "task"]]) {
    const call = mapTool({
      type: "tool",
      id: "call_fixture",
      name,
      state: {
        status: "running",
        input: { command: "pwd", agent: "general", description: "Helper" },
        metadata: {},
      },
      time: { created: 1 },
    });
    assertEquals(call.tool, kind);
    assertEquals(call.sourceName, name);
  }
});
