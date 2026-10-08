// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { mapTool } from "../../sidecar/adapter/opencode1/map-tools.ts";
import type { RawPart } from "../../sidecar/adapter/opencode1/types.ts";
Deno.test("recorded opencode 1.18.34 todo and question calls become OTK shapes", async () => {
  const parts: RawPart[] = JSON.parse(
    await Deno.readTextFile(
      new URL("../fixtures/opencode1/m3-todo-question.json", import.meta.url),
    ),
  );
  const todo = mapTool(parts[0]);
  assert(todo.tool === "todo");
  assertEquals(todo.items.map((item) => [item.content, item.status]), [
    ["pending item", "pending"],
    ["in_progress item", "in_progress"],
    ["completed item", "completed"],
    ["cancelled item", "cancelled"],
  ]);
  const question = mapTool(parts[1]);
  assert(question.tool === "question");
  assertEquals(question.questions, [{
    text: "Which rendering?",
    options: [{ label: "Typed", description: "OTK shapes" }, {
      label: "Raw",
      description: "Harness types",
    }],
    answer: ["Typed"],
  }]);
  for (const call of [todo, question]) {
    assertEquals(call.status, "completed");
    for (
      const field of [
        "metadata",
        "state",
        "input",
        "sessionId",
        "subagent_type",
      ]
    ) assert(!JSON.stringify(call).includes(`"${field}"`));
  }
});
