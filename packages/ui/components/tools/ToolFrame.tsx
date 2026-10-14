// SPDX-License-Identifier: LGPL-3.0-only
import "./ToolFrame.css" with { type: "text" };
import { createSignal, type Element, Show } from "solid-js";
import type { ToolCall } from "@otk/protocol";
import { ownedAction } from "../../keyboard/context.tsx";
export default function ToolFrame(
  props: { call: ToolCall; waiting: boolean; children: Element },
): Element {
  const [errorOpen, setErrorOpen] = createSignal(false);
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
        <Show when={props.call.status === "running" && !props.waiting}>
          <span class="otk-dot otk-busy" />
        </Show>
        <span>{props.waiting ? "awaiting permission" : props.call.status}</span>
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
      <div class="otk-tool-body">{props.children}</div>
      <Show when={props.call.status === "error" && errorOpen()}>
        <pre class="otk-tool-error" role="alert">{props.call.error}</pre>
      </Show>
    </section>
  );
}
