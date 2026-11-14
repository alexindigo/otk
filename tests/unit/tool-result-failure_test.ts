// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { toolFailure } from "@otk/client";
import { mapTool, type NativeMessage } from "@otk/harness-opencode-v2-server";

type Tool = Extract<NativeMessage, { type: "assistant" }>["content"][number] & {
  type: "tool";
};

for (
  const text of [undefined, "", "   ", "Explicit failure", "  Exact failure  "]
) {
  for (const nested of [false, true]) {
    Deno.test(`tool result failure evidence survives empty text (text: ${JSON.stringify(text)}, nested: ${nested})`, () => {
      const source: Tool = {
        type: "tool",
        id: "execute",
        name: "execute",
        time: { created: 1, completed: 2 },
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: "" }],
          metadata: nested
            ? {
              toolCalls: [{
                tool: "read",
                status: "error",
                ...(text === undefined ? {} : { error: text }),
              }],
            }
            : { error: true, ...(text === undefined ? {} : { message: text }) },
        },
      };
      const call = mapTool(source);
      const expected = text?.trim()
        ? text
        : nested
        ? "Nested call failed"
        : "Script failed";
      assertEquals(
        call.status,
        "completed",
        "result failure does not rewrite native lifecycle",
      );
      assertEquals(call.failure?.message, expected);
      assertEquals(
        toolFailure(call),
        expected,
        "the shared consumer must see the failure",
      );
      if (nested) assertEquals(call.children?.[0].failure?.message, expected);
      assertEquals(
        JSON.parse(call.source!.payload!),
        JSON.parse(JSON.stringify(source)),
        "source stays exact",
      );
    });
  }
}

Deno.test("successful execute results do not infer failure from empty or diagnostic output", () => {
  for (const output of ["", "Diagnostic output"]) {
    const call = mapTool({
      type: "tool",
      id: "execute",
      name: "execute",
      time: { created: 1, completed: 2 },
      state: {
        status: "completed",
        input: {},
        metadata: { error: false },
        content: [{ type: "text", text: output }],
      },
    });
    assertEquals(call.failure, undefined);
    assertEquals(toolFailure(call), undefined);
    assertEquals(call.status, "completed");
  }
});
