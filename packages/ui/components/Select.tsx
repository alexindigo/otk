// SPDX-License-Identifier: LGPL-3.0-only
import type { ComponentProps } from "@solidjs/web";
import type { Element } from "solid-js";
import { nativeAttributes } from "./native-attributes.ts";
import ControlValue from "./ControlValue.tsx";
import { ChevronDownIcon } from "./ChromeIcons.tsx";
import "./Select.css" with { type: "text" };
/** One native focus/value target with a noninteractive shared accessory cell. */
export default function Select(
  props: ComponentProps<"select"> & { containerClass?: string },
): Element {
  const native = nativeAttributes(() => ({
    ...props,
    containerClass: undefined,
  }));
  return (
    <span class={["otk-select", props.containerClass]}>
      <select {...native.attributes} ref={[props.ref, native.ref]}>
        {props.children}
      </select>
      <span class="otk-select-decoration" aria-hidden="true">
        <ControlValue accessory={<ChevronDownIcon />} />
      </span>
    </span>
  );
}
