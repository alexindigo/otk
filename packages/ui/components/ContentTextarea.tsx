// SPDX-License-Identifier: LGPL-3.0-only
import "./ContentTextarea.css" with { type: "text" };
import type { Element } from "solid-js";
import type { ComponentProps } from "@solidjs/web";
import { nativeAttributes } from "./native-attributes.ts";

/** Native input props/ref stay with the caller; sizing and native listener lifetime
 * are shared by every content-sized input. */
export default function ContentTextarea(
  props: Omit<ComponentProps<"textarea">, "class"> & { class?: string },
): Element {
  const native = nativeAttributes(() => props);
  return (
    <textarea
      {...native.attributes}
      ref={[props.ref, native.ref]}
      class={["otk-content-textarea", props.class]}
    />
  );
}
