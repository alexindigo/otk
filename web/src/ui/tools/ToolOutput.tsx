// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, Show } from "solid-js";
export default function ToolOutput(props: { text: string; limit: number }) {
  const [open, setOpen] = createSignal(false);
  const lines = () => props.text.trimEnd().split("\n");
  return (
    <Show when={props.text}>
      <pre class="otk-tool-output">{open()?props.text.trimEnd():lines().slice(0,props.limit).join("\n")}</pre>
      <Show when={lines().length > props.limit}>
        <button
          class="otk-output-toggle"
          type="button"
          aria-expanded={open() ? "true" : "false"}
          onClick={() => setOpen((value) => !value)}
        >
          {open() ? "Collapse output" : "Expand output"}
        </button>
      </Show>
    </Show>
  );
}
