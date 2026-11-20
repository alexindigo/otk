// SPDX-License-Identifier: LGPL-3.0-only
import { Match, Switch } from "solid-js";
import "./StateShape.css" with { type: "text" };

/** Shape, not a font glyph, carries state when color is unavailable. */
export type StateShapeKind =
  | "cross"
  | "half-disc"
  | "check"
  | "circle"
  | "loading"
  | "retry";
export default function StateShape(
  props: { kind: StateShapeKind; class?: string },
) {
  return (
    <svg
      class={["otk-state-shape", props.class]}
      viewBox="0 0 10 10"
      aria-hidden="true"
    >
      <Switch>
        <Match when={props.kind === "cross"}>
          <path d="m2 2 6 6m0-6L2 8" />
        </Match>
        <Match when={props.kind === "check"}>
          <path d="m1.5 5 2.5 2.5 4.5-5" />
        </Match>
        <Match when={props.kind === "circle"}>
          <circle cx="5" cy="5" r="4" />
        </Match>
        <Match when={props.kind === "half-disc"}>
          <circle cx="5" cy="5" r="4" />
          <path d="M5 1a4 4 0 0 0 0 8Z" fill="currentColor" stroke="none" />
        </Match>
        <Match when={props.kind === "loading"}>
          <circle cx="5" cy="5" r="4" stroke-dasharray="1 2" />
        </Match>
        <Match when={props.kind === "retry"}>
          <path d="M8 4a3.5 3.5 0 1 0 .2 2M8 1v3H5" />
        </Match>
      </Switch>
    </svg>
  );
}
