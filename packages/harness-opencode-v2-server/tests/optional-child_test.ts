// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { mapMessage, mapTool } from "../map.ts";
import type { NativeMessage } from "../messages.ts";
import { opencodeV2SessionID as ids } from "../ids.ts";

type Tool = Extract<NativeMessage, { type: "assistant" }>["content"][number] & {
  type: "tool";
};
const tool = (child: string): Tool => ({
  type: "tool",
  id: "call",
  name: "subagent",
  time: { created: 1, completed: 2 },
  state: {
    status: "completed",
    input: { agent: "junior", description: "Inspect" },
    metadata: { sessionID: child },
    content: [{ type: "text", text: "Complete tool output" }],
  },
});

for (
  const child of ["child/path", "child name", "opcv2-child", "child.example"]
) {
  Deno.test(`V2 optional tool child ${child} cannot invalidate its source record`, () => {
    const raw = tool(child), call = mapTool(raw);
    assertEquals(
      "childSessionID" in call ? call.childSessionID : undefined,
      undefined,
    );
    assertEquals(call.output, "Complete tool output");
    assertEquals(
      JSON.parse(call.source!.payload!).state.metadata.sessionID,
      child,
    );
  });
  Deno.test(`V2 optional notice child ${child} cannot invalidate its source record`, () => {
    const raw: NativeMessage = {
      id: "notice",
      type: "synthetic",
      time: { created: 1 },
      text: "Complete native result",
      description: "Inspect",
      metadata: {
        source: "subagent",
        childID: child,
        state: "completed",
        agent: "junior",
      },
    };
    const message = mapMessage(raw, "opcv2-parent", { order: 1 });
    assert(message?.role === "context");
    assertEquals(message.source?.payload, raw.text);
    const part = message.parts[0];
    assert(part.kind === "external");
    assertEquals(part.activity?.title, "Junior finished");
    assertEquals(part.activity?.child, undefined);
    assertEquals(
      part.activity?.parameters?.find((value) => value.key === "sessionID")
        ?.value,
      child,
    );
    assert(JSON.stringify(part.activity?.body).includes(raw.text));
  });
}

Deno.test("V2 optional relationship normalization preserves valid children and strict mandatory identity admission", () => {
  const call = mapTool(tool("ses_A-1"));
  assertEquals(
    "childSessionID" in call ? call.childSessionID : undefined,
    "opcv2-ses_A-1",
  );
  for (
    const child of ["child/path", "child name", "opcv2-child", "child.example"]
  ) {
    assertThrows(() => ids.encode(child));
  }
});
