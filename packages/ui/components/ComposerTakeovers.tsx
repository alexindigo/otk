// SPDX-License-Identifier: LGPL-3.0-only
import "./ComposerTakeovers.css" with { type: "text" };
import { type Element, For, Show } from "solid-js";
import { useUiRegistries } from "../registries/context.tsx";
import { useSessionPorts } from "../registries/session.tsx";
export default function ComposerTakeovers(
  props: {
    children?: (active: () => boolean) => Element;
    notice?: () => Element;
  },
): Element {
  const { takeovers } = useUiRegistries(), session = useSessionPorts();
  const available = () => takeovers.available(session.supports);
  const active = () =>
    available().some((item) => item.active?.(session) ?? true);
  const first = () =>
    available().find((item) => item.active?.(session) ?? true)?.id;
  return (
    <div class="otk-composer-dock">
      <For each={available()} keyed={(item) => item.id}>
        {(item) =>
          item().component({
            get notice() {
              return item().id === first() ? props.notice : undefined;
            },
          })}
      </For>
      <div
        class="otk-composer"
        data-takeover={active() ? "true" : "false"}
        hidden={active()}
      >
        <Show when={!active()}>{props.notice?.()}</Show>
        <div class={["otk-composer-body", { "is-noticed": !!props.notice }]}>
          {props.children?.(active)}
        </div>
      </div>
    </div>
  );
}
