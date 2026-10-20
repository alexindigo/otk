// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import "./AutoMark.css" with { type: "text" };

export default function AutoMark(props: { active: boolean; label?: string }) {
  return (
    <Show when={props.active}>
      <span
        class="otk-auto-mark"
        title={props.label ?? "Session auto-approve is on"}
        aria-hidden="true"
      >
        Auto
      </span>
    </Show>
  );
}
