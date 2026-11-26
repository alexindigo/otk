// SPDX-License-Identifier: LGPL-3.0-only
import {
  createMemo,
  createSignal,
  type Element,
  For,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import type { ComponentProps } from "@solidjs/web";
import { META_SEPARATOR, metaParts, type TimeText as Time } from "@otk/client";
import TimeText from "./TimeText.tsx";
import { TreeNode } from "./Tree.tsx";
import SidebarRow from "./SidebarRow.tsx";
import ContentSlot from "./ContentSlot.tsx";
import { nativeAttributes } from "./native-attributes.ts";
import "./ChromeMeta.css" with { type: "text" };

/** A metadata sentence is one text flow, not spaced flex-item separators. */
export { metaList } from "@otk/client";

/** The same metadata flow, with structured values rendered by their presenter. */
export function MetaText(
  props: { items: readonly (string | Time | undefined | false)[] },
): Element {
  return (
    <For each={metaParts(props.items)}>
      {(item, index) => (
        <>
          {index() ? META_SEPARATOR : ""}
          {typeof item === "string" ? item : <TimeText time={item} />}
        </>
      )}
    </For>
  );
}

export interface MetaControl {
  key: string;
  measure(): Element;
  render(): Element;
}
/** One metadata track. Text yields first; optional controls fit only as wholes. */
export function MetaRow(
  props: {
    children?: Element;
    class?: string;
    controls?: readonly MetaControl[];
  },
): Element {
  let root!: HTMLSpanElement, primary!: HTMLSpanElement;
  const frames = new Map<string, HTMLSpanElement>();
  const [visible, setVisible] = createSignal<readonly string[]>([]);
  let observer: ResizeObserver | undefined;
  const fit = () => {
    if (!primary) return;
    const gap = parseFloat(getComputedStyle(root).columnGap) || 0;
    const minimum = Math.min(
      primary.scrollWidth,
      parseFloat(getComputedStyle(primary).minInlineSize) || 0,
    );
    let available = root.clientWidth - minimum;
    const next: string[] = [];
    for (const control of props.controls ?? []) {
      const width = frames.get(control.key)?.getBoundingClientRect().width ??
        Infinity;
      if (width + gap > available) break;
      available -= width + gap;
      next.push(control.key);
    }
    setVisible((old) => old.join("\0") === next.join("\0") ? old : next);
  };
  const controls = createMemo(() => props.controls ?? []);
  onSettled(() => {
    if (!props.controls) return;
    observer = new ResizeObserver(fit);
    observer.observe(root);
    observer.observe(primary);
    for (const frame of frames.values()) observer.observe(frame);
    let active = true;
    void document.fonts.ready.then(() => {
      if (active) fit();
    });
    fit();
    return () => {
      active = false;
      observer?.disconnect();
    };
  });
  return (
    <span
      ref={(element) => root = element}
      class={["otk-meta-row", props.class, {
        "has-controls": props.controls !== undefined,
      }]}
    >
      <Show when={props.controls} fallback={props.children}>
        <span class="otk-meta-fit">
          <span class="otk-meta-primary" ref={(element) => primary = element}>
            {props.children}
          </span>
          <For each={controls()} keyed={(item) => item.key}>
            {(item) => (
              <span
                class="otk-meta-control"
                hidden={!visible().includes(item().key)}
                inert={!visible().includes(item().key)}
              >
                <ContentSlot content={() => item().render()} />
              </span>
            )}
          </For>
        </span>
        <span class="otk-meta-measure" aria-hidden="true" inert>
          <For each={controls()} keyed={(item) => item.key}>
            {(item) => {
              const key = item().key;
              let frame: HTMLSpanElement;
              onCleanup(() => {
                if (frame) observer?.unobserve(frame);
                frames.delete(key);
              });
              return (
                <span
                  ref={(element) => {
                    frame = element;
                    frames.set(key, element);
                    observer?.observe(element);
                  }}
                >
                  <ContentSlot content={() => item().measure()} />
                </span>
              );
            }}
          </For>
        </span>
      </Show>
    </span>
  );
}

/** Quiet product-owned chrome metadata, shared with the project's visit clock. */
export default function ChromeMeta(
  props: Omit<ComponentProps<"span">, "class"> & {
    class?: string;
    truncate?: boolean;
  },
): Element {
  const native = nativeAttributes(() => props, [
    "class",
    "children",
    "truncate",
  ]);
  return (
    <span
      ref={[props.ref, native.ref]}
      {...native.attributes}
      class={["otk-chrome-meta", props.class, {
        "is-truncated": props.truncate,
      }]}
    >
      {props.children}
    </span>
  );
}

/** Labels and adjacent meta are separate slots, never concatenated copy. */
export function SectionHeaderMeta(
  props: { label: string; count?: number; metaClass?: string },
): Element {
  return (
    <>
      <span class="otk-control-label" title={props.label}>{props.label}</span>
      <Show when={props.count !== undefined}>
        <ChromeMeta class={props.metaClass}>{props.count}</ChromeMeta>
      </Show>
    </>
  );
}

/** Section headers share the tree's disclosure and one label/meta row. */
export function SectionHeader(props: {
  label: string;
  description?: string;
  count?: number;
  open: boolean;
  onOpen(open: boolean): void;
  class?: string;
  headerClass?: string;
  metaClass?: string;
  compact?: boolean;
  sidebar?: boolean;
  path?: readonly boolean[];
  hasChildren?: boolean;
  leading?(): Element;
  attributes?: Record<string, unknown>;
  body?(): Element;
  feedback?(): Element;
}): Element {
  const native = nativeAttributes(() => props.attributes ?? {});
  const description = () =>
    props.description ??
      (props.count === undefined
        ? props.label
        : `${props.label}, ${props.count}`);
  return (
    <TreeNode
      compact={props.compact}
      path={props.path}
      leadingRow={props.sidebar}
      toggleHeader={!props.compact || !!props.leading}
      class={[
        "otk-section-tree",
        props.sidebar ? "otk-sidebar-tree" : "",
        props.class,
      ].filter(Boolean).join(" ")}
      label={description()}
      open={props.open}
      hasChildren={props.hasChildren ?? true}
      showEmptyToggle
      onOpen={props.onOpen}
      feedback={props.feedback}
      body={props.body}
      header={(_connected, toggleID) => (
        <Show when={!props.compact || props.leading}>
          <button
            id={toggleID}
            ref={native.ref}
            {...native.attributes}
            type="button"
            class={["otk-section-header otk-tree-control", props.headerClass]}
            aria-label={description()}
            title={description()}
            aria-expanded={props.open ? "true" : "false"}
            onClick={() =>
              props.onOpen(!props.open)}
          >
            <Show
              when={props.sidebar}
              fallback={
                <>
                  {props.leading?.()}
                  <Show when={!props.compact}>
                    <SectionHeaderMeta
                      label={props.label}
                      count={props.count}
                      metaClass={props.metaClass}
                    />
                    <span class="otk-section-header-rule" aria-hidden="true" />
                  </Show>
                </>
              }
            >
              <SidebarRow
                compact={props.compact}
                lamp={props.leading?.()}
                label={
                  <span class="otk-section-row-label">
                    <SectionHeaderMeta
                      label={props.label}
                      count={props.count}
                      metaClass={props.metaClass}
                    />
                    <span class="otk-section-header-rule" aria-hidden="true" />
                  </span>
                }
              />
            </Show>
          </button>
        </Show>
      )}
    />
  );
}
