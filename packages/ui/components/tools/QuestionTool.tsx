// SPDX-License-Identifier: LGPL-3.0-only
import "./QuestionTool.css" with { type: "text" };
import QuestionAnswers from "../QuestionAnswers.tsx";
import type { QuestionCall } from "@otk/protocol";
import type { ToolRegistry } from "../../registries/renderers.ts";
import { countLabel } from "./count.ts";
export function registerQuestionTool(tools: ToolRegistry): void {
  tools.registerTyped(
    "question",
    (props) => <QuestionTool call={props.call} />,
    (call) => ({
      icon: "?",
      verb: "Ask",
      summary: countLabel(call.questions.length, "question"),
    }),
  );
}
export default function QuestionTool(props: { call: QuestionCall }) {
  const pending = () =>
    props.call.status === "denied"
      ? "Dismissed"
      : props.call.status === "error"
      ? "Question failed"
      : props.call.status === "completed"
      ? "(no answer)"
      : "Awaiting answer";
  return (
    <div class="otk-questions">
      <QuestionAnswers
        items={props.call.questions.map((question) => ({
          question: question.text,
          answer: question.answer === undefined
            ? pending()
            : question.answer.join(", ") || "(no answer)",
        }))}
      />
    </div>
  );
}
