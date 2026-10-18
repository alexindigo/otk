// SPDX-License-Identifier: LGPL-3.0-only
import "./QuestionAnswers.css" with { type: "text" };
import { For } from "solid-js";
/** One presentation of question → answer pairs, wherever answers are shown. */
export default function QuestionAnswers(
  props: { items: { question: string; answer: string }[] },
): import("solid-js").Element {
  return (
    <dl class="otk-question-answers">
      <For each={props.items} keyed={false}>
        {(item) => (
          <div>
            <dt>{item().question}</dt>
            <dd>{item().answer}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}
