// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { QuestionCall } from "../../../../protocol/content.ts";
export default function QuestionTool(props: { call: QuestionCall }) {
  return (
    <dl class="otk-questions">
      <For each={props.call.questions} keyed={false}>
        {(question) => (
          <div>
            <dt>{question().text}</dt>
            <dd>
              {question().answer === undefined
                ? "Awaiting answer"
                : question().answer?.join(", ") || "(no answer)"}
            </dd>
          </div>
        )}
      </For>
    </dl>
  );
}
