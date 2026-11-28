// SPDX-License-Identifier: LGPL-3.0-only
import "./MessageFooter.css" with { type: "text" };
import { type Element, Show } from "solid-js";
import Clock from "./Clock.tsx";
import { MetaItem, MetaRow } from "./ChromeMeta.tsx";
import MessageActions from "./MessageActions.tsx";
import {
  type ContentTarget,
  transcriptDisclosureIdentity,
} from "../features/transcript-context.tsx";
import Disclosure from "./Disclosure.tsx";

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
  const identify = transcriptDisclosureIdentity();
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
      {(key) => (
        <Disclosure
          kind="silent"
          identity={identify({ owner: key })}
          input={{ category: "record" }}
          variant="compact"
          label="Completion details"
          hasContent={() => !!props.completion}
          layout={({ trigger, region }) => (
            <>
              {footer(<MetaItem rank={0} required>{trigger()}</MetaItem>)}
              {region()}
            </>
          )}
        >
          {() => props.completion?.body()}
        </Disclosure>
      )}
    </Show>
  );
}
