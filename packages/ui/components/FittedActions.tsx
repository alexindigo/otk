// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, For, Show } from "solid-js";
import OverflowRow from "./OverflowRow.tsx";
import Menu from "./surface/Menu.tsx";
import "./FittedActions.css" with { type: "text" };

export interface FittedAction {
  key: string;
  label: string;
  ariaLabel?: string;
  class?: string;
  icon?(): Element;
  disabled?: boolean;
  title?: string;
  run(): void;
}
/** Action labels fit in full or move to the shared More surface. */
export default function FittedActions(
  props: { items: readonly FittedAction[]; inline?: boolean },
): Element {
  return (
    <div class={["otk-fitted-actions", { "is-inline": props.inline === true }]}>
      <OverflowRow
        items={props.items}
        required={[]}
        intrinsic={props.inline}
        singleLine={props.inline}
        measure={(item) => (
          <span class={item.icon ? "otk-icon-button" : "otk-pill"}>
            <Show when={item.icon} fallback={item.label}>
              {(icon) =>
                icon()()}
            </Show>
          </span>
        )}
        more={(keys) => (
          <Menu
            label="More actions"
            trigger="..."
            triggerClass="otk-overflow-trigger"
          >
            <For
              each={props.items.filter((item) => keys().includes(item.key))}
              keyed={(item) =>
                item.key}
            >
              {(item) => (
                <button
                  type="button"
                  disabled={item().disabled}
                  title={item().title}
                  aria-label={item().ariaLabel}
                  class={item().class}
                  onClick={() => item().run()}
                >
                  {item().label}
                </button>
              )}
            </For>
          </Menu>
        )}
      >
        {(item) => (
          <button
            type="button"
            class={[item().icon ? "otk-icon-button" : "otk-pill", item().class]
              .filter(Boolean).join(" ")}
            aria-label={item().ariaLabel ?? item().label}
            disabled={item().disabled}
            title={item().title}
            onClick={() => item().run()}
          >
            <Show when={item().icon} fallback={item().label}>
              {(icon) => icon()()}
            </Show>
          </button>
        )}
      </OverflowRow>
    </div>
  );
}
