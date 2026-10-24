// SPDX-License-Identifier: LGPL-3.0-only
import "./ConnectionLight.css" with { type: "text" };
import {
  CONNECTION_STATES,
  type ConnectionInput,
  connectionLabel,
  connectionState,
} from "./connection-light.ts";

/** Connection health is independent of session completion/attention semantics. */
export default function ConnectionLight(
  props: { connection?: ConnectionInput; small?: boolean },
): import("solid-js").Element {
  const state = () => connectionState(props.connection);
  const label = () =>
    props.connection
      ? `${CONNECTION_STATES[state()].label}. ${
        connectionLabel(props.connection)
      }`
      : connectionLabel();
  return (
    <span
      class="otk-connection-light"
      data-connection-state={state()}
      data-small={props.small || undefined}
      role="img"
      aria-label={label()}
      title={label()}
    >
      <span class="otk-connection-dot" aria-hidden="true" />
      <span class="otk-connection-shape" aria-hidden="true">
        {CONNECTION_STATES[state()].shape}
      </span>
    </span>
  );
}
