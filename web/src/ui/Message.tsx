// SPDX-License-Identifier: LGPL-3.0-only
import { For, Match, Show, Switch } from "solid-js";
import type {
  Message as OtkMessage,
  Part,
  PermissionRequest,
} from "../../../protocol/content.ts";
import Blocks from "./Blocks.tsx";
import ToolLine from "./ToolLine.tsx";
import Reasoning from "./Reasoning.tsx";
import type { Preferences } from "../../../protocol/prefs.ts";
const partOf = <K extends Part["kind"]>(part: Part, kind: K) =>
  part.kind === kind ? part as Part & { kind: K } : undefined;
const duration = (start: number, end: number) =>
  `${Math.max(0, (end - start) / 1000).toFixed(1)}s`;
function PartView(
  props: {
    part: Part;
    prefs: Preferences;
    streaming: boolean;
    directory?: string;
    permissions: PermissionRequest[];
    paneWidth: number;
    onOpenChild(id: string): void;
  },
) {
  return (
    <Switch fallback={<p class="otk-muted">{props.part.kind}</p>}>
      <Match when={partOf(props.part, "text")}>
        {(part) => (
          <div class="otk-text">
            <Blocks blocks={part().blocks} streaming={props.streaming} />
          </div>
        )}
      </Match>
      <Match when={partOf(props.part, "reasoning")}>
        {(part) => <Reasoning part={part()} mode={props.prefs.thinking} />}
      </Match>
      <Match when={partOf(props.part, "tool")}>
        {(part) => (
          <Show
            when={props.prefs.toolDetails || part().call.status !== "completed"}
          >
            <ToolLine
              call={part().call}
              prefs={props.prefs}
              paneWidth={props.paneWidth}
              onOpenChild={props.onOpenChild}
              genericOutput={props.prefs.genericToolOutput}
              directory={props.directory}
              waiting={props.permissions.some((request) =>
                request.toolCall === part().call.callID ||
                request.sessionID === part().call.childSessionID
              )}
            />
          </Show>
        )}
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
export default function Message(
  props: {
    message: OtkMessage;
    prefs: Preferences;
    directory?: string;
    permissions: PermissionRequest[];
    paneWidth: number;
    onOpenChild(id: string): void;
  },
) {
  const assistant = () =>
    props.message.role === "assistant" ? props.message : undefined;
  return (
    <article
      class={["otk-message", {
        "otk-user-message": props.message.role === "user",
        "otk-unconcealed": !props.prefs.conceal,
      }]}
      data-message={props.message.id}
      data-role={props.message.role}
    >
      <header class="otk-message-role">
        {props.message.role === "user" ? "YOU" : "ASSISTANT"}
        <Show when={props.prefs.timestamps}>
          <time datetime={new Date(props.message.time.created).toISOString()}>
            {new Date(props.message.time.created).toLocaleString()}
          </time>
        </Show>
      </header>
      <For each={props.message.parts} keyed={(part) => part.id}>
        {(part) => (
          <PartView
            part={part()}
            prefs={props.prefs}
            directory={props.directory}
            permissions={props.permissions}
            paneWidth={props.paneWidth}
            onOpenChild={props.onOpenChild}
            streaming={props.message.role === "assistant" &&
              props.message.time.completed === undefined}
          />
        )}
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
