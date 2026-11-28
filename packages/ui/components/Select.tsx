// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, Show } from "solid-js";
import ListPicker from "./ListPicker.tsx";
import "./Select.css" with { type: "text" };

export interface SelectProps {
  label: string;
  name?: string;
  value?: string;
  options: readonly { value: string; label: string; unavailable?: string }[];
  onValue(value: string): void;
  readonly?: boolean;
  containerClass?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: "true";
}

/** Select's value participates in native forms; its UI belongs to ListPicker. */
export default function Select(props: SelectProps): Element {
  const value = () => props.value ?? props.options[0]?.value ?? "";
  const label = () =>
    props.options.find((item) => item.value === value())?.label ?? value();
  return (
    <span class={["otk-select", props.containerClass]}>
      <input type="hidden" name={props.name} value={value()} />
      <Show
        when={!props.readonly}
        fallback={
          <input
            class="otk-select-value"
            readonly
            value={label()}
            aria-label={props.label}
            aria-describedby={props["aria-describedby"]}
          />
        }
      >
        <ListPicker
          label={props.label}
          triggerLabel={`${props.label}: ${label()}`}
          trigger={label()}
          triggerClass="otk-select-trigger"
          triggerAttributes={{
            "aria-describedby": props["aria-describedby"],
            "aria-invalid": props["aria-invalid"],
            name: props.name,
          }}
          selected={value()}
          groups={[{
            key: "options",
            items: props.options.map((item) => ({ ...item, key: item.value })),
          }]}
          onPick={props.onValue}
        />
      </Show>
    </span>
  );
}
