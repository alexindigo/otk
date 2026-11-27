// SPDX-License-Identifier: LGPL-3.0-only
import "./ToolFrame.css" with { type: "text" };
import { type Element, Show } from "solid-js";
import type { Preferences, ToolCall } from "@otk/protocol";
import { elapsed, errorFeedback, toolFailure } from "@otk/client";
import FeedbackStatus from "../FeedbackStatus.tsx";
import ActivityIndicator from "../ActivityIndicator.tsx";
import { ToolIcon } from "../ChromeIcons.tsx";
import { TreeItem, TreeNode } from "../Tree.tsx";
import EntityPill from "../EntityPill.tsx";
import { useOptionalSessionPorts } from "../../registries/session.tsx";
import { scopedEntityFacts } from "../../entity-facts.ts";
import { ownedAction } from "../../keyboard/context.tsx";
import type {
  PartRowSlots,
  ToolPresentation,
} from "../../registries/renderers.ts";
import TimeText from "../TimeText.tsx";
import Disclosure, { useDisclosure } from "../Disclosure.tsx";
import { contextTarget } from "../context-target.ts";
import {
  ContentIdentityProvider,
  contentOwner,
  transcriptDisclosureIdentity,
  useContentIdentity,
} from "../../features/transcript-context.tsx";

export default function ToolFrame(props: {
  call: ToolCall;
  row?: PartRowSlots;
  waiting: boolean;
  body(): Element;
  hasContent?(): boolean;
  nested?(): Element;
  presentation?: ToolPresentation;
  prefs?: Preferences;
  onOpenChild?(id: string): void;
}): Element {
  const session = useOptionalSessionPorts();
  const parent = useContentIdentity();
  const failure = () => toolFailure(props.call);
  const identity = () => ({ ...parent, callID: props.call.callID });
  const identify = transcriptDisclosureIdentity();
  const disclosure = () => identify({ content: identity() });
  const input = () => ({
    category: props.presentation?.category ?? "toolOutput" as const,
    prefs: () => props.prefs ?? {},
    required: props.row?.required,
  });
  const hasContent = () => !!props.row?.extra || (props.hasContent?.() ?? true);
  const state = useDisclosure("tool", disclosure, input);
  const open = () => hasContent() && state.open();
  ownedAction("tool.toggle", () => {
    if (hasContent()) void state.set(!open());
  });
  contentOwner(identity, {
    expanded: open,
    get toggle() {
      return hasContent() ? () => void state.set(!open()) : undefined;
    },
  });
  return (
    <ContentIdentityProvider value={identity()}>
      <section
        ref={contextTarget(() => ({
          kind: "tool",
          data: {
            ...identity(),
            ...props.presentation?.copy,
            output: props.call.output,
          },
        }))}
        class={["otk-tool-line", {
          "otk-tool-waiting": props.waiting,
          "is-error": !!failure(),
        }]}
        data-tool={props.call.tool}
        data-tool-status={props.call.status}
      >
        <Disclosure
          kind="tool"
          identity={disclosure()}
          input={input()}
          variant="label"
          tone={props.row?.tone}
          class="otk-tool-toggle"
          lead={() => props.presentation?.icon() ?? <ToolIcon />}
          label={props.row?.label ?? props.presentation?.verb ??
            props.call.tool}
          hasContent={hasContent}
          labelContent={props.row ? undefined : () => (
            <>
              <span
                class="otk-tool-verb otk-control-label"
                title={props.presentation?.verb ?? props.call.tool}
              >
                {props.presentation?.verb ?? props.call.tool}
              </span>{" "}
              <Show when={props.presentation?.target}>
                <span
                  class="otk-tool-target otk-id otk-control-label"
                  title={props.presentation?.target}
                >
                  {props.presentation?.target}
                </span>
                {" "}
              </Show>
              <Show when={props.presentation?.summary}>
                <span
                  class="otk-tool-brief otk-control-label"
                  title={props.presentation?.summary}
                >
                  {props.presentation?.summary}
                </span>
                {" "}
              </Show>
              <Show when={props.presentation?.changes}>
                {(changes) => (
                  <>
                    <span class="otk-tool-add">+{changes().additions}</span>
                    {" "}
                    <span class="otk-tool-del">−{changes().deletions}</span>
                    {" "}
                  </>
                )}
              </Show>
              <Show when={props.call.status === "running" && !props.waiting}>
                <ActivityIndicator small />
                {" "}
              </Show>
              <Show when={props.waiting}>
                <span>Awaiting permission</span>
                {" "}
              </Show>
              <Show when={failure()}>
                <span
                  class="otk-control-label"
                  title={failure()}
                >
                  Failed
                </span>
                {" "}
              </Show>
              <Show
                when={props.call.time.start !== undefined &&
                  props.call.time.end !== undefined}
              >
                <TimeText
                  class="otk-tool-duration"
                  time={elapsed(
                    props.call.time.end! - props.call.time.start!,
                  )}
                />
              </Show>
            </>
          )}
          layout={({ trigger, region, open, frame }) => (
            <TreeNode
              class="otk-tool-row"
              heading={{ class: "otk-tool-state" }}
              ref={frame}
              trigger={{
                variant: "span",
                element: trigger,
                hasBox: hasContent,
              }}
              bodyVisible={open()}
              detail={props.row?.detail}
              feedbackGutter
              feedback={failure()
                ? () => (
                  <FeedbackStatus
                    placement="record"
                    subgrid
                    time={props.call.time.end}
                    feedback={errorFeedback(failure(), {
                      actionLabel: props.presentation?.verb ?? props.call.tool,
                      target: {
                        ...identity(),
                        label: props.presentation?.target ?? props.call.tool,
                      },
                    }, props.call)}
                  />
                )
                : undefined}
              trail={props.presentation?.entity || props.row?.trail
                ? () => (
                  <>
                    <Show when={props.presentation?.entity}>
                      {(entity) => (
                        <EntityPill
                          label={entity().label}
                          facts={scopedEntityFacts(session, {
                            ...entity(),
                            tool: props.call,
                          })}
                          onOpenChild={props.onOpenChild}
                        />
                      )}
                    </Show>
                    {props.row?.trail?.()}
                  </>
                )
                : undefined}
              region={region}
            />
          )}
        >
          {() => (
            <>
              <TreeItem last={!props.nested && !props.row?.extra}>
                <TreeNode
                  header={() => <div class="otk-tool-body">{props.body()}</div>}
                />
              </TreeItem>
              {props.nested?.()}
              {props.row?.extra?.()}
            </>
          )}
        </Disclosure>
      </section>
    </ContentIdentityProvider>
  );
}
