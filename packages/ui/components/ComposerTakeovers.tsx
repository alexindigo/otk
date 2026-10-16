// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, For } from "solid-js";
import { useUiRegistries } from "../registries/context.tsx";
import { useSessionPorts } from "../registries/session.tsx";
export default function ComposerTakeovers(
  props: { children?: (active: () => boolean) => Element },
): Element {
  const { takeovers } = useUiRegistries(), session = useSessionPorts();
  const available = () => takeovers.available(session.supports);
  const active = () =>
    available().some((item) => item.active?.(session) ?? true);
  return (
    <div class="otk-composer" data-takeover={active() ? "true" : "false"}>
      <For
        each={available()}
        keyed={(item) => item.id}
      >
        {(item) => item().component()}
      </For>
      {props.children?.(active)}
    </div>
  );
}
