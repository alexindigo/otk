// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
import "./AuthColumn.css" with { type: "text" };
export default function AuthColumn(
  props: { title: string; description?: string; children: Element },
): Element {
  return (
    <section class="otk-auth-column">
      <h1>{props.title}</h1>
      {props.description ? <p>{props.description}</p> : null}
      {props.children}
    </section>
  );
}
