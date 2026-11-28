// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, For, Show } from "solid-js";
import type { ComponentProps } from "@solidjs/web";
import { nativeAttributes } from "./native-attributes.ts";
import { ProjectAvatar } from "./ProjectChip.tsx";
import { selection } from "./selection.ts";
import { MetaRow } from "./MetaRow.tsx";
import { TitleLabel } from "./TitleEditor.tsx";
import "./SidebarRow.css" with { type: "text" };

type Frame = {
  selected: boolean;
  class: string;
  ref?: (el: HTMLElement) => void;
  attributes?: Record<string, unknown>;
};

/** The selection surface borrows its layout from Tree, or flows in Timeline. */
export function SidebarFrame(
  props: { frame: Frame; children: Element },
): Element {
  const native = nativeAttributes(() => props.frame.attributes ?? {});
  return (
    <div
      ref={(element) => {
        native.ref(element);
        props.frame.ref?.(element);
      }}
      {...selection({
        class: `otk-sidebar-frame ${props.frame.class}`,
        kind: "current",
        selected: props.frame.selected,
      })}
      data-otk-selection="vertical"
      data-otk-selection-mark="external"
      {...native.attributes}
    >
      {props.children}
    </div>
  );
}

export function SidebarFeedback(props: { children: Element }): Element {
  return <div class="otk-sidebar-row-feedback">{props.children}</div>;
}

export function SidebarLampAction(props: {
  label: string;
  title: string;
  onClick(): void;
  children: Element;
}): Element {
  return (
    <button
      type="button"
      class="otk-sidebar-lamp-action"
      aria-label={props.label}
      title={props.title}
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}

/** Tree owns disclosure, depth and the lamp. SidebarRow owns row content. */
export default function SidebarRow(props: {
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
  flat?: boolean;
  editing?: boolean;
  mainRef?(element: HTMLButtonElement): void;
  action?: Omit<ComponentProps<"button">, "children">;
  frame?: Frame;
}): Element {
  const native = nativeAttributes(() => props.action ?? {});
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
    <span class={["otk-sidebar-row", { "is-flat": props.flat }]}>
      <span class="otk-sidebar-row-grid">
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
      </span>
    </span>
  );
  return (
    <Show when={props.frame} fallback={row()}>
      {(frame) => <SidebarFrame frame={frame()}>{row()}</SidebarFrame>}
    </Show>
  );
}
