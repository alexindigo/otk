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
    collapsed?: boolean;
    onCollapse?(collapsed: boolean): void;
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
      <Show when={props.onCollapse}>
        <button
          type="button"
          class="otk-icon-button otk-takeover-collapse"
          aria-expanded={props.collapsed ? "false" : "true"}
          aria-label={props.collapsed
            ? "Show the question"
            : "Hide the question"}
          title={props.collapsed ? "Show the question" : "Hide the question"}
          onClick={() => props.onCollapse?.(!props.collapsed)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="m6 9 6 6 6-6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </Show>
    </header>
  );
}
