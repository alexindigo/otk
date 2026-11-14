// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
import Icon from "./Icon.tsx";
import "./JumpToLatest.css" with { type: "text" };

/** A viewport-local overlay that never takes space from transcript or composer. */
export default function JumpToLatest(props: {
  visible: boolean;
  title: string;
  onJump(): void;
}): Element {
  return (
    <div class={["otk-jump-slot", { "is-visible": props.visible }]}>
      <button
        type="button"
        class="otk-icon-button"
        aria-label="Jump to latest"
        title={props.title}
        inert={!props.visible}
        aria-hidden={!props.visible ? "true" : undefined}
        onClick={() => props.onJump()}
      >
        <Icon class="otk-chrome-icon">
          <path d="M12 4v16m-6-6 6 6 6-6" />
        </Icon>
      </button>
    </div>
  );
}
