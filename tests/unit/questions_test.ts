// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapQuestion } from "../../sidecar/adapter/opencode1/questions.ts";
import { emptyContent, reduce } from "../../web/src/state/reduce.ts";
Deno.test("questions normalize defaults and replace/remove requests without leaking raw fields", () => {
  const request = mapQuestion({
    id: "q",
    sessionID: "s",
    questions: [{
      header: "Choice",
      question: "Choose",
      options: [{ label: "One" }],
    }],
  });
  assertEquals(request.questions[0], {
    header: "Choice",
    text: "Choose",
    options: [{ label: "One", description: undefined }],
    multiple: false,
    custom: true,
  });
  let state = reduce(emptyContent(), { op: "question.upsert", request });
  state = reduce(state, { op: "question.upsert", request });
  assertEquals(state.questions.length, 1);
  state = reduce(state, {
    op: "question.remove",
    requestID: "q",
    sessionID: "s",
  });
  assertEquals(state.questions, []);
});
