// SPDX-License-Identifier: LGPL-3.0-only
import "./StatusLight.css" with { type: "text" };
import { createEffect, createSignal, onCleanup } from "solid-js";
import { LIGHT_STATES, type LightState } from "./status-light.ts";
/** Inputs only: event identity changes blink once; initial mounting is silent. */
export default function StatusLight(props: {
  state: LightState;
  small?: boolean;
  activity?: "spinner";
  event?: string | number;
}): import("solid-js").Element {
  const [blink, setBlink] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => [props.event, props.state] as const, (next, previous) => {
    if (!previous || next.every((value, i) => value === previous[i])) return;
    clearTimeout(timer);
    setBlink(false);
    // A new identity replaces the old pulse, rather than accumulating animations.
    timer = setTimeout(() => {
      setBlink(true);
      timer = setTimeout(() => setBlink(false), 250);
    }, 0);
  });
  onCleanup(() => clearTimeout(timer));
  return (
    <span
      class="otk-status-light"
      data-state={props.state}
      data-activity={props.activity}
      data-small={props.small || undefined}
      data-blink={blink() || undefined}
      role="img"
      aria-label={LIGHT_STATES[props.state].label}
      title={LIGHT_STATES[props.state].label}
    >
      <span class="otk-lamp-glow" aria-hidden="true" />
      <span class="otk-lamp-body" aria-hidden="true" />
      <span class="otk-lamp-shape" aria-hidden="true">
        {LIGHT_STATES[props.state].shape}
      </span>
    </span>
  );
}
