// SPDX-License-Identifier: LGPL-3.0-only
import "./LiveLink.css" with { type: "text" };
import { Show } from "solid-js";
import type { ComposerLinkState } from "@otk/protocol";

/** 2.78: decorative link from the session title to its work pills. Motion is
 * CSS only and follows `state`; the pills carry the accessible meaning. */
export default function LiveLink(props: { state: ComposerLinkState }) {
  return (
    <Show when={props.state !== "none"}>
      <span class="otk-live-link" data-state={props.state} aria-hidden="true">
        <span class="otk-live-link-light" />
      </span>
    </Show>
  );
}
