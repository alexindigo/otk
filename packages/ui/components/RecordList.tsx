// SPDX-License-Identifier: LGPL-3.0-only
import "./RecordList.css" with { type: "text" };
import { type Element, onCleanup } from "solid-js";
import { ContentWindow, type VirtualListControl } from "./VirtualList.tsx";

/** The record frame owns rhythm and disclosure rails, not virtual neighbours. */
export default function RecordList<T>(props: {
  items: readonly T[];
  key(item: T): string;
  outgoing?: boolean;
  scope: string;
  revision?(item: T): number;
  control?(control: VirtualListControl): (() => void) | void;
  render(item: () => T): Element;
}): Element {
  return (
    <div class={["otk-record-list", { "is-outgoing": props.outgoing }]}>
      <ContentWindow
        items={props.items}
        key={props.key}
        label="Activity records"
        scope={props.scope}
        control={(control) => {
          const release = props.control?.(control);
          if (release) onCleanup(release);
        }}
        measurementKey={props.revision
          ? (item) => `${props.key(item)}:${props.revision!(item)}`
          : undefined}
        render={(item) => (
          <div
            class={["otk-record-list-row", { "is-outgoing": props.outgoing }]}
          >
            <span class="otk-record-list-connector" aria-hidden="true" />
            <div class="otk-record-list-content">{props.render(item)}</div>
          </div>
        )}
      />
    </div>
  );
}
