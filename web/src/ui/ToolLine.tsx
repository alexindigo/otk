// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, Match, Show, Switch } from "solid-js";
import type { ToolCall } from "../../../protocol/content.ts";
import Todo from "./Todo.tsx";
import QuestionTool from "./tools/QuestionTool.tsx";
export default function ToolLine(
  props: { call: ToolCall; genericOutput: boolean },
) {
  const [expanded, setExpanded] = createSignal(false);
  const output = () =>
    props.call.tool === "generic" ? props.call.output || "" : "";
  const lines = () => output().trimEnd().split("\n");
  return (
    <div
      class="otk-tool-line"
      data-tool={props.call.tool}
      data-tool-status={props.call.status}
    >
      <span>
        {props.call.tool === "generic" ? props.call.name : props.call.tool} ·
        {" "}
        {props.call.status} ·{" "}
        {props.call.title || (props.call.tool === "generic"
          ? props.call.summary
          : props.call.tool === "bash"
          ? props.call.description || props.call.command
          : props.call.tool)}
      </span>
      <Switch>
        <Match when={props.call.tool === "todo" ? props.call : undefined}>
          {(call) => <Todo items={call().items} />}
        </Match>
        <Match when={props.call.tool === "question" ? props.call : undefined}>
          {(call) => <QuestionTool call={call()} />}
        </Match>
      </Switch>
      <Show when={props.genericOutput && output()}>
        <pre class="otk-tool-output">{expanded() ? output() : lines().slice(0, 3).join("\n")}</pre>
        <Show when={lines().length > 3}>
          <button
            type="button"
            aria-expanded={expanded() ? "true" : "false"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded() ? "Collapse output" : "Expand output"}
          </button>
        </Show>
      </Show>
      <Show when={props.call.error}>
        <span class="otk-error">{props.call.error}</span>
      </Show>
    </div>
  );
}
