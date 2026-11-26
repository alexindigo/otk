// SPDX-License-Identifier: LGPL-3.0-only
import "./MessageFooter.css" with { type: "text" };
import { type Element, Show } from "solid-js";
import Clock from "./Clock.tsx";
import { MetaRow } from "./ChromeMeta.tsx";
import MessageActions from "./MessageActions.tsx";
import type { ContentTarget } from "../features/transcript-context.tsx";

/** One persistent metadata/action track, independent of pointer ownership. */
export default function MessageFooter(props: {
  at?: number;
  duration?: Element;
  leading?: Element;
  whole?: boolean;
  intrinsic?: boolean;
  children?: Element;
  class?: string;
  ref?(element: HTMLElement): void;
  actions?: { kind: "prompt" | "reply"; target: ContentTarget };
}) {
  return (
    <footer
      ref={props.ref}
      class={["otk-message-footer", props.class, {
        "has-whole-details": props.whole,
      }]}
    >
      <MetaRow
        class="otk-message-details"
        whole={props.whole}
        intrinsic={props.intrinsic}
      >
        {props.leading}
        <Show when={props.at !== undefined}>
          <Clock at={props.at!} />
        </Show>
        {props.duration}
        {props.children}
      </MetaRow>
      <Show when={props.actions}>
        {(actions) => <MessageActions {...actions()} />}
      </Show>
    </footer>
  );
}
