// SPDX-License-Identifier: LGPL-3.0-only
import "./Toast.css" with { type: "text" };
import type { Element } from "solid-js";
import Surface from "./Surface.tsx";

export default function Toast(props: {
  id: string;
  kind: string;
  lead?: boolean;
  signal?: "error" | "info";
  children: Element;
}): Element {
  return (
    <article
      class={["otk-toast", { "has-lead": props.lead }]}
      data-note={props.id}
      data-kind={props.kind}
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
