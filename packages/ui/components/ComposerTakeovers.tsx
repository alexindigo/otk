// SPDX-License-Identifier: LGPL-3.0-only
import { composerLinkState } from "@otk/client";
import "./ComposerTakeovers.css" with { type: "text" };
import ScrollRegion from "./ScrollRegion.tsx";
import { createMemo, type Element, For, Show } from "solid-js";
import { useUiRegistries } from "../registries/context.tsx";
import { useSessionPorts } from "../registries/session.tsx";
import ContentSlot from "./ContentSlot.tsx";
import { ComposerProvider } from "../registries/composer.tsx";
import { useCommandPorts } from "../keyboard/context.tsx";
import LiveWork from "./LiveWork.tsx";
import LiveLink from "./LiveLink.tsx";
import Subagents from "./Subagents.tsx";
import { sessionSelectionControl } from "./session-open.ts";
import ChromeMeta from "./ChromeMeta.tsx";
import { ChevronIcon } from "./ChromeIcons.tsx";
import { RequestReopen } from "./RequestDismiss.tsx";
import { POPOVER_BOUNDS } from "./surface/Popover.tsx";
export default function ComposerTakeovers(
  props: {
    children?: (active: () => boolean) => Element;
    notice?: () => Element;
    focusNotice?(): void;
    /** Read-only transcripts still expose their registered attention actions. */
    readOnly?: boolean;
  },
): Element {
  const { takeovers, composerDocks } = useUiRegistries(),
    session = useSessionPorts();
  const { commands } = useCommandPorts();
  const shells = createMemo(() =>
    (session.workItems?.() ?? []).filter((item) => item.kind === "shell")
  );
  const title = (id: string) =>
    session.entry(id)?.title ?? "Session unavailable";
  const trail = () => session.trail?.();
  const entities = () => session.entities?.();
  const task = createMemo(() => {
    const store = entities(), key = trail()?.task;
    return key && !store?.isStale ? store?.get(key) : undefined;
  });
  const link = createMemo(() => composerLinkState(task(), shells().length));
  const available = () => takeovers.available(session.supports);
  const active = () =>
    available().some((item) => item.active?.(session) ?? true);
  const first = () =>
    available().find((item) => item.active?.(session) ?? true)?.id;
  const hasComposer = () => !props.readOnly;
  const target = () =>
    session.composerTarget?.() ??
      {
        session: session.entry(session.sessionID())?.title ??
          session.sessionID(),
      };
  return (
    <ComposerProvider available={hasComposer}>
      <Show
        when={hasComposer() || active() || link() !== "none"}
      >
        <div
          class="otk-composer-dock"
          data-read-only={props.readOnly ? "true" : "false"}
        >
          <div class="otk-composer-activity-slot">
            <div class="otk-composer-activity" aria-label="Message destination">
              <div class={`otk-composer-activity-line ${POPOVER_BOUNDS}`}>
                <span
                  class="otk-composer-target"
                  title={[target().task, target().session].filter(Boolean).join(
                    ": ",
                  )}
                >
                  <Show when={target().task}>
                    {(task) => (
                      <>
                        <ChromeMeta class="otk-composer-task otk-control-label">
                          {task()}
                        </ChromeMeta>
                        <ChevronIcon class="otk-composer-chevron" />
                      </>
                    )}
                  </Show>
                  <ChromeMeta class="otk-composer-destination otk-control-label">
                    {target().session}
                  </ChromeMeta>
                </span>
                <LiveLink state={link()} />
                <span class="otk-composer-live-slot">
                  <Subagents
                    helpers={task()?.helpers}
                    taskKey={trail()?.task}
                    current={session.sessionID()}
                    entities={entities()}
                    owner={session.liveWork}
                    title={title}
                    agent={(id) => session.entry(id)?.agent}
                    openAction={(id) =>
                      sessionSelectionControl(commands, {
                        sidecarId: session.failureTarget?.().sidecarId ?? "",
                        sessionID: id,
                      }, title(id))}
                  />
                  <LiveWork shells={shells()} />
                </span>
              </div>
            </div>
          </div>
          <ScrollRegion
            frameClass="otk-composer-feedback"
            hidden={!hasComposer() || active() || !props.notice}
          >
            <ContentSlot content={!active() ? props.notice : undefined} />
          </ScrollRegion>
          <Show when={hasComposer()}>
            <For
              each={composerDocks.available(session.supports)}
              keyed={(item) => item.id}
            >
              {(item) => item().component()}
            </For>
          </Show>
          <div class="otk-composer-frame" hidden={!hasComposer()}>
            <ScrollRegion
              class={["otk-composer", {
                "is-suspended": active(),
              }]}
              data-takeover={active() ? "true" : "false"}
              inert={active()}
              hidden={!hasComposer()}
            >
              <div class="otk-composer-body">
                {hasComposer() && props.children?.(active)}
              </div>
            </ScrollRegion>
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
