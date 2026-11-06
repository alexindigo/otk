// SPDX-License-Identifier: LGPL-3.0-only
import "./ComposerTakeovers.css" with { type: "text" };
import { scrollRegion } from "./ScrollRegion.tsx";
import { type Element, For } from "solid-js";
import { useUiRegistries } from "../registries/context.tsx";
import { useSessionPorts } from "../registries/session.tsx";
import ContentSlot from "./ContentSlot.tsx";
export default function ComposerTakeovers(
  props: {
    children?: (active: () => boolean) => Element;
    notice?: () => Element;
    focusNotice?(): void;
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
            focusNotice: () => props.focusNotice?.(),
          })}
      </For>
      <div
        class={[scrollRegion(), "otk-composer"]}
        data-takeover={active() ? "true" : "false"}
        hidden={active()}
      >
        <ContentSlot content={!active() ? props.notice : undefined} />
        <div class={["otk-composer-body", { "is-noticed": !!props.notice }]}>
          {props.children?.(active)}
        </div>
      </div>
    </div>
  );
}
