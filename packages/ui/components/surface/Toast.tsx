// SPDX-License-Identifier: LGPL-3.0-only
import "./Toast.css" with { type: "text" };
import type { Element } from "solid-js";
import Surface from "./Surface.tsx";

export default function Toast(props: {
  id: string;
  kind: string;
  lead?: boolean;
  signal?: "error" | "info";
  onHold?(held: boolean): void;
  children: Element;
}): Element {
  return (
    <article
      class={["otk-toast", { "has-lead": props.lead }]}
      data-note={props.id}
      data-kind={props.kind}
      onMouseEnter={() => props.onHold?.(true)}
      onMouseLeave={(event) =>
        props.onHold?.(event.currentTarget.matches(":focus-within"))}
      onFocusIn={() => props.onHold?.(true)}
      onFocusOut={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        props.onHold?.(event.currentTarget.matches(":hover"));
      }}
    >
      <Surface
        layout="fill"
        staticChildren
        signal={props.signal}
      >
        {props.children}
      </Surface>
    </article>
  );
}
