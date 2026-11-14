// SPDX-License-Identifier: LGPL-3.0-only
import "./Takeover.css" with { type: "text" };
import { type Element, Show } from "solid-js";
import Surface from "./Surface.tsx";
import ContentSlot from "../ContentSlot.tsx";

/**
 * The composer-area surface for approvals and questions: same box as the
 * composer. Collapsed, it keeps only its title and a one-line body.
 */
export default function Takeover(props: {
  title: Element;
  actions?: () => Element;
  collapsed?: boolean;
  notice?: () => Element;
  children: Element;
}): Element {
  return (
    <div
      class={["otk-takeover", { "is-noticed": !!props.notice }]}
      data-collapsed={props.collapsed ? "true" : "false"}
    >
      <Show when={!!props.notice}>
        {(_present) => (
          <div class="otk-takeover-notice">
            <ContentSlot content={props.notice} />
          </div>
        )}
      </Show>
      <Surface
        title={props.title}
        actions={props.collapsed || !props.actions
          ? undefined
          : <ContentSlot content={props.actions} />}
      >
        {props.children}
      </Surface>
    </div>
  );
}
