// SPDX-License-Identifier: LGPL-3.0-only
import "./ComposerTakeovers.css" with { type: "text" };
import { scrollRegion } from "./ScrollRegion.tsx";
import { createMemo, type Element, For, Show } from "solid-js";
import { useUiRegistries } from "../registries/context.tsx";
import { useSessionPorts } from "../registries/session.tsx";
import ContentSlot from "./ContentSlot.tsx";
import { ComposerProvider } from "../registries/composer.tsx";
import { useCommandPorts } from "../keyboard/context.tsx";
import LiveWork from "./LiveWork.tsx";
import { RequestReopen } from "./RequestDismiss.tsx";
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
  const { commands } = useCommandPorts();
  const work = createMemo(() => session.runningWork?.() ?? []);
  const fail = (error: unknown) => session.feedback?.fail(error);
  const available = () => takeovers.available(session.supports);
  const active = () =>
    available().some((item) => item.active?.(session) ?? true);
  const first = () =>
    available().find((item) => item.active?.(session) ?? true)?.id;
  const hasComposer = () => !props.readOnly;
  return (
    <ComposerProvider available={hasComposer}>
      <Show when={hasComposer() || active() || work().length}>
        <div
          class="otk-composer-dock"
          data-read-only={props.readOnly ? "true" : "false"}
        >
          <div class="otk-composer-activity-slot">
            <Show when={work().length}>
              <div class="otk-composer-activity">
                <LiveWork
                  items={work()}
                  owner={session.liveWork}
                  onOpen={(id) =>
                    void commands.run("session.child", id).catch(fail)}
                  onError={fail}
                />
              </div>
            </Show>
          </div>
          <div
            class={[scrollRegion(), "otk-composer-notice-layer"]}
            hidden={!hasComposer() || active()}
          >
            <ContentSlot content={!active() ? props.notice : undefined} />
          </div>
          <div class="otk-composer-frame" hidden={!hasComposer()}>
            <div
              class={[scrollRegion(), "otk-composer", {
                "is-suspended": active(),
              }]}
              data-takeover={active() ? "true" : "false"}
              inert={active()}
              hidden={!hasComposer()}
            >
              <div class="otk-composer-body">
                {hasComposer() && props.children?.(active)}
              </div>
            </div>
          </div>
          <div class="otk-composer-takeover-layer">
            <RequestReopen />
            <For each={available()} keyed={(item) => item.id}>
              {(item) =>
                item().component({
                  get notice() {
                    return item().id === first() ? props.notice : undefined;
                  },
                  focusNotice: () => props.focusNotice?.(),
                })}
            </For>
          </div>
        </div>
      </Show>
    </ComposerProvider>
  );
}
