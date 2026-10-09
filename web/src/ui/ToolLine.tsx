// SPDX-License-Identifier: LGPL-3.0-only
import { Match, Switch } from "solid-js";
import type { ToolCall } from "../../../protocol/content.ts";
import Todo from "./Todo.tsx";
import QuestionTool from "./tools/QuestionTool.tsx";
import ToolFrame from "./tools/ToolFrame.tsx";
import BashTool from "./tools/BashTool.tsx";
import ReadTool from "./tools/ReadTool.tsx";
import SearchTool from "./tools/SearchTool.tsx";
import FetchTool from "./tools/FetchTool.tsx";
import WebSearchTool from "./tools/WebSearchTool.tsx";
import SkillTool from "./tools/SkillTool.tsx";
import GenericTool from "./tools/GenericTool.tsx";
const toolOf = <K extends ToolCall["tool"]>(call: ToolCall, kind: K) =>
  call.tool === kind ? call as Extract<ToolCall, { tool: K }> : undefined;
export default function ToolLine(
  props: {
    call: ToolCall;
    genericOutput: boolean;
    directory?: string;
    waiting: boolean;
  },
) {
  return (
    <ToolFrame
      call={props.call}
      waiting={props.waiting || props.call.awaitingPermission}
    >
      <Switch>
        <Match when={toolOf(props.call, "bash")}>
          {(call) => <BashTool call={call()} directory={props.directory} />}
        </Match>
        <Match when={toolOf(props.call, "read")}>
          {(call) => <ReadTool call={call()} />}
        </Match>
        <Match when={toolOf(props.call, "search")}>
          {(call) => <SearchTool call={call()} />}
        </Match>
        <Match when={toolOf(props.call, "fetch")}>
          {(call) => <FetchTool call={call()} />}
        </Match>
        <Match when={toolOf(props.call, "websearch")}>
          {(call) => <WebSearchTool call={call()} />}
        </Match>
        <Match when={toolOf(props.call, "skill")}>
          {(call) => <SkillTool call={call()} />}
        </Match>
        <Match when={toolOf(props.call, "generic")}>
          {(call) => <GenericTool call={call()} output={props.genericOutput} />}
        </Match>
        <Match when={props.call.tool === "todo" ? props.call : undefined}>
          {(call) => <Todo items={call().items} />}
        </Match>
        <Match when={props.call.tool === "question" ? props.call : undefined}>
          {(call) => <QuestionTool call={call()} />}
        </Match>
      </Switch>
    </ToolFrame>
  );
}
