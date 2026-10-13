// SPDX-License-Identifier: LGPL-3.0-only
import { For, Match, Show, Switch } from "solid-js";
import type {
  Message as OtkMessage,
  Part,
  PermissionRequest,
} from "@otk/protocol";
import Blocks from "./Blocks.tsx";
import ToolLine from "./ToolLine.tsx";
import Reasoning from "./Reasoning.tsx";
import type { Preferences } from "@otk/protocol";
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
    user: boolean;
  },
) {
  return (
    <Switch>
      <Match when={partOf(props.part, "text")}>
        {(part) => (
          <div class="otk-text">
            <Show when={!props.user || !part().synthetic}>
              <Blocks blocks={part().blocks} streaming={props.streaming} />
            </Show>
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
        {(part) => (
          <span class="otk-chip" title={part().path}>
            {part().mime === "application/x-directory" ? "Directory" : "File"}:
            {" "}
            {part().name}
          </span>
        )}
      </Match>
      <Match when={partOf(props.part, "agent")}>
        {(part) => <span class="otk-chip">Agent: {part().name}</span>}
      </Match>
      <Match when={partOf(props.part, "compaction")}>
        <div class="otk-compaction-divider">Compaction</div>
      </Match>
      <Match when={partOf(props.part, "unknown")}>
        {(part) => <p class="otk-muted">Unsupported part: {part().label}</p>}
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
    queued: boolean;
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
      style={{
        "border-left-color": props.message.agentColor || "var(--accent)",
      }}
    >
      <header class="otk-message-role">
        <span
          class={["otk-role-and-time", {
            "otk-time-always": props.prefs.timestamps,
          }]}
        >
          <span class="otk-role-label" tabindex="0">
            {props.message.role === "user" ? "YOU" : "ASSISTANT"}
          </span>
          <time
            class="otk-created-time"
            datetime={new Date(props.message.time.created).toISOString()}
          >
            {new Date(props.message.time.created).toLocaleString()}
          </time>
        </span>
        <Show when={props.queued}>
          <span class="otk-queued">QUEUED</span>
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
            user={props.message.role === "user"}
            streaming={props.message.role === "assistant" &&
              props.message.time.completed === undefined}
          />
        )}
      </For>
      <Show when={assistant()}>
        {(message) => (
          <>
            <footer class="otk-message-footer">
              <span class="otk-message-details">
                <span
                  style={{ color: message().agentColor || "var(--accent)" }}
                >
                  ▣
                </span>{" "}
                {message().agent} ·{" "}
                {message().model.provider}/{message().model.model} ·{" "}
                {message().time.completed === undefined
                  ? "streaming"
                  : duration(message().time.created, message().time.completed!)}
                <Show when={message().interrupted}>
                  <span>· interrupted</span>
                </Show>
              </span>
              <span class="otk-output-time-group">
                <span class="otk-last-output-date" aria-hidden="true">
                  {new Date(message().time.lastOutput ?? message().time.created)
                    .toLocaleDateString()}
                </span>
                <time
                  class="otk-last-output-time"
                  tabindex="0"
                  aria-label="Last output time"
                  datetime={new Date(
                    message().time.lastOutput ?? message().time.created,
                  ).toISOString()}
                  title={`Last output: ${
                    new Date(
                      message().time.lastOutput ?? message().time.created,
                    ).toLocaleString()
                  }`}
                >
                  {new Date(message().time.lastOutput ?? message().time.created)
                    .toLocaleTimeString()}
                </time>
              </span>
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
