// SPDX-License-Identifier: LGPL-3.0-only
import type { SidecarState } from "../state/sidecars.ts";
export default function ConnectionBadge(props: { sidecar: SidecarState }) {
  return (
    <div class="otk-connection" aria-live="polite">
      <span
        class={["otk-dot", {
          "otk-dot-connected": props.sidecar.status === "connected",
        }]}
      />
      <span data-connection={props.sidecar.id}>{props.sidecar.status}</span>
      <small data-harness={props.sidecar.id}>
        harness {props.sidecar.harness}
      </small>
    </div>
  );
}
