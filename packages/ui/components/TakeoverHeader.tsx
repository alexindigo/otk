// SPDX-License-Identifier: LGPL-3.0-only
import "./TakeoverHeader.css" with { type: "text" };
import { Show } from "solid-js";
import StatusLight from "./StatusLight.tsx";
export default function TakeoverHeader(
  props: {
    title: string;
    where?: string;
    childTitle?: string;
    detail?: string;
  },
) {
  return (
    <header class="otk-takeover-header">
      <StatusLight state="blocked" />
      <h2 title={props.detail}>{props.title}</h2>
      <Show when={props.where}>
        <span class="otk-takeover-where">{props.where}</span>
      </Show>
      <Show when={props.childTitle}>
        <span class="otk-permission-child">From {props.childTitle}</span>
      </Show>
      <span class="otk-draft-kept">Your draft is kept</span>
    </header>
  );
}
