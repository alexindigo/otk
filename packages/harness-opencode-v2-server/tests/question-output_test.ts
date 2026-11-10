// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapTool } from "../map.ts";
Deno.test("V2 completed questions retain native answer values and order", () => {
  const tool = mapTool({
    type: "tool",
    id: "call_question",
    name: "question",
    time: { created: 1, completed: 2 },
    state: {
      status: "completed",
      input: {
        questions: [{ question: "Choose output", options: [] }, {
          question: "Choose details",
          options: [],
        }],
      },
      content: [{ type: "text", text: "User answered." }],
      metadata: { answers: [["Typed"], ["Tools", "Custom detail"]] },
    },
  });
  assertEquals(tool.tool, "question");
  if (tool.tool === "question") {
    assertEquals(tool.questions.map((question) => question.answer), [
      ["Typed"],
      ["Tools", "Custom detail"],
    ]);
  }
});
