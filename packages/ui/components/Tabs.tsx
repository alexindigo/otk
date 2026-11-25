// SPDX-License-Identifier: LGPL-3.0-only
import "./Tabs.css" with { type: "text" };
import ScrollRegion from "./ScrollRegion.tsx";
import { type Element, For, Show } from "solid-js";
import { CloseIcon } from "./ChromeIcons.tsx";
import ActionButton from "./ActionButton.tsx";
import type { ActionControl } from "@otk/client";
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
    tabs: {
      id?: string;
      label: string;
      panel: () => Element;
      closeable?: boolean;
    }[];
    selected: number;
    onSelect(index: number): void;
    closeAction?(id: string): ActionControl;
    actions?: () => Element;
    leading?: () => Element;
    compact?: boolean;
  },
): Element {
  return (
    <div class={["otk-tabs", { "is-compact": props.compact }]}>
      <div class="otk-tabs-header">
        {props.leading?.()}
        <ScrollRegion
          class="otk-tabs-strip"
          frameClass="otk-tabs-strip-frame"
          axis="x"
          borrowed={!props.compact}
          role="tablist"
          aria-label={props.label}
        >
          <For
            each={props.tabs}
            keyed={(tab) => tab.id ?? props.tabs.indexOf(tab)}
          >
            {(tab, i) => (
              <div class="otk-tabs-item" role="presentation">
                <button
                  type="button"
                  role="tab"
                  data-otk-selection="horizontal"
                  {...selection({
                    kind: "selected",
                    selected: props.selected === i(),
                  })}
                  onClick={() => props.onSelect(i())}
                  title={tab().label}
                >
                  <SelectionContent>
                    <span class="otk-control-label">{tab().label}</span>
                  </SelectionContent>
                </button>
                <Show
                  when={props.closeAction && tab().closeable !== false &&
                    tab().id}
                >
                  {(id) => (
                    <ActionButton
                      action={props.closeAction!(id())}
                      class="otk-icon-button"
                      label={`Close ${tab().label}`}
                      title={`Close ${tab().label}`}
                    >
                      <CloseIcon />
                    </ActionButton>
                  )}
                </Show>
              </div>
            )}
          </For>
        </ScrollRegion>
        <Show when={props.actions}>
          <div class="otk-tabs-actions">{props.actions?.()}</div>
        </Show>
      </div>
      <ScrollRegion class="otk-tabs-panels">
        <For
          each={props.tabs}
          keyed={(tab) => tab.id ?? props.tabs.indexOf(tab)}
        >
          {(tab, i) => (
            <div
              class="otk-tabs-panel"
              role="tabpanel"
              data-active={props.selected === i() ? "true" : "false"}
              inert={props.selected !== i()}
            >
              {tab().panel()}
            </div>
          )}
        </For>
      </ScrollRegion>
    </div>
  );
}
