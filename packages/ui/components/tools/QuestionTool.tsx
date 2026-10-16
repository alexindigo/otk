// SPDX-License-Identifier: LGPL-3.0-only
import "./QuestionTool.css" with { type: "text" };
import { For } from "solid-js";
import type { QuestionCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
export function registerQuestionTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "question",
    (props) => <QuestionTool call={props.call} />,
    (call) => ({
      icon: "?",
      verb: "Ask",
      summary: call.questions.map((q) => q.text).join(" · "),
    }),
  );
}
export default function QuestionTool(props: { call: QuestionCall }) {
  return (
    <dl class="otk-questions">
      <For each={props.call.questions} keyed={false}>
        {(question) => (
          <div>
            <dt>{question().text}</dt>
            <dd>
              {question().answer === undefined
                ? props.call.status === "denied"
                  ? "Dismissed"
                  : props.call.status === "error"
                  ? "Question failed"
                  : props.call.status === "completed"
                  ? "(no answer)"
                  : "Awaiting answer"
                : question().answer?.join(", ") || "(no answer)"}
            </dd>
          </div>
        )}
      </For>
    </dl>
  );
}
