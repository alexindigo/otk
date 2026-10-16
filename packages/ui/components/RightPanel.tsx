// SPDX-License-Identifier: LGPL-3.0-only
import "./RightPanel.css" with { type: "text" };
import { createMemo, createSignal, For, Show } from "solid-js";
import type { CapabilityName, Preferences } from "@otk/protocol";
import { useUiRegistries } from "../registries/context.tsx";

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
  const [dragWidth, setDragWidth] = createSignal<number>();
  const [error, setError] = createSignal("");
  const width = () => dragWidth() ?? props.layout.rightWidth ?? 320;
  const save = async (patch: Partial<Preferences["shellLayout"]>) => {
    try {
      await props.onLayout(patch);
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  };
  return (
    <aside
      class="otk-right-panel"
      aria-label="Right panel"
      hidden={props.layout.rightCollapsed}
      style={{ width: `${width()}px` }}
    >
      <div
        class="otk-panel-icons"
        role="tablist"
        aria-label="Right panel views"
      >
        <For each={views()} keyed={(v) => v.id}>
          {(view) => (
            <button
              type="button"
              role="tab"
              title={view().title}
              aria-label={view().title}
              aria-selected={active()?.id === view().id ? "true" : "false"}
              aria-controls="otk-panel-content"
              disabled={!props.ready}
              data-panel-view={view().id}
              onClick={() => void save({ rightView: view().id })}
            >
              <span aria-hidden="true">{view().icon}</span>
            </button>
          )}
        </For>
        <button
          type="button"
          class="otk-panel-collapse"
          aria-label="Collapse right panel"
          disabled={!props.ready}
          onClick={() => void save({ rightCollapsed: true })}
        >
          ›
        </button>
      </div>
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
        aria-valuemin={280}
        aria-valuemax={480}
        aria-valuenow={width()}
        onKeyDown={(event) => {
          if (
            !props.ready ||
            !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
          ) return;
          event.preventDefault();
          const next = event.key === "Home"
            ? 280
            : event.key === "End"
            ? 480
            : Math.max(
              280,
              Math.min(480, width() + (event.key === "ArrowLeft" ? 8 : -8)),
            );
          void save({ rightWidth: next });
        }}
        onPointerDown={(event) => {
          if (!props.ready) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragWidth(width());
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const right =
            event.currentTarget.parentElement!.getBoundingClientRect().right;
          setDragWidth(Math.max(280, Math.min(480, right - event.clientX)));
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          void save({ rightWidth: width() }).finally(() =>
            setDragWidth(undefined)
          );
        }}
        onPointerCancel={() => setDragWidth(undefined)}
      />
    </aside>
  );
}
