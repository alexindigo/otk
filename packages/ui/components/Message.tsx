// SPDX-License-Identifier: LGPL-3.0-only
import "./Message.css" with { type: "text" };
import { For, Show } from "solid-js";
import type {
  Message as OtkMessage,
  Part,
  PermissionRequest,
} from "@otk/protocol";
import { useUiRegistries } from "../registries/context.tsx";
import type { Preferences } from "@otk/protocol";
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
  const { parts } = useUiRegistries();
  return (
    <Show when={parts.resolve(props.part)} keyed>
      {(renderer) => {
        const Component = renderer;
        return <Component {...props} />;
      }}
    </Show>
  );
}
export default function Message(
  props: {
    message: OtkMessage;
    metadata?: import("@otk/protocol").AssistantMessage | null;
    prefs: Preferences;
    directory?: string;
    permissions: PermissionRequest[];
    paneWidth: number;
    onOpenChild(id: string): void;
    queued: boolean;
  },
): import("solid-js").Element {
  const assistant = () =>
    props.metadata === null ? undefined : props.metadata ??
      (props.message.role === "assistant" ? props.message : undefined);
  const error = () =>
    props.message.role === "assistant" && !props.message.interrupted
      ? props.message.error?.message
      : undefined;
  return (
    <article
      class={["otk-message", {
        "otk-user-message": props.message.role === "user",
        "otk-unconcealed": !props.prefs.conceal,
      }]}
      data-message={props.message.id}
      data-role={props.message.role}
    >
      <Show when={props.message.role === "user"}>
        <header class="otk-message-role">
          <span
            class={["otk-role-and-time", {
              "otk-time-always": props.prefs.timestamps,
            }]}
          >
            <span class="otk-role-label" tabindex="0">
              {props.message.role === "user" ? "You" : "Assistant"}
            </span>
            <time
              class="otk-created-time"
              datetime={new Date(props.message.time.created).toISOString()}
            >
              {new Date(props.message.time.created).toLocaleString()}
            </time>
          </span>
          <Show when={props.queued}>
            <span class="otk-queued">Queued</span>
          </Show>
        </header>
      </Show>
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
            <footer
              class={["otk-message-footer", {
                "otk-time-always": props.prefs.timestamps,
              }]}
              title={`Input ${message().tokens.input} · output ${message().tokens.output} · reasoning ${message().tokens.reasoning} · cache read ${message().tokens.cache.read} · cache write ${message().tokens.cache.write} · cost $${message().cost}`}
            >
              <span class="otk-message-details">
                <span
                  style={{ color: message().agentColor || "var(--otk-fg-2)" }}
                >
                  ▣
                </span>
                <span class="otk-role-label" tabindex="0">
                  {message().agent}
                </span>
                <time
                  class="otk-created-time"
                  datetime={new Date(message().time.created).toISOString()}
                >
                  {new Date(message().time.created).toLocaleString()}
                </time>
                <span class="otk-id">
                  {message().model.provider}/{message().model.model}
                </span>
                <span>
                  {message().time.completed === undefined
                    ? "streaming"
                    : duration(
                      message().time.created,
                      message().time.completed!,
                    )}
                </span>
                <Show when={message().interrupted}>
                  <span>interrupted</span>
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
          </>
        )}
      </Show>
      <Show when={error()}>
        <p class="otk-error" role="alert">{error()}</p>
      </Show>
    </article>
  );
}
