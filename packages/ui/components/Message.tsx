// SPDX-License-Identifier: LGPL-3.0-only
import "./Message.css" with { type: "text" };
import { createMemo, For, Show } from "solid-js";
import WorkLog from "./WorkLog.tsx";
import ResponseProgress from "./ResponseProgress.tsx";
import { elapsed, partGroups } from "./work-log.ts";
import { CopyIcon } from "./ChromeIcons.tsx";
import { ownedAction } from "../keyboard/context.tsx";
import type {
  Message as OtkMessage,
  Part,
  PermissionRequest,
} from "@otk/protocol";
import { useUiRegistries } from "../registries/context.tsx";
import type { Preferences } from "@otk/protocol";
import type { PartProps } from "../registries/renderers.ts";
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
/** A stable keyed component boundary preserves source nodes during part updates. */
function PartsView(props: Omit<PartProps, "part"> & { parts: Part[] }) {
  return (
    <For each={props.parts} keyed={(part) => part.id}>
      {(part) => (
        <PartView
          part={part()}
          prefs={props.prefs}
          directory={props.directory}
          permissions={props.permissions}
          paneWidth={props.paneWidth}
          onOpenChild={props.onOpenChild}
          user={props.user}
          streaming={props.streaming}
        />
      )}
    </For>
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
  const { parts } = useUiRegistries();
  const groups = createMemo(() =>
    partGroups(
      props.message.parts,
      (part) =>
        props.message.role === "assistant"
          ? parts.presentation(part, props.prefs)
          : {},
    )
  );
  const copy = ownedAction(
    "message.copy",
    () =>
      navigator.clipboard.writeText(
        (assistant()?.parts ?? props.message.parts).map((part) =>
          parts.presentation(part, props.prefs).text
        ).filter(Boolean).join("\n\n"),
      ),
  );
  const assistant = () =>
    props.metadata === null ? undefined : props.metadata ??
      (props.message.role === "assistant" ? props.message : undefined);
  const streaming = () =>
    props.message.role === "assistant" &&
    props.message.time.completed === undefined;
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
      <div
        class={props.message.role === "user"
          ? "otk-user-bubble otk-created-trigger"
          : "otk-message-content"}
        tabindex={props.message.role === "user" ? "0" : undefined}
      >
        <For each={groups()} keyed={(group) => group.id}>
          {(group) => (
            <Show
              when={group().work}
              fallback={
                <PartsView
                  parts={group().parts}
                  prefs={props.prefs}
                  directory={props.directory}
                  permissions={props.permissions}
                  paneWidth={props.paneWidth}
                  onOpenChild={props.onOpenChild}
                  user={props.message.role === "user"}
                  streaming={streaming()}
                />
              }
            >
              <WorkLog time={group().time}>
                <PartsView
                  parts={group().parts}
                  prefs={props.prefs}
                  directory={props.directory}
                  permissions={props.permissions}
                  paneWidth={props.paneWidth}
                  onOpenChild={props.onOpenChild}
                  user={props.message.role === "user"}
                  streaming={streaming()}
                />
              </WorkLog>
            </Show>
          )}
        </For>
        <Show when={streaming()}>
          <ResponseProgress />
        </Show>
      </div>
      <Show when={props.message.role === "user"}>
        <footer
          class={["otk-user-meta", {
            "otk-time-always": props.prefs.timestamps,
          }]}
        >
          <time
            class="otk-created-time"
            datetime={new Date(props.message.time.created).toISOString()}
          >
            {new Date(props.message.time.created).toLocaleString()}
          </time>
          <Show when={props.queued}>
            <span class="otk-queued">Queued</span>
          </Show>
        </footer>
      </Show>
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
                  class="otk-message-agent otk-created-trigger"
                  tabindex="0"
                  style={{
                    "--message-agent-color": message().agentColor ||
                      "var(--otk-fg-3)",
                  }}
                >
                  {message().agent}
                </span>
                <time
                  class="otk-created-time"
                  datetime={new Date(message().time.created).toISOString()}
                >
                  {new Date(message().time.created).toLocaleString()}
                </time>
                <span>
                  {message().model.provider}/{message().model.model}
                </span>
                <span>
                  {message().time.completed === undefined
                    ? "streaming"
                    : elapsed(
                      message().time.created,
                      message().time.completed!,
                    )}
                </span>
                <Show when={message().interrupted}>
                  <span>interrupted</span>
                </Show>
              </span>
              <button
                type="button"
                class="otk-icon-button otk-copy-message"
                aria-label="Copy reply"
                title="Copy reply"
                onClick={() => void copy()}
              >
                <CopyIcon />
              </button>
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
