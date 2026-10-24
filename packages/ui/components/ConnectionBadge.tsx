// SPDX-License-Identifier: LGPL-3.0-only
import "./ConnectionBadge.css" with { type: "text" };
import type { SidecarState } from "@otk/client";
import ConnectionLight from "./ConnectionLight.tsx";
export default function ConnectionBadge(props: { sidecar: SidecarState }) {
  return (
    <div class="otk-connection" aria-live="polite">
      <ConnectionLight small connection={props.sidecar} />
      <span data-connection={props.sidecar.id}>{props.sidecar.status}</span>
      <small data-harness={props.sidecar.id}>
        Agent service {props.sidecar.harness}
      </small>
    </div>
  );
}
