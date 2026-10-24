// SPDX-License-Identifier: LGPL-3.0-only
import "./Autocomplete.css" with { type: "text" };
import { selection } from "../selection.ts";
import SelectionContent from "../SelectionContent.tsx";
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
            data-otk-selection="vertical"
            {...selection({
              kind: "selected",
              selected: props.selected === index(),
            })}
            onClick={() => props.onSelect(index())}
          >
            <SelectionContent class="otk-autocomplete-content">
              <span>{option().label}{option().directory ? "/" : ""}</span>
              <span class="otk-muted">{option().description}</span>
            </SelectionContent>
          </button>
        )}
      </For>
    </div>
  );
}
