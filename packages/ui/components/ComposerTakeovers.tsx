// SPDX-License-Identifier: LGPL-3.0-only
import "./ComposerTakeovers.css" with { type: "text" };
import { scrollRegion } from "./ScrollRegion.tsx";
import { type Element, For, Show } from "solid-js";
import { useUiRegistries } from "../registries/context.tsx";
import { useSessionPorts } from "../registries/session.tsx";
import ContentSlot from "./ContentSlot.tsx";
import { ComposerProvider } from "../registries/composer.tsx";
export default function ComposerTakeovers(
  props: {
    children?: (active: () => boolean) => Element;
    notice?: () => Element;
    focusNotice?(): void;
    /** Read-only transcripts still expose their registered attention actions. */
    readOnly?: boolean;
  },
): Element {
  const { takeovers } = useUiRegistries(), session = useSessionPorts();
  const available = () => takeovers.available(session.supports);
  const active = () =>
    available().some((item) => item.active?.(session) ?? true);
  const first = () =>
    available().find((item) => item.active?.(session) ?? true)?.id;
  const hasComposer = () => !props.readOnly;
  return (
    <ComposerProvider available={hasComposer}>
      <Show when={hasComposer() || active()}>
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
            hidden={active() || !hasComposer()}
          >
            <ContentSlot content={!active() ? props.notice : undefined} />
            <div
              class={["otk-composer-body", { "is-noticed": !!props.notice }]}
            >
              {hasComposer() && props.children?.(active)}
            </div>
          </div>
        </div>
      </Show>
    </ComposerProvider>
  );
}
