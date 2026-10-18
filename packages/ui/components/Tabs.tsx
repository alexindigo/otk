// SPDX-License-Identifier: LGPL-3.0-only
import "./Tabs.css" with { type: "text" };
import { type Element, For } from "solid-js";
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
/**
 * A tab strip and its panels. All panels share one grid cell, so the widget
 * keeps the height of its tallest tab; only the selected one is visible.
 * Panels own their vertical rhythm; content brings no margins.
 */
export default function Tabs(
  props: {
    label: string;
    tabs: { label: string; panel: () => Element }[];
    selected: number;
    onSelect(index: number): void;
  },
): Element {
  return (
    <div class="otk-tabs">
      <div class="otk-tabs-strip" role="tablist" aria-label={props.label}>
        <For each={props.tabs} keyed={false}>
          {(tab, i) => (
            <button
              type="button"
              role="tab"
              data-otk-selection="horizontal"
              {...selection({
                kind: "selected",
                selected: props.selected === i,
              })}
              onClick={() => props.onSelect(i)}
            >
              <SelectionContent>{tab().label}</SelectionContent>
            </button>
          )}
        </For>
      </div>
      <div class="otk-tabs-panels">
        <For each={props.tabs} keyed={false}>
          {(tab, i) => (
            <div
              class="otk-tabs-panel"
              role="tabpanel"
              data-active={props.selected === i ? "true" : "false"}
              inert={props.selected !== i}
            >
              {tab().panel()}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
