// SPDX-License-Identifier: LGPL-3.0-only
import "./ToolOutput.css" with { type: "text" };
import { createSignal, Show } from "solid-js";
import { ownedAction } from "../../keyboard/context.tsx";
export default function ToolOutput(
  props: { text: string; limit: number },
): import("solid-js").Element {
  const [open, setOpen] = createSignal(false);
  const toggle = ownedAction(
    "tool.output.toggle",
    () => setOpen((value) => !value),
  );
  const lines = () => props.text.trimEnd().split("\n");
  return (
    <Show when={props.text}>
      <pre class="otk-tool-output">{open()?props.text.trimEnd():lines().slice(0,props.limit).join("\n")}</pre>
      <Show when={lines().length > props.limit}>
        <button
          class="otk-output-toggle"
          type="button"
          aria-expanded={open() ? "true" : "false"}
          onClick={() => void toggle()}
        >
          {open() ? "Collapse output" : "Expand output"}
        </button>
      </Show>
    </Show>
  );
}
