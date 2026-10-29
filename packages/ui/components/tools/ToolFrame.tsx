// SPDX-License-Identifier: LGPL-3.0-only
import "./ToolFrame.css" with { type: "text" };
import { type Element, Show } from "solid-js";
import type { ToolCall } from "@otk/protocol";
import ActivityIndicator from "../ActivityIndicator.tsx";
import { ownedAction } from "../../keyboard/context.tsx";
import type { ToolPresentation } from "../../registries/renderers.ts";
import { elapsed } from "../work-log.ts";
import { contextTarget } from "../context-target.ts";
import {
  ContentIdentityProvider,
  contentOwner,
  retainedDisclosure,
  useContentIdentity,
} from "../../features/transcript-context.tsx";
export default function ToolFrame(
  props: {
    call: ToolCall;
    waiting: boolean;
    body(): Element;
    presentation?: ToolPresentation;
  },
): Element {
  const parent = useContentIdentity();
  const identity = () => ({ ...parent, callID: props.call.callID });
  const [errorOpen, setErrorOpen] = retainedDisclosure(
    "tool-error",
    identity(),
  );
  const [expanded, setExpanded] = retainedDisclosure("tool", identity());
  const open = () => expanded() ?? props.presentation?.expanded ?? false;
  const expand = ownedAction("tool.toggle", () => setExpanded(!open()));
  contentOwner(identity, {
    expanded: open,
    toggle: () => setExpanded(!open()),
  });
  const toggle = ownedAction(
    "tool.error.toggle",
    () => setErrorOpen(!errorOpen()),
  );
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
        class={["otk-tool-line", { "otk-tool-waiting": props.waiting }]}
        data-tool={props.call.tool}
        data-tool-status={props.call.status}
      >
        <header class="otk-tool-state otk-control-row">
          <button
            class="otk-tool-toggle otk-control-grow"
            type="button"
            aria-expanded={open() ? "true" : "false"}
            onClick={() => void expand()}
          >
            <span class="otk-tool-icon" aria-hidden="true">
              {typeof props.presentation?.icon === "function"
                ? props.presentation.icon()
                : props.presentation?.icon ?? "◇"}
            </span>{" "}
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
                  <span class="otk-tool-add">+{changes().additions}</span>{" "}
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
            <Show when={props.call.status === "error"}>
              <span>Failed</span>
              {" "}
            </Show>
            <Show
              when={props.call.time.start !== undefined &&
                props.call.time.end !== undefined}
            >
              <span class="otk-tool-duration">
                {elapsed(props.call.time.start!, props.call.time.end!)}
              </span>
            </Show>
          </button>
          <Show when={props.call.status === "error"}>
            <button
              type="button"
              class="otk-tool-error-toggle"
              aria-expanded={errorOpen() ? "true" : "false"}
              onClick={() => void toggle()}
            >
              Error details
            </button>
          </Show>
        </header>
        <Show when={open()}>
          <div class="otk-tool-body">{props.body()}</div>
        </Show>
        <Show when={props.call.status === "error" && errorOpen()}>
          <pre class="otk-tool-error" role="alert">{props.call.error}</pre>
        </Show>
      </section>
    </ContentIdentityProvider>
  );
}
