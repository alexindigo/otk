// SPDX-License-Identifier: LGPL-3.0-only
import "./labels.css" with { type: "text" };
import { type Element, Show } from "solid-js";
import { selection } from "../selection.ts";

export { selectionLabel } from "./selection-label.ts";

export function PromptSetting(
  props: { children: Element; applied?: boolean },
): Element {
  return (
    <span
      {...selection({
        kind: "candidate",
        selected: false,
        applied: props.applied,
        class: "otk-prompt-setting",
      })}
    >
      {props.children}
    </span>
  );
}

export function ModelLabel(
  props: { provider?: string; name?: string; class?: string },
): Element {
  return (
    <span class={["otk-composer-model", props.class]}>
      <Show when={props.provider}>
        <span class="otk-composer-provider">{props.provider}</span>
      </Show>
      <span class="otk-composer-model-name">
        {props.name ?? "Default model"}
      </span>
    </span>
  );
}
