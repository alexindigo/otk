// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import "./EdgeTriangle.css" with { type: "text" };

/** A stable, control-height slot; unavailable navigation has no control. */
export default function EdgeTriangle(props: {
  direction: "previous" | "next";
  visible: boolean;
  onClick(): void;
}) {
  return (
    <span class="otk-edge-slot">
      <Show when={props.visible}>
        <button
          type="button"
          class="otk-icon-button otk-edge-triangle"
          data-direction={props.direction}
          aria-label={props.direction === "next"
            ? "Next tasks"
            : "Previous tasks"}
          onClick={() => props.onClick()}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d={props.direction === "next"
                ? "M5 3L11 8L5 13Z"
                : "M11 3L5 8L11 13Z"}
              fill="currentColor"
            />
          </svg>
        </button>
      </Show>
    </span>
  );
}
