// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, For, Show } from "solid-js";
import type { ComponentProps } from "@solidjs/web";
import { META_SEPARATOR, metaParts, type TimeText as Time } from "@otk/client";
import TimeText from "./TimeText.tsx";
import { TreeNode } from "./Tree.tsx";
import SidebarRow from "./SidebarRow.tsx";
import { MetaItem } from "./MetaRow.tsx";
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

export { type MetaControl, MetaItem, MetaRow } from "./MetaRow.tsx";

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
function SectionHeaderLabel(props: { label: string }): Element {
  return (
    <span class="otk-control-label" title={props.label}>{props.label}</span>
  );
}

export function SectionHeaderMeta(
  props: { label: string; count?: number; metaClass?: string },
): Element {
  return (
    <>
      <SectionHeaderLabel label={props.label} />
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
      selected={props.sidebar ? false : undefined}
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
                    <SectionHeaderLabel label={props.label} />
                    <span class="otk-section-header-rule" aria-hidden="true" />
                  </span>
                }
                meta={
                  <Show when={props.count !== undefined}>
                    <MetaItem rank={1}>
                      <ChromeMeta class={props.metaClass}>
                        {props.count}
                      </ChromeMeta>
                    </MetaItem>
                  </Show>
                }
              />
            </Show>
          </button>
        </Show>
      )}
    />
  );
}
