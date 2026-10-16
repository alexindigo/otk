// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import { useUiRegistries } from "../registries/context.tsx";
import { useSessionPorts } from "../registries/session.tsx";
export default function ComposerTakeovers(): import("solid-js").Element {
  const { takeovers } = useUiRegistries(), session = useSessionPorts();
  return (
    <For
      each={takeovers.available(session.supports)}
      keyed={(item) => item.id}
    >
      {(item) => item().component()}
    </For>
  );
}
