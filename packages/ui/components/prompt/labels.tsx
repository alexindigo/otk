// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, Show } from "solid-js";

/** Presentation only: keys and submitted choices retain their exact spelling. */
export function selectionLabel(value: string): string {
  return value.replace(/(^|[\s_-])\p{L}/gu, (letter) => letter.toUpperCase());
}

export function ModelLabel(
  props: { provider?: string; name?: string },
): Element {
  return (
    <span class="otk-composer-model">
      <Show when={props.provider}>
        <span class="otk-composer-provider">{props.provider}</span>
      </Show>
      <span class="otk-composer-model-name">
        {props.name ?? "Default model"}
      </span>
    </span>
  );
}
