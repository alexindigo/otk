// SPDX-License-Identifier: LGPL-3.0-only
import type { ComponentProps } from "@solidjs/web";
import { nativeAttributes } from "./native-attributes.ts";
import TaskMarker from "./TaskMarker.tsx";
import "./Checkbox.css" with { type: "text" };

/** Native checked/focus semantics with the same artwork as question choices. */
export default function Checkbox(props: ComponentProps<"input">) {
  const native = nativeAttributes(() => props, ["class"]);
  return (
    <span class="otk-checkbox">
      <span aria-hidden="true">
        <TaskMarker done={props.checked === true} />
      </span>
      <input
        {...native.attributes}
        ref={[props.ref, native.ref]}
        type="checkbox"
        class={["otk-checkbox-input", props.class]}
      />
    </span>
  );
}
