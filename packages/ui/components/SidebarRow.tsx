// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, For, Show } from "solid-js";
import type { ComponentProps } from "@solidjs/web";
import { nativeAttributes } from "./native-attributes.ts";
import { ProjectAvatar } from "./ProjectChip.tsx";
import { selection } from "./selection.ts";
import { MetaRow } from "./MetaRow.tsx";
import { TreeIcon } from "./Tree.tsx";
import { TitleLabel } from "./TitleEditor.tsx";
import "./SidebarRow.css" with { type: "text" };

/** Tree owns disclosure/depth. A row can reserve lamp and artwork tracks or
 * render as a flat label and metadata pair. */
export default function SidebarRow(props: {
  lamp?: Element;
  lampAction?: Omit<ComponentProps<"button">, "children">;
  avatar?: { name: string; color?: string };
  title?: {
    text: string;
    pending?: string;
    qualifiers?: readonly { text: string; title?: string }[];
    emphasis?: boolean;
    struck?: boolean;
  };
  editor?: Element;
  label?: Element;
  meta?: Element;
  control?: Element;
  feedback?: Element;
  compact?: boolean;
  flat?: boolean;
  editing?: boolean;
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
  const lampNative = nativeAttributes(() => props.lampAction ?? {}, ["class"]);
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
        <span
          class="otk-sidebar-slot otk-sidebar-label"
          data-row-title
        >
          <Show
            when={props.title && !props.editor}
            fallback={props.editor ?? props.label}
          >
            <span
              class={["otk-sidebar-title-text", {
                "is-emphasis": !!props.title?.emphasis,
                "is-struck": !!props.title?.struck,
              }]}
              data-unread={props.title?.emphasis === undefined
                ? undefined
                : String(props.title.emphasis)}
            >
              <TitleLabel pending={props.title?.pending}>
                {props.title?.text}
              </TitleLabel>
            </span>
            <For each={props.title?.qualifiers ?? []}>
              {(item) => (
                <span class="otk-sidebar-title-qualifier" title={item.title}>
                  {item.text}
                </span>
              )}
            </For>
          </Show>
        </span>
      </>
    );
  }
  const row = () => (
    <span
      class={["otk-sidebar-row", {
        "is-compact": props.compact,
        "is-flat": props.flat,
      }]}
    >
      <span class="otk-sidebar-row-grid">
        <span class="otk-sidebar-slot otk-sidebar-lamp">
          <TreeIcon extend>
            <Show when={props.lampAction} fallback={props.lamp}>
              <button
                ref={lampNative.ref}
                {...lampNative.attributes}
                type="button"
                class="otk-sidebar-lamp-action"
              >
                {props.lamp}
              </button>
            </Show>
          </TreeIcon>
        </span>
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
        <span class="otk-sidebar-slot otk-sidebar-meta">
          <MetaRow whole intrinsic class="otk-sidebar-meta-track">
            {props.meta}
          </MetaRow>
          <Show when={props.control}>
            <span class="otk-sidebar-control">{props.control}</span>
          </Show>
        </span>
        <Show when={props.feedback}>
          <span class="otk-sidebar-row-feedback">{props.feedback}</span>
        </Show>
      </span>
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
