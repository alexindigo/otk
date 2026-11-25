// SPDX-License-Identifier: LGPL-3.0-only
import "./ToolFrame.css" with { type: "text" };
import { type Element, Show } from "solid-js";
import type { Preferences, ToolCall } from "@otk/protocol";
import { elapsed, errorFeedback, toolFailure } from "@otk/client";
import FeedbackStatus from "../FeedbackStatus.tsx";
import ActivityIndicator from "../ActivityIndicator.tsx";
import { ToolIcon } from "../ChromeIcons.tsx";
import { TreeIcon, TreeItem, TreeNode } from "../Tree.tsx";
import EntityPill from "../EntityPill.tsx";
import { useOptionalSessionPorts } from "../../registries/session.tsx";
import { scopedEntityFacts } from "../../entity-facts.ts";
import { ownedAction } from "../../keyboard/context.tsx";
import type { ToolPresentation } from "../../registries/renderers.ts";
import TimeText from "../TimeText.tsx";
import { contextTarget } from "../context-target.ts";
import {
  ContentIdentityProvider,
  contentOwner,
  retainedDisclosure,
  useContentIdentity,
} from "../../features/transcript-context.tsx";

export default function ToolFrame(props: {
  call: ToolCall;
  waiting: boolean;
  body(): Element;
  nested?(): Element;
  presentation?: ToolPresentation;
  prefs?: Preferences;
  onOpenChild?(id: string): void;
}): Element {
  const session = useOptionalSessionPorts();
  const parent = useContentIdentity();
  const failure = () => toolFailure(props.call);
  const identity = () => ({ ...parent, callID: props.call.callID });
  const [open, setExpanded] = retainedDisclosure(
    "tool",
    () => props.presentation?.category ?? "toolOutput",
    () => props.prefs ?? {},
    identity(),
  );
  const expand = ownedAction("tool.toggle", () => setExpanded(!open()));
  contentOwner(identity, {
    expanded: open,
    toggle: () => setExpanded(!open()),
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
        <TreeNode
          toggleHeader
          label={props.presentation?.verb ?? props.call.tool}
          open={open()}
          onOpen={setExpanded}
          feedback={failure()
            ? () => (
              <FeedbackStatus
                placement="record"
                time={props.call.time.end}
                feedback={errorFeedback(failure(), {
                  actionLabel: props.presentation?.verb ?? props.call.tool,
                  target: {
                    ...identity(),
                    label: props.presentation?.target ?? props.call.tool,
                  },
                })}
              />
            )
            : undefined}
          header={(_connected, toggleID) => (
            <header
              class={["otk-tool-state otk-control-row", {
                "is-error": !!failure(),
              }]}
            >
              <TreeIcon>
                {props.presentation?.icon() ?? <ToolIcon />}
              </TreeIcon>
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
              <button
                id={toggleID}
                type="button"
                class="otk-tool-toggle otk-tree-control otk-control-grow"
                aria-expanded={open() ? "true" : "false"}
                onClick={() => void expand()}
              >
                <span
                  class="otk-tool-verb otk-control-label"
                  title={props.presentation?.verb ?? props.call.tool}
                >
                  {props.presentation?.verb ?? props.call.tool}
                </span>{" "}
                <Show when={props.presentation?.target}>
                  <span
                    class="otk-tool-target otk-id otk-control-label otk-control-grow"
                    title={props.presentation?.target}
                  >
                    {props.presentation?.target}
                  </span>
                  {" "}
                </Show>
                <Show when={props.presentation?.summary}>
                  <span
                    class="otk-tool-brief otk-control-label otk-control-grow"
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
                    class="otk-control-label otk-control-grow"
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
              </button>
            </header>
          )}
          body={() => (
            <>
              <TreeItem last={!props.nested}>
                <TreeNode
                  header={() => <div class="otk-tool-body">{props.body()}</div>}
                />
              </TreeItem>
              {props.nested?.()}
            </>
          )}
        />
      </section>
    </ContentIdentityProvider>
  );
}
