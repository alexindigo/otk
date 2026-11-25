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
  children?: Element;
  class?: string;
  ref?(element: HTMLElement): void;
  actions?: { kind: "prompt" | "reply"; target: ContentTarget };
}) {
  return (
    <footer ref={props.ref} class={["otk-message-footer", props.class]}>
      <MetaRow class="otk-message-details">
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
