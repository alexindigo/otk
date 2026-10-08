// SPDX-License-Identifier: LGPL-3.0-only
import { For, Match, Show, Switch } from "solid-js";
import type { Message as OtkMessage, Part } from "../../../protocol/content.ts";
import Blocks from "./Blocks.tsx";
import ToolLine from "./ToolLine.tsx";
const partOf = <K extends Part["kind"]>(part: Part, kind: K) =>
  part.kind === kind ? part as Part & { kind: K } : undefined;
const duration = (start: number, end: number) =>
  `${Math.max(0, (end - start) / 1000).toFixed(1)}s`;
function PartView(props: { part: Part }) {
  return (
    <Switch fallback={<p class="otk-muted">{props.part.kind}</p>}>
      <Match when={partOf(props.part, "text")}>
        {(part) => (
          <div class="otk-text">
            <Blocks blocks={part().blocks} />
          </div>
        )}
      </Match>
      <Match when={partOf(props.part, "reasoning")}>
        {(part) => (
          <p class="otk-muted">
            {part().time.end === undefined
              ? "Thinking…"
              : `Thought · ${duration(part().time.start, part().time.end!)}`}
          </p>
        )}
      </Match>
      <Match when={partOf(props.part, "tool")}>
        {(part) => <ToolLine call={part().call} />}
      </Match>
      <Match when={partOf(props.part, "file")}>
        {(part) => <span class="otk-chip">{part().name}</span>}
      </Match>
      <Match when={partOf(props.part, "agent")}>
        {(part) => <span class="otk-chip">{part().name}</span>}
      </Match>
    </Switch>
  );
}
export default function Message(props: { message: OtkMessage }) {
  const assistant = () =>
    props.message.role === "assistant" ? props.message : undefined;
  return (
    <article
      class={["otk-message", {
        "otk-user-message": props.message.role === "user",
      }]}
      data-message={props.message.id}
      data-role={props.message.role}
    >
      <header class="otk-message-role">
        {props.message.role === "user" ? "YOU" : "ASSISTANT"}
      </header>
      <For each={props.message.parts} keyed={(part) => part.id}>
        {(part) => <PartView part={part()} />}
      </For>
      <Show when={assistant()}>
        {(message) => (
          <>
            <footer class="otk-message-footer">
              {message().agent} ·{" "}
              {message().model.provider}/{message().model.model} ·{" "}
              {message().time.completed === undefined
                ? "streaming"
                : duration(message().time.created, message().time.completed!)}
              <Show when={message().interrupted}>
                <span>· interrupted</span>
              </Show>
            </footer>
            <Show when={message().error && !message().interrupted}>
              <p class="otk-error" role="alert">{message().error?.message}</p>
            </Show>
          </>
        )}
      </Show>
    </article>
  );
}
