// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, Show } from "solid-js";

/** The factory owns a mounted lifetime; reads made by its children do not replace it. */
export default function ContentSlot(
  props: { content?: () => Element },
): Element {
  return <Show when={props.content} keyed>{(content) => content()}</Show>;
}
