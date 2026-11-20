// SPDX-License-Identifier: LGPL-3.0-only
import "./ConnectionBadge.css" with { type: "text" };
import type { SidecarState } from "@otk/client";
import { Show } from "solid-js";
import ConnectionLight from "./ConnectionLight.tsx";
import ConnectionStatus from "./ConnectionStatus.tsx";
import { connectionLabel } from "./connection-light.ts";
import { ControlIcon } from "./ControlValue.tsx";
export default function ConnectionBadge(props: {
  sidecar: SidecarState;
  label?: boolean;
  status?: boolean;
  compact?: boolean;
  onSettings?(): void;
}) {
  const identity = () => (
    <>
      <ControlIcon>
        <ConnectionLight small connection={props.sidecar} />
      </ControlIcon>
      <Show when={props.label !== false}>
        <span class="otk-server-label">{props.sidecar.label}</span>
      </Show>
    </>
  );
  return (
    <div
      class={["otk-connection", {
        "is-unlabelled": props.label === false,
        "is-lamp-only": props.label === false && props.status === false,
      }]}
      aria-live="polite"
    >
      <Show
        when={!!props.onSettings}
        fallback={
          <div
            class="otk-connection-heading"
            data-connection={props.sidecar.id}
            title={connectionLabel(props.sidecar)}
          >
            {identity()}
          </div>
        }
      >
        <button
          type="button"
          class="otk-connection-heading otk-server-status"
          data-connection={props.sidecar.id}
          aria-label={connectionLabel(props.sidecar)}
          title={connectionLabel(props.sidecar)}
          onClick={() => props.onSettings?.()}
        >
          {identity()}
        </button>
      </Show>
      <Show when={props.status !== false}>
        <ConnectionStatus
          connection={props.sidecar}
          compact={props.compact}
          onSettings={props.onSettings}
        />
      </Show>
    </div>
  );
}
