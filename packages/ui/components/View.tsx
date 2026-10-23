// SPDX-License-Identifier: LGPL-3.0-only
import "./View.css" with { type: "text" };
import type { Element } from "solid-js";

export function ViewHeader(
  props: { title: string; actions?: Element },
): Element {
  return (
    <header class="otk-view-header">
      <h1>{props.title}</h1>
      {props.actions}
    </header>
  );
}

export function EmptyState(props: { children: Element }): Element {
  return <p class="otk-muted otk-empty">{props.children}</p>;
}
