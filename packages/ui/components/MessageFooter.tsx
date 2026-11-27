// SPDX-License-Identifier: LGPL-3.0-only
import "./MessageFooter.css" with { type: "text" };
import { type Element, Show } from "solid-js";
import Clock from "./Clock.tsx";
import { MetaItem, MetaRow } from "./ChromeMeta.tsx";
import MessageActions from "./MessageActions.tsx";
import {
  type ContentTarget,
  retainedDisclosure,
} from "../features/transcript-context.tsx";
import DisclosureToggle from "./DisclosureToggle.tsx";

export interface FooterCompletion {
  key: string;
  body(): Element;
}

/** One persistent metadata/action track, independent of pointer ownership. */
export default function MessageFooter(props: {
  at?: number;
  duration?: Element;
  leading?: Element;
  whole?: boolean;
  intrinsic?: boolean;
  children?: Element;
  completion?: FooterCompletion;
  class?: string;
  ref?(element: HTMLElement): void;
  actions?: { kind: "prompt" | "reply"; target: ContentTarget };
}) {
  const footer = (completion?: Element) => (
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
        {completion}
        {props.children}
      </MetaRow>
      <Show when={props.actions}>
        {(actions) => <MessageActions {...actions()} />}
      </Show>
    </footer>
  );
  return (
    <Show when={props.completion?.key} keyed fallback={footer()}>
      {(key) => {
        // Same identity as an interval in the transcript; a silent interval
        // starts closed independently of the ordinary record default.
        const [open, setOpen] = retainedDisclosure(
          "activity",
          "record",
          undefined,
          undefined,
          undefined,
          key,
        );
        return (
          <>
            {footer(
              <MetaItem rank={0} required>
                <DisclosureToggle
                  variant="tree"
                  label="Completion details"
                  open={open()}
                  onOpen={setOpen}
                />
              </MetaItem>,
            )}
            <Show when={open()}>{props.completion?.body()}</Show>
          </>
        );
      }}
    </Show>
  );
}
