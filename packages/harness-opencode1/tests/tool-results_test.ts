// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapTool } from "../map-tools.ts";
import type { RawPart } from "../types.ts";

Deno.test("every typed and external tool retains native output, including empty and absent results", () => {
  for (
    const tool of [
      "bash",
      "read",
      "glob",
      "grep",
      "list",
      "webfetch",
      "websearch",
      "skill",
      "task",
      "edit",
      "write",
      "apply_patch",
      "todowrite",
      "question",
      "mcp__fixture",
      "unknown_fixture",
    ]
  ) {
    for (const status of ["running", "completed", "error"] as const) {
      for (const output of [undefined, "", "native result\nsecond line\n"]) {
        const part: RawPart = {
          id: "part",
          sessionID: "session",
          messageID: "message",
          type: "tool",
          callID: "call",
          tool,
          state: { status, input: {}, output },
        };
        const call = mapTool(part);
        assertEquals(
          call.output,
          tool === "bash" ? output ?? "" : output,
          `${tool}/${status}/${JSON.stringify(output)}`,
        );
      }
    }
  }
});
