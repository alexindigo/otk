// SPDX-License-Identifier: LGPL-3.0-only
import "./RightPanel.css" with { type: "text" };
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
import { createMemo, createSignal, For, Show } from "solid-js";
import {
  type CapabilityName,
  type Preferences,
  SHELL_WIDTHS,
} from "@otk/protocol";
import { useUiRegistries } from "../registries/context.tsx";
import { createResize } from "./resize.ts";
import SidebarRail from "./SidebarRail.tsx";
import { contextTarget } from "./context-target.ts";

/** A feature-agnostic host. Registrations own their content and read public
 * context ports; the panel owns only layout and view selection. */
export default function RightPanel(props: {
  layout: Preferences["shellLayout"];
  ready: boolean;
  supports(capability: CapabilityName): boolean;
  onLayout(patch: Partial<Preferences["shellLayout"]>): Promise<void>;
}): import("solid-js").Element {
  const registry = useUiRegistries().panels;
  const views = createMemo(() => registry.available(props.supports));
  const active = createMemo(() =>
    views().find((v) => v.id === props.layout.rightView) ?? views()[0]
  );
  const [error, setError] = createSignal("");
  const bounds = SHELL_WIDTHS.right;
  const resize = createResize({
    width: () => props.layout.rightWidth ?? bounds.default,
    ready: () => props.ready && !props.layout.rightCollapsed,
    direction: -1,
    bounds,
    save: async (rightWidth) => {
      await props.onLayout({ rightWidth });
      setError("");
    },
    fail: (error) =>
      setError(error instanceof Error ? error.message : String(error)),
  });
  const width = resize.width;
  const save = async (patch: Partial<Preferences["shellLayout"]>) => {
    try {
      await props.onLayout(patch);
      setError("");
    } catch (error) {
      setError((error as Error).message);
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
        <For each={views()} keyed={(v) => v.id}>
          {(view) => (
            <button
              type="button"
              {...selection({
                class: "otk-icon-button",
                kind: "selected",
                selected: active()?.id === view().id,
              })}
              data-otk-selection={input.rail ? "vertical" : "horizontal"}
              role="tab"
              title={view().title}
              aria-label={view().title}
              aria-controls="otk-panel-content"
              disabled={!props.ready}
              data-panel-view={view().id}
              onClick={() =>
                void save({ rightView: view().id, rightCollapsed: false })}
            >
              <SelectionContent
                class={input.rail ? "otk-panel-rail-selection" : undefined}
              >
                <span class="otk-panel-view-icon" aria-hidden="true">
                  {(() => {
                    const icon = view().icon;
                    return typeof icon === "function" ? icon() : icon;
                  })()}
                </span>
              </SelectionContent>
            </button>
          )}
        </For>
      </div>
    );
  }
  return (
    <>
      <Show when={props.layout.rightCollapsed}>
        <SidebarRail
          ref={contextTarget(() => ({
            kind: "panel",
            area: true,
            data: undefined,
          }))}
          label="Right panel rail"
          class="otk-right-rail"
          side="right"
          collapsed
        >
          <Views rail />
          <Show when={error()}>
            <p role="alert" class="otk-error">{error()}</p>
          </Show>
        </SidebarRail>
      </Show>
      <aside
        ref={contextTarget(() => ({
          kind: "panel",
          area: true,
          data: undefined,
        }))}
        class="otk-right-panel"
        aria-label="Right panel"
        hidden={props.layout.rightCollapsed}
        style={{ width: `${width()}px` }}
      >
        <Views rail={false} />
        <Show when={error()}>
          <p role="alert" class="otk-error">{error()}</p>
        </Show>
        <Show
          when={active()}
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
        <div
          class="otk-panel-resizer"
          role="separator"
          aria-label="Right panel width"
          aria-orientation="vertical"
          tabindex={props.ready ? 0 : -1}
          aria-valuemin={bounds.min}
          aria-valuemax={bounds.max}
          aria-valuenow={width()}
          {...resize.handlers}
        />
      </aside>
    </>
  );
}
