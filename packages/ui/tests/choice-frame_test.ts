// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { selection } from "../components/selection.ts";

Deno.test("choice framing owns its paint and all answer paths share it", async () => {
  const source = await Deno.readTextFile(
    new URL("../components/FormField.tsx", import.meta.url),
  );
  const css = await Deno.readTextFile(
    new URL("../components/QuestionDock.css", import.meta.url),
  );
  const frame = await Deno.readTextFile(
    new URL("../components/ChoiceFrame.tsx", import.meta.url),
  );
  assert(frame.includes("export function ChoiceFrame("));
  assert(frame.includes('import "./ChoiceFrame.css" with { type: "text" }'));
  assertEquals(source.match(/<ChoiceFrame\b/g)?.length, 2);
  assertEquals(frame.match(/\.\.\.selection\(state\(\)\)/g)?.length, 2);
  assertEquals(frame.match(/selected: props.selected/g)?.length, 1);
  assert(
    !/otk-(?:question-row|question-choice|question-content|question-own)/.test(
      css,
    ),
  );
});

Deno.test("choice paint follows shared selection classes, not ARIA selectors", async () => {
  const css = await Deno.readTextFile(
    new URL("../components/ChoiceFrame.css", import.meta.url),
  );
  assert(css.includes(".otk-choice-frame.is-selected"));
  assert(!/\[aria-/.test(css));
  for (const selected of [false, true]) {
    const state = selection({
      class: "otk-choice-frame",
      kind: "pressed",
      selected,
    });
    assertEquals(state.class.split(" ").includes("is-selected"), selected);
    assertEquals(state["aria-pressed"], String(selected));
  }
});
