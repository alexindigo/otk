// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, For } from "solid-js";
import type { CapabilityName } from "@otk/protocol";
import { useUiRegistries } from "../registries/context.tsx";
/** Dock order and capability selection follow consumer-owned registrations. */
export default function Docks(
  props: {
    capabilities: readonly CapabilityName[];
    inputs: Readonly<Record<string, Element>>;
  },
): Element {
  const { docks } = useUiRegistries();
  return (
    <For
      each={docks.available(props.capabilities)}
      keyed={(dock) => dock.id}
    >
      {(dock) => dock().render(props.inputs)}
    </For>
  );
}
