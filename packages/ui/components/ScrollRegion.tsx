// SPDX-License-Identifier: LGPL-3.0-only
import "./ScrollRegion.css" with { type: "text" };
import type { ComponentProps } from "@solidjs/web";
import type { Element } from "solid-js";
import { nativeAttributes } from "./native-attributes.ts";

export type ScrollAxis = "both" | "x" | "y";
export type ScrollbarPaint = "native" | "thin" | "hidden";

/** Native elements borrow the same scroll policy without adding a wrapper. */
export function scrollRegion(
  axis: ScrollAxis = "both",
  scrollbar: ScrollbarPaint = "native",
): string {
  return `otk-scroll${axis === "both" ? "" : ` otk-scroll-${axis}`}${
    scrollbar === "native" ? "" : ` otk-scrollbar-${scrollbar}`
  }`;
}

/** Scroll ownership, independent of content, geometry and position owners. */
export default function ScrollRegion(
  props: Omit<ComponentProps<"div">, "class"> & {
    class?: string;
    axis?: ScrollAxis;
    scrollbar?: ScrollbarPaint;
  },
): Element {
  const native = nativeAttributes(() => ({
    ...props,
    axis: undefined,
    scrollbar: undefined,
  }));
  return (
    <div
      {...native.attributes}
      ref={[props.ref, native.ref]}
      class={[scrollRegion(props.axis, props.scrollbar), props.class]}
    >
      {props.children}
    </div>
  );
}
