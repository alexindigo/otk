// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createQuestionForm, forgetQuestionForm } from "../mod.ts";
import type { QuestionRequest } from "@otk/protocol";

function request(id: string): QuestionRequest {
  return {
    id,
    sessionID: "session",
    questions: [false, true].map((multiple) => ({
      text: "Choose an answer",
      options: [{ label: "One" }, { label: "Two" }],
      multiple,
      custom: true,
    })),
  };
}
Deno.test("question form keeps typed text while single choices replace the submitted answer", () => {
  const input = request("single-answer");
  try {
    const form = createQuestionForm(input);
    form.typeOwn(0, "  My answer  ");
    assertEquals(form.answers(), [["My answer"], []]);
    form.pick(0, 1);
    assertEquals(form.answers(), [["Two"], []]);
    assertEquals(form.state.drafts[0].own, "  My answer  ");
    assertEquals(form.isOwnChosen(0), false);
    form.chooseOwn(0);
    assertEquals(form.answers(), [["My answer"], []]);
    assertEquals(form.isPicked(0, 1), false);
  } finally {
    forgetQuestionForm(input.id);
  }
});
Deno.test("question form submits multi picks and own answer without empty or deselected values", () => {
  const input = request("multiple-answers");
  try {
    const form = createQuestionForm(input);
    form.pick(1, 0);
    form.pick(1, 1);
    form.typeOwn(1, " More ");
    assertEquals(form.answers(), [[], ["One", "Two", "More"]]);
    form.pick(1, 0);
    form.chooseOwn(1);
    assertEquals(form.answers(), [[], ["Two"]]);
    form.typeOwn(1, "  ");
    assertEquals(form.answers(), [[], ["Two"]]);
    form.pick(1, 1);
    assertEquals(form.answers(), [[], []]);
  } finally {
    forgetQuestionForm(input.id);
  }
});
Deno.test("question request state survives view replacement until successful reply forgets it", () => {
  const input = request("retained-answer");
  try {
    const form = createQuestionForm(input);
    form.pick(0, 0);
    form.next();
    form.typeOwn(1, "Unsent");
    form.next();
    const reopened = createQuestionForm(input);
    assertEquals(reopened.state.step, reopened.review);
    assertEquals(reopened.answers(), [["One"], ["Unsent"]]);
    // The restored view has its own observable store, not a mutable alias.
    reopened.pick(0, 1);
    assertEquals(form.answers(), [["One"], ["Unsent"]]);
    forgetQuestionForm(input.id);
    const fresh = createQuestionForm(input);
    assertEquals(fresh.state.step, 0);
    assertEquals(fresh.answers(), [[], []]);
  } finally {
    forgetQuestionForm(input.id);
  }
});
