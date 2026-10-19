// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, Show } from "solid-js";

export { selectionLabel } from "./selection-label.ts";

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
