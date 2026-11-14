// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
import type { PrimaryActionState } from "@otk/client";

/** Persistent primary control. Callers supply state and an owner-bound intent. */
export default function PrimaryAction(props: {
  state: PrimaryActionState;
  class: string;
  type?: "button" | "submit";
  /** A submit primary may belong to a form outside its footer. */
  form?: string;
  title?: string;
  description?: string;
  children?: Element;
  ref?(element: HTMLButtonElement): void;
  onInvoke(): void;
}): Element {
  return (
    <button
      type={props.type ?? "button"}
      form={props.form}
      ref={props.ref}
      class={props.class}
      data-primary-action="true"
      aria-label={props.state.label}
      disabled={!props.state.available}
      aria-busy={props.state.pending ? "true" : "false"}
      aria-description={props.state.reason ?? props.description}
      title={props.state.reason ?? props.title ?? props.state.label}
      onClick={() => {
        if (props.type !== "submit") props.onInvoke();
      }}
    >
      {props.children ?? props.state.label}
    </button>
  );
}
