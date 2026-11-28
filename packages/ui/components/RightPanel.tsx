// SPDX-License-Identifier: LGPL-3.0-only
import { errorFeedback, type FailureValue, failureValue } from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";
import "./RightPanel.css" with { type: "text" };
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
import { ControlIcon } from "./ControlValue.tsx";
import { createMemo, createSignal, type Element, For, Show } from "solid-js";
import {
  type CapabilityName,
  type Preferences,
  SHELL_WIDTHS,
} from "@otk/protocol";
import { useUiRegistries } from "../registries/context.tsx";
import { createResize } from "./resize.ts";
import { nativeAttributes } from "./native-attributes.ts";
import SidebarRail from "./SidebarRail.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
import { contextTarget } from "./context-target.ts";
import type { PanelPresentation } from "../state/panel-presentation.ts";

/** A feature-agnostic host. Registrations own their content and read public
 * context ports; the panel owns only layout and view selection. */
export default function RightPanel(props: {
  layout: Preferences["shellLayout"];
  presentation?: PanelPresentation;
  collapseToggle?: Element;
  ready: boolean;
  supports(capability: CapabilityName): boolean;
  onLayout(patch: Partial<Preferences["shellLayout"]>): Promise<void>;
}): import("solid-js").Element {
  const registry = useUiRegistries().panels;
  const views = createMemo(() => registry.available(props.supports));
  const active = createMemo(() =>
    views().find((v) => v.id === props.layout.rightView) ?? views()[0]
  );
  const [error, setError] = createSignal<FailureValue>("");
  const bounds = SHELL_WIDTHS.right;
  const collapsed = () => props.layout.rightCollapsed;
  const sheet = () => props.presentation === "sheet";
  const resize = createResize({
    width: () => props.layout.rightWidth ?? bounds.default,
    ready: () => props.ready && !collapsed() && !sheet(),
    direction: -1,
    bounds,
    save: async (rightWidth) => {
      await props.onLayout({ rightWidth });
      setError("");
    },
    fail: (error) =>
      setError(failureValue(error, { actionLabel: "Saving panel layout" })),
  });
  const width = resize.width;
  const native = nativeAttributes(() => resize.handlers);
  const save = async (patch: Partial<Preferences["shellLayout"]>) => {
    try {
      await props.onLayout(patch);
      setError("");
    } catch (error) {
      setError(failureValue(error, { actionLabel: "Saving panel layout" }));
    }
  };
  function Views(input: { rail: boolean }) {
    return (
      <div
        class={input.rail ? "otk-panel-rail-icons" : "otk-panel-icons"}
        role="tablist"
        aria-label="Right panel views"
        aria-orientation={input.rail ? "vertical" : "horizontal"}
      >
        <For each={props.ready ? views() : []} keyed={(v) => v.id}>
          {(view) => (
            <button
              type="button"
              {...selection({
                class: "otk-icon-button" +
                  (input.rail ? " otk-panel-rail-button" : ""),
                kind: "selected",
                selected: active()?.id === view().id,
              })}
              data-otk-selection={input.rail ? "vertical" : "horizontal"}
              role="tab"
              title={view().title}
              aria-label={view().title}
              aria-controls="otk-panel-content"
              data-panel-view={view().id}
              onClick={() =>
                void save({ rightView: view().id, rightCollapsed: false })}
            >
              <SelectionContent class="otk-control-icon-selection">
                <ControlIcon>
                  <span class="otk-panel-view-icon" aria-hidden="true">
                    {view().icon()}
                  </span>
                </ControlIcon>
              </SelectionContent>
            </button>
          )}
        </For>
      </div>
    );
  }
  return (
    <SidebarRail
      ref={contextTarget(() => ({
        kind: "panel",
        area: true,
        data: undefined,
      }))}
      label={collapsed() ? "Right panel rail" : "Right panel"}
      class={collapsed() ? "otk-right-rail" : "otk-right-panel"}
      side="right"
      collapsed={collapsed()}
      width={sheet() ? undefined : width()}
      header={
        <div
          class={[
            "otk-panel-header",
            { "is-collapsed": collapsed(), "is-sheet": sheet() },
          ]}
        >
          <Show when={sheet()}>{props.collapseToggle}</Show>
          <Show when={!collapsed()}>
            <Views rail={false} />
          </Show>
          <Show when={!sheet()}>{props.collapseToggle}</Show>
        </div>
      }
      body={
        <Show
          when={!collapsed()}
          fallback={
            <ScrollRegion class="otk-panel-rail-body">
              <Views rail />
              <Show when={error()}>
                <FeedbackStatus feedback={errorFeedback(error())} />
              </Show>
            </ScrollRegion>
          }
        >
          <div class="otk-panel-body">
            <Show when={error()}>
              <FeedbackStatus feedback={errorFeedback(error())} />
            </Show>
            <Show
              when={!props.layout.rightCollapsed && active()}
              keyed
              fallback={<p class="otk-muted">No available views.</p>}
            >
              {(view) => (
                <section
                  id="otk-panel-content"
                  class="otk-panel-content"
                  role="tabpanel"
                  aria-label={view.title}
                >
                  <h2>{view.title}</h2>
                  <view.component />
                </section>
              )}
            </Show>
          </div>
        </Show>
      }
      resizer={
        <Show when={!collapsed() && !sheet()}>
          <div
            class="otk-panel-resizer"
            ref={native.ref}
            role="separator"
            aria-label="Right panel width"
            aria-orientation="vertical"
            tabindex={props.ready ? 0 : -1}
            aria-valuemin={bounds.min}
            aria-valuemax={bounds.max}
            aria-valuenow={width()}
            {...native.attributes}
          />
        </Show>
      }
    />
  );
}
