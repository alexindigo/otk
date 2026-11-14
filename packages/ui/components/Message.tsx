// SPDX-License-Identifier: LGPL-3.0-only
import { derivedValue, isAssistantTerminal } from "@otk/protocol";
import "./Message.css" with { type: "text" };
import { agentColor } from "../theme/agent-color.ts";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import WorkLog from "./WorkLog.tsx";
import { ContentWindow, type VirtualListControl } from "./VirtualList.tsx";
import ResponseProgress from "./ResponseProgress.tsx";
import TurnUsage from "./TurnUsage.tsx";
import type { TurnUsage as Usage } from "@otk/client";
import type { UsageSummary } from "@otk/protocol";
import {
  createMessageLayout,
  messageLayoutRole,
  timingExplanation,
  workingTime,
} from "./work-log.ts";
import MessageActions from "./MessageActions.tsx";
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
  contentGeneration,
  ContentIdentityProvider,
  contentOwner,
  sourceRegion,
  useContentIdentity,
} from "../features/transcript-context.tsx";
function PartView(
  props: {
    part: Part;
    prefs: Preferences;
    streaming: boolean;
    directory?: string;
    permissions: PermissionRequest[];
    paneWidth?: number;
    onOpenChild(id: string): void;
    user: boolean;
    pending?: boolean;
    sourceID?: string;
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
            <div
              ref={sourceRegion(() => props.sourceID ?? identity.messageID!)}
            >
              <Component {...props} />
            </div>
          </ContentIdentityProvider>
        );
      }}
    </Show>
  );
}
/** A stable keyed component boundary preserves source nodes during part updates. */
function PartsView(
  props: Omit<PartProps, "part"> & {
    parts: Part[];
    sourceID?(part: Part): string;
  },
) {
  const generation = contentGeneration();
  return (
    <ContentWindow
      items={props.parts}
      key={(part) => generation(part.id)}
      label="Reply parts"
      render={(part) => (
        <PartView
          part={part()}
          prefs={props.prefs}
          directory={props.directory}
          permissions={props.permissions}
          onOpenChild={props.onOpenChild}
          user={props.user}
          streaming={props.streaming}
          pending={props.pending}
          sourceID={props.sourceID?.(part())}
        />
      )}
    />
  );
}
export interface MessageControl {
  reveal(): void;
}
export default function Message(
  props: {
    sidecarId?: string;
    sessionTitle?: string;
    ownerID?: string;
    message: OtkMessage;
    segments?: import("@otk/client").TranscriptReply["segments"];
    lastID?: string;
    pending?: boolean;
    recovery?: "recovering" | "unavailable";
    onRetryRecovery?(): void;
    metadata?: import("@otk/protocol").AssistantMessage | null;
    usage?: Usage;
    summary?: import("@otk/protocol").Derived<UsageSummary>;
    openUsage?(): () => void;
    usageError?(): import("@otk/client").FailureValue | undefined;
    prefs: Preferences;
    directory?: string;
    permissions: PermissionRequest[];
    paneWidth?: number;
    onOpenChild(id: string): void;
    queued: boolean;
    control?(control: MessageControl): (() => void) | void;
    copySource?(
      id: string,
      text: (part: Part) => string | undefined,
    ): Promise<string>;
    copyIncomplete?: boolean;
  },
): import("solid-js").Element {
  const { parts } = useUiRegistries();
  const layout = createMessageLayout();
  const sourceID = (part: Part) => layout.source(part.id) ?? props.message.id;
  const framing = createMemo(() =>
    layout.update(
      props.ownerID ?? props.message.id,
      messageLayoutRole(props.message),
      props.segments ??
        [{ messageID: props.message.id, parts: props.message.parts }],
      JSON.stringify(props.prefs),
      (part) => parts.presentation(part, props.prefs),
    )
  );
  const frames = () => framing().frames;
  const userBubble = () => framing().userBubble;
  const prompt = () => framing().prompt;
  const identity = () => ({
    ownerID: props.ownerID,
    sidecarId: props.sidecarId,
    sessionID: props.message.sessionID,
    label: props.sessionTitle,
    messageID: props.message.id,
    directory: props.directory,
  });
  let footerControl: VirtualListControl | undefined;
  let usageControl: { open(): void } | undefined;
  contentOwner(identity, {
    get usage() {
      return props.openUsage
        ? async () => {
          await footerControl?.reveal("footer", { align: "nearest" });
          usageControl?.open();
        }
        : undefined;
    },
  });
  const text = () =>
    (assistant()?.parts ?? props.message.parts).map((part) =>
      parts.presentation(part, props.prefs).text
    ).filter(Boolean).join("\n\n");
  let article!: HTMLElement;
  let bubble: HTMLDivElement | undefined;
  onSettled(() =>
    props.control?.({
      reveal() {
        if (!prompt() || !bubble) return;
        bubble.focus({ preventScroll: true });
      },
    })
  );
  const [revealed, setRevealed] = createSignal(false);
  const target = () => ({
    ...identity(),
    source: framing().copyable || props.copyIncomplete
      ? () =>
        props.copySource
          ? props.copySource(
            props.message.id,
            (part) => parts.presentation(part, props.prefs).text,
          )
          : text()
      : undefined,
    lastID: props.lastID ?? props.message.id,
    completed: isAssistantTerminal(props.message),
    queued: props.queued,
  });
  const assistant = () =>
    props.metadata === null ? undefined : props.metadata ??
      (props.message.role === "assistant" ? props.message : undefined);
  const streaming = () =>
    props.message.role === "assistant" && !isAssistantTerminal(props.message);
  // Only the adapter's shared accumulator supplies a whole-turn duration.
  const time = () => derivedValue(props.summary)?.timing;
  const error = () =>
    props.message.role === "assistant" && !props.message.interrupted
      ? props.message.error?.message
      : undefined;
  return (
    <ContentIdentityProvider value={identity()}>
      <article
        ref={[
          (element) => {
            article = element;
          },
          contextTarget(() => ({
            kind: prompt() ? "prompt" : "reply",
            data: target(),
          })),
        ]}
        class={["otk-message", {
          "otk-user-message": userBubble(),
          "is-revealed": revealed(),
        }]}
        data-message={props.message.id}
        data-role={props.message.role}
      >
        <For each={frames()} keyed={(frame) => frame.id}>
          {(frame) => (
            <div
              class={frame().transcript
                ? "otk-transcript-frame"
                : userBubble()
                ? "otk-user-bubble otk-created-trigger"
                : "otk-message-content"}
              ref={(element) => {
                // Parts may arrive after this frame mounts. Keep its reference
                // independently of the current prompt projection.
                if (!frame().transcript) {
                  bubble = element;
                }
              }}
              tabindex={!frame().transcript && prompt() ? "0" : undefined}
              data-otk-focus={!frame().transcript && prompt()
                ? "content"
                : undefined}
            >
              <ContentWindow
                items={frame().groups}
                scope={frame().id}
                key={(group) => group.id}
                label="Reply segments"
                role="segment"
                render={(group) => (
                  <Show
                    when={group().work}
                    fallback={
                      <PartsView
                        parts={group().parts}
                        prefs={props.prefs}
                        directory={props.directory}
                        permissions={props.permissions}
                        onOpenChild={props.onOpenChild}
                        user={props.message.role === "user"}
                        streaming={streaming()}
                        pending={props.pending}
                        sourceID={sourceID}
                      />
                    }
                  >
                    <WorkLog
                      workingMs={group().workingMs}
                      identity={group().id}
                      prefs={props.prefs}
                      required={group().required}
                      body={() => (
                        <PartsView
                          parts={group().parts}
                          prefs={props.prefs}
                          directory={props.directory}
                          permissions={props.permissions}
                          onOpenChild={props.onOpenChild}
                          user={props.message.role === "user"}
                          streaming={streaming()}
                          pending={props.pending}
                          sourceID={sourceID}
                        />
                      )}
                    />
                  </Show>
                )}
              />
              <Show when={streaming() && frame().id === frames().at(-1)?.id}>
                <ResponseProgress />
              </Show>
            </div>
          )}
        </For>
        <Show when={props.recovery}>
          <p role="status" class="otk-response-recovery">
            {props.recovery === "unavailable"
              ? "Response refresh unavailable."
              : "Refreshing response…"}
            <Show
              when={props.recovery === "unavailable" && props.onRetryRecovery}
            >
              <button
                type="button"
                onClick={() => props.onRetryRecovery?.()}
              >
                Retry response
              </button>
            </Show>
          </p>
        </Show>
        <Show when={prompt()}>
          <footer
            class={["otk-user-meta", {
              "otk-time-always": props.prefs.timestamps,
            }]}
          >
            <span class="otk-user-details">
              <time
                class="otk-created-time"
                datetime={new Date(props.message.time.created).toISOString()}
              >
                {new Date(props.message.time.created).toLocaleString()}
              </time>
              <Show when={props.queued}>
                <span class="otk-queued">Queued</span>
              </Show>
            </span>
            <MessageActions
              kind="prompt"
              revealed={revealed()}
              target={target()}
              region={() => article}
              onReveal={setRevealed}
            />
          </footer>
        </Show>
        <Show when={assistant()}>
          {(message) => (
            <>
              <ContentWindow
                items={["footer"]}
                key={(key) => key}
                label="Reply metadata"
                role="metadata"
                control={(control) => {
                  footerControl = control;
                }}
                render={() => (
                  <footer
                    ref={sourceRegion(() => props.lastID ?? props.message.id)}
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
                          "--message-agent-color":
                            agentColor(message().agentColor) ||
                            "var(--otk-fg-3)",
                        }}
                      >
                        {message().agent}
                      </span>
                      <time
                        class="otk-created-time"
                        datetime={new Date(message().time.created)
                          .toISOString()}
                      >
                        {new Date(message().time.created).toLocaleString()}
                      </time>
                      <span class="otk-last-output-date" aria-hidden="true">
                        {new Date(
                          message().time.lastOutput ?? message().time.created,
                        ).toLocaleDateString()}
                      </span>
                      <span>
                        {message().model.provider}/{message().model.model}
                      </span>
                      <span
                        class="otk-turn-time"
                        title={timingExplanation(time())}
                      >
                        {workingTime(time()) ??
                          (streaming() ? "streaming" : "Time unknown")}
                      </span>
                      <TurnUsage
                        summary={props.summary}
                        detail={() => props.usage}
                        error={props.usageError}
                        open={props.openUsage}
                        control={(control) => {
                          usageControl = control;
                        }}
                        showCost={props.prefs.showCost}
                      />
                      <Show when={message().interrupted}>
                        <span>interrupted</span>
                      </Show>
                    </span>
                    <MessageActions
                      kind="reply"
                      revealed={revealed()}
                      target={target()}
                      region={() => article}
                      onReveal={setRevealed}
                    />
                    <span class="otk-output-time-group">
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
                )}
              />
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
