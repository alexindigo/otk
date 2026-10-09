// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { CompletionOption } from "./autocomplete.ts";
export default function Autocomplete(
  props: {
    options: CompletionOption[];
    selected: number;
    onSelect(index: number): void;
  },
) {
  return (
    <div
      class="otk-autocomplete"
      role="listbox"
      aria-label="Prompt completions"
    >
      <For each={props.options} keyed={(option) => option.id}>
        {(option, index) => (
          <button
            type="button"
            role="option"
            aria-selected={props.selected === index() ? "true" : "false"}
            onClick={() => props.onSelect(index())}
          >
            <span>{option().label}{option().directory ? "/" : ""}</span>
            <span class="otk-muted">{option().description}</span>
          </button>
        )}
      </For>
    </div>
  );
}
