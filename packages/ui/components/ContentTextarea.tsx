// SPDX-License-Identifier: LGPL-3.0-only
import "./ContentTextarea.css" with { type: "text" };
import type { Element } from "solid-js";
import type { ComponentProps } from "@solidjs/web";

/** Native input props/ref stay with the caller; this owns content sizing only. */
export default function ContentTextarea(
  props: Omit<ComponentProps<"textarea">, "class"> & { class?: string },
): Element {
  return <textarea {...props} class={["otk-content-textarea", props.class]} />;
}
