// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, Show } from "solid-js";
import type { ComponentProps } from "@solidjs/web";
import { TreeNode } from "./Tree.tsx";
import { nativeAttributes } from "./native-attributes.ts";
import "./ChromeMeta.css" with { type: "text" };

/** A metadata sentence is one text flow, not spaced flex-item separators. */
export { metaList } from "@otk/client";

/** Quiet product-owned chrome metadata, shared with the project's visit clock. */
export default function ChromeMeta(
  props: Omit<ComponentProps<"span">, "class"> & { class?: string },
): Element {
  const native = nativeAttributes(() => props, ["class", "children"]);
  return (
    <span
      ref={[props.ref, native.ref]}
      {...native.attributes}
      class={["otk-chrome-meta", props.class]}
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
      toggleHeader={!props.compact || !!props.leading}
      class={["otk-section-tree", props.class].filter(Boolean).join(" ")}
      label={description()}
      open={props.open}
      hasChildren
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
            {props.leading?.()}
            <Show when={!props.compact}>
              <SectionHeaderMeta
                label={props.label}
                count={props.count}
                metaClass={props.metaClass}
              />
              <span class="otk-section-header-rule" aria-hidden="true" />
            </Show>
          </button>
        </Show>
      )}
    />
  );
}
