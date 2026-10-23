// SPDX-License-Identifier: LGPL-3.0-only
import "./Message.css" with { type: "text" };
import { createMemo, For, Show } from "solid-js";
import WorkLog from "./WorkLog.tsx";
import ResponseProgress from "./ResponseProgress.tsx";
import TurnUsage from "./TurnUsage.tsx";
import type { TurnUsage as Usage } from "@otk/client";
import { elapsed, partGroups } from "./work-log.ts";
import { CopyIcon } from "./ChromeIcons.tsx";
import { ownedAction } from "../keyboard/context.tsx";
import { contextTarget } from "./context-target.ts";
import type {
  Message as OtkMessage,
  Part,
  PermissionRequest,
} from "@otk/protocol";
import { useUiRegistries } from "../registries/context.tsx";
import type { Preferences } from "@otk/protocol";
import type { PartProps } from "../registries/renderers.ts";
import {
  ContentIdentityProvider,
  useContentIdentity,
} from "../features/transcript-context.tsx";
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
  const identity = useContentIdentity();
  return (
    <Show when={parts.resolve(props.part)} keyed>
      {(renderer) => {
        const Component = renderer;
        return (
          <ContentIdentityProvider
            value={{ ...identity, partID: props.part.id }}
          >
            <Component {...props} />
          </ContentIdentityProvider>
        );
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
    sidecarId?: string;
    message: OtkMessage;
    metadata?: import("@otk/protocol").AssistantMessage | null;
    usage?: Usage;
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
  const identity = () => ({
    sidecarId: props.sidecarId,
    sessionID: props.message.sessionID,
    messageID: props.message.id,
    directory: props.directory,
  });
  const text = () =>
    (assistant()?.parts ?? props.message.parts).map((part) =>
      parts.presentation(part, props.prefs).text
    ).filter(Boolean).join("\n\n");
  const copy = ownedAction(
    "message.copy",
    (value: string) => navigator.clipboard.writeText(value),
  );
  const assistant = () =>
    props.metadata === null ? undefined : props.metadata ??
      (props.message.role === "assistant" ? props.message : undefined);
  const streaming = () =>
    props.message.role === "assistant" &&
    props.message.time.completed === undefined;
  // Select one turn range for both consumers; complete usage metadata wins over
  // the loaded-page reply projection. Unsupported backends share that projection.
  const time = () =>
    props.usage?.time ?? {
      start: props.message.time.created,
      end: props.message.role === "assistant"
        ? props.message.time.completed
        : undefined,
    };
  const error = () =>
    props.message.role === "assistant" && !props.message.interrupted
      ? props.message.error?.message
      : undefined;
  return (
    <ContentIdentityProvider value={identity()}>
      <article
        ref={contextTarget(() => ({
          kind: props.message.role === "user" ? "prompt" : "reply",
          data: { ...identity(), text: text() },
        }))}
        class={["otk-message", {
          "otk-user-message": props.message.role === "user",
        }]}
        data-message={props.message.id}
        data-role={props.message.role}
      >
        <div
          class={props.message.role === "user"
            ? "otk-user-bubble otk-created-trigger"
            : "otk-message-content"}
          tabindex={props.message.role === "user" ? "0" : undefined}
          data-otk-focus={props.message.role === "user" ? "content" : undefined}
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
                <WorkLog time={time()}>
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
              >
                <span class="otk-message-details">
                  <span
                    class="otk-message-agent otk-created-trigger"
                    tabindex="0"
                    data-otk-focus="content"
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
                  <span class="otk-turn-time">
                    {time().end === undefined ? "streaming" : elapsed(
                      time().start,
                      time().end!,
                    )}
                  </span>
                  <Show when={props.usage}>
                    {(usage) => (
                      <TurnUsage
                        usage={usage()}
                        showCost={props.prefs.showCost}
                      />
                    )}
                  </Show>
                  <Show when={message().interrupted}>
                    <span>interrupted</span>
                  </Show>
                </span>
                <button
                  type="button"
                  class="otk-icon-button otk-copy-message"
                  aria-label="Copy reply"
                  title="Copy reply"
                  onClick={() => void copy(text())}
                >
                  <CopyIcon />
                </button>
                <span class="otk-output-time-group">
                  <span class="otk-last-output-date" aria-hidden="true">
                    {new Date(
                      message().time.lastOutput ?? message().time.created,
                    )
                      .toLocaleDateString()}
                  </span>
                  <time
                    class="otk-last-output-time"
                    tabindex="0"
                    data-otk-focus="content"
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
                    {new Date(
                      message().time.lastOutput ?? message().time.created,
                    )
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
    </ContentIdentityProvider>
  );
}
