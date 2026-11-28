// SPDX-License-Identifier: LGPL-3.0-only
import "./StatusLight.css" with { type: "text" };
import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  LIGHT_STATES,
  lightDescription,
  type LightState,
} from "./status-light.ts";
import StateShape from "./StateShape.tsx";
const BLINK_DURATION_MS = 250;

/** Inputs only: a verdict change blinks once; initial mounting is silent. */
export default function StatusLight(props: {
  state: LightState;
  small?: boolean;
  label?: string;
  dependencies?: number;
  /** Explicit animation input for standalone consumers. Application callers
   * use published verdict transitions and do not supply this input. */
  event?: string | number;
}): import("solid-js").Element {
  const state = () => props.state;
  const [blink, setBlink] = createSignal(false);
  const description = () =>
    props.label ?? lightDescription(state(), props.dependencies);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => [props.event, state()] as const, (next, previous) => {
    if (!previous || next.every((value, i) => value === previous[i])) return;
    clearTimeout(timer);
    setBlink(false);
    // A new identity replaces the old pulse, rather than accumulating animations.
    timer = setTimeout(() => {
      setBlink(true);
      timer = setTimeout(() => setBlink(false), BLINK_DURATION_MS);
    }, 0);
  });
  onCleanup(() => clearTimeout(timer));
  return (
    <span
      class="otk-status-light"
      style={{ "--lamp-blink-duration": `${BLINK_DURATION_MS}ms` }}
      data-state={state()}
      data-small={props.small || undefined}
      data-blink={blink() || undefined}
      role="img"
      aria-label={description()}
      title={description()}
    >
      <span class="otk-lamp-glow" aria-hidden="true" />
      <span class="otk-lamp-body" aria-hidden="true" />
      <StateShape
        class={state() === "dependencies"
          ? "otk-lamp-shape otk-lamp-dependency-shape"
          : "otk-lamp-shape"}
        kind={LIGHT_STATES[state()].shape}
      />
    </span>
  );
}
