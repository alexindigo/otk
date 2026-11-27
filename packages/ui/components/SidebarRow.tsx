// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, Show } from "solid-js";
import type { ComponentProps } from "@solidjs/web";
import { nativeAttributes } from "./native-attributes.ts";
import { ProjectAvatar } from "./ProjectChip.tsx";
import { selection } from "./selection.ts";
import { MetaRow } from "./MetaRow.tsx";
import "./SidebarRow.css" with { type: "text" };

/** Tree owns disclosure/depth. A row can reserve lamp and artwork tracks or
 * render as a flat label and metadata pair. */
export default function SidebarRow(props: {
  lamp?: Element;
  avatar?: { name: string; color?: string };
  label?: Element;
  meta?: Element;
  metaClass?: string;
  metaControl?: Element;
  feedback?: Element;
  compact?: boolean;
  flat?: boolean;
  editing?: boolean;
  detailedMeta?: boolean;
  mainRef?(element: HTMLButtonElement): void;
  action?: Omit<ComponentProps<"button">, "children">;
  frame?: {
    selected: boolean;
    class: string;
    ref?: (el: HTMLElement) => void;
    attributes?: Record<string, unknown>;
  };
}): Element {
  const native = nativeAttributes(() => props.action ?? {});
  const frameNative = nativeAttributes(() => props.frame?.attributes ?? {});
  function Main() {
    return (
      <>
        <span class="otk-sidebar-slot otk-sidebar-icon">
          <Show when={props.avatar}>
            {(avatar) => (
              <ProjectAvatar
                size="compact"
                name={avatar().name}
                color={avatar().color}
              />
            )}
          </Show>
        </span>
        <span class="otk-sidebar-slot otk-sidebar-label" data-row-title>
          {props.label}
        </span>
      </>
    );
  }
  const row = () => (
    <span
      class={["otk-sidebar-row", {
        "is-compact": props.compact,
        "is-flat": props.flat,
        "has-detailed-meta": props.detailedMeta,
      }]}
    >
      <span class="otk-sidebar-row-grid">
        <span class="otk-sidebar-slot otk-sidebar-lamp">{props.lamp}</span>
        <Show
          when={props.action && !props.editing}
          fallback={
            <span class="otk-sidebar-row-main">
              <Main />
            </span>
          }
        >
          <button
            ref={(element) => {
              native.ref(element);
              props.mainRef?.(element);
            }}
            {...native.attributes}
            type="button"
            class={["otk-sidebar-row-main", props.action?.class]}
          >
            <Main />
          </button>
        </Show>
        <span class={["otk-sidebar-slot otk-sidebar-meta", props.metaClass]}>
          <MetaRow whole intrinsic>{props.meta}</MetaRow>
          {props.metaControl}
        </span>
      </span>
      <Show when={props.feedback}>
        <span class="otk-sidebar-row-feedback">{props.feedback}</span>
      </Show>
    </span>
  );
  return (
    <Show when={props.frame} fallback={row()}>
      {(frame) => (
        <div
          ref={(el) => {
            frameNative.ref(el);
            frame().ref?.(el);
          }}
          {...selection({
            class: `otk-sidebar-frame ${frame().class}`,
            kind: "current",
            selected: frame().selected,
          })}
          data-otk-selection="vertical"
          data-otk-selection-mark="external"
          {...frameNative.attributes}
        >
          {row()}
        </div>
      )}
    </Show>
  );
}
