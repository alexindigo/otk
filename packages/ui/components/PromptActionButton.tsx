// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, Show } from "solid-js";
import type { PromptAction } from "../registries/prompt.ts";
import ActionButton from "./ActionButton.tsx";
import "./PromptActionButton.css" with { type: "text" };

export default function PromptActionButton(props: {
  action: PromptAction;
  form: "bar" | "menu";
  onShown?(): void;
}): Element {
  const label = () => props.action.label();
  const classes = () =>
    props.form === "bar" ? "otk-icon-button" : "otk-prompt-action-menu-row";
  return (
    <ActionButton
      action={props.action.control}
      class={classes()}
      label={label()}
      title={label()}
      expanded={props.action.expanded?.()}
      onShown={props.onShown}
    >
      {props.action.icon()}
      <Show when={props.form === "menu"}>
        <span class="otk-control-label">{label()}</span>
      </Show>
    </ActionButton>
  );
}
