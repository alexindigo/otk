// SPDX-License-Identifier: LGPL-3.0-only
import "./Tabs.css" with { type: "text" };
import ScrollRegion from "./ScrollRegion.tsx";
import { type Element, For, Show } from "solid-js";
import { CloseIcon } from "./ChromeIcons.tsx";
import ActionButton from "./ActionButton.tsx";
import type { ActionControl } from "@otk/client";
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";

interface TabPanelsProps {
  tabs: {
    id?: string;
    label: string;
    panel: () => Element;
    closeable?: boolean;
  }[];
  selected: number;
}

interface TabStripProps extends TabPanelsProps {
  label: string;
  onSelect(index: number): void;
  closeAction?(id: string): ActionControl;
  compact?: boolean;
}

/** Item navigation and per-item close controls; the frame owns its actions. */
export function TabStrip(props: TabStripProps): Element {
  return (
    <div class={["otk-tabs-header", { "is-compact": props.compact }]}>
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
    </div>
  );
}

/** Panels share one grid cell, so natural height follows the tallest tab. */
export function TabPanels(props: TabPanelsProps): Element {
  return (
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
  );
}

/** Standalone item collection with no container chrome. */
export default function Tabs(props: TabStripProps): Element {
  return (
    <div class="otk-tabs">
      <TabStrip
        label={props.label}
        tabs={props.tabs}
        selected={props.selected}
        onSelect={props.onSelect}
        closeAction={props.closeAction}
        compact={props.compact}
      />
      <TabPanels tabs={props.tabs} selected={props.selected} />
    </div>
  );
}
