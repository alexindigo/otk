// SPDX-License-Identifier: LGPL-3.0-only
import "./ListRow.css" with { type: "text" };
import type { Element } from "solid-js";
import { dynamic } from "@solidjs/web";
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";

/** One list-row frame; consumers inject content and actions. */
export default function ListRow(props: {
  as?: "button" | "div";
  selected: boolean;
  editing?: boolean;
  class?: string;
  labelClass?: string;
  labelTitle?: string;
  actionClass?: string;
  activate?(): void;
  leading?: Element;
  trailing?: Element;
  attributes?: Record<string, unknown>;
  ref?: ((element: HTMLElement) => void) | ((element: HTMLElement) => void)[];
  children: Element;
}): Element {
  const Control = dynamic(() => props.editing ? "div" : props.as ?? "button");
  const Label = dynamic(() => props.activate ? "button" : "span");
  return (
    <Control
      {...props.attributes}
      type={props.editing || props.as === "div" ? undefined : "button"}
      ref={(element: HTMLElement) => {
        const refs = props.ref
          ? Array.isArray(props.ref) ? props.ref : [props.ref]
          : [];
        for (const ref of refs) ref(element);
      }}
      {...selection({
        selected: props.selected,
        kind: "current",
        class: `otk-list-row ${props.class ?? ""}${
          props.editing ? " is-editing" : ""
        }`,
      })}
      data-otk-selection="vertical"
    >
      <SelectionContent class="otk-list-row-content">
        <span class="otk-list-row-leading">{props.leading}</span>
        <Label
          type={props.activate ? "button" : undefined}
          class={`otk-list-row-label otk-control-label otk-control-grow ${
            props.labelClass ?? ""
          }${
            props.activate
              ? ` otk-list-row-action ${props.actionClass ?? ""}`
              : ""
          }`}
          title={props.labelTitle}
          onClick={props.activate}
        >
          {props.children}
        </Label>
        <span class="otk-list-row-trailing">{props.trailing}</span>
      </SelectionContent>
    </Control>
  );
}
