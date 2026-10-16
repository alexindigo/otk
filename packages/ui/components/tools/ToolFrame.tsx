// SPDX-License-Identifier: LGPL-3.0-only
import "./ToolFrame.css" with { type: "text" };
import { createSignal, type Element, Show } from "solid-js";
import type { ToolCall } from "@otk/protocol";
import StatusLight from "../StatusLight.tsx";
import { ownedAction } from "../../keyboard/context.tsx";
import type { ToolPresentation } from "../../registries/renderers.ts";
export default function ToolFrame(
  props: {
    call: ToolCall;
    waiting: boolean;
    children: Element;
    presentation?: ToolPresentation;
  },
): Element {
  const [errorOpen, setErrorOpen] = createSignal(false);
  const [expanded, setExpanded] = createSignal<boolean>();
  const open = () => expanded() ?? props.presentation?.expanded ?? false;
  const expand = ownedAction("tool.toggle", () => setExpanded(!open()));
  const toggle = ownedAction(
    "tool.error.toggle",
    () => setErrorOpen((value) => !value),
  );
  return (
    <section
      class={["otk-tool-line", { "otk-tool-waiting": props.waiting }]}
      data-tool={props.call.tool}
      data-tool-status={props.call.status}
    >
      <header class="otk-tool-state">
        <button
          class="otk-tool-toggle"
          type="button"
          aria-expanded={open() ? "true" : "false"}
          onClick={() => void expand()}
        >
          <span aria-hidden="true">{props.presentation?.icon ?? "◇"}</span>
          <span>{props.presentation?.verb ?? props.call.tool}</span>
          <Show when={props.presentation?.target}>
            <span class="otk-tool-target otk-id">
              {props.presentation?.target}
            </span>
          </Show>
          <Show when={props.presentation?.summary}>
            <span class="otk-tool-brief">{props.presentation?.summary}</span>
          </Show>
          <Show when={props.call.status === "running" && !props.waiting}>
            <StatusLight state="working" small activity="spinner" />
          </Show>
          <Show when={props.waiting}>
            <span>Awaiting permission</span>
          </Show>
          <Show when={props.call.status === "error"}>
            <span>Failed</span>
          </Show>
          <span aria-hidden="true">{open() ? "▾" : "▸"}</span>
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
      <div class="otk-tool-body" hidden={!open()}>{props.children}</div>
      <Show when={props.call.status === "error" && errorOpen()}>
        <pre class="otk-tool-error" role="alert">{props.call.error}</pre>
      </Show>
    </section>
  );
}
