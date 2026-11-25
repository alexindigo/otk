// SPDX-License-Identifier: LGPL-3.0-only
import "./RecordList.css" with { type: "text" };
import { type Element, onCleanup } from "solid-js";
import ContentSlot from "./ContentSlot.tsx";
import { ContentWindow, type VirtualListControl } from "./VirtualList.tsx";
import { TreeItem } from "./Tree.tsx";

/** The record frame owns rhythm and supplies topology, never virtual neighbours. */
export default function RecordList<T>(props: {
  items: readonly T[];
  key(item: T): string;
  outgoing?: boolean;
  outgoingItem?(item: T): boolean;
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
          <TreeItem
            last={props.items.length > 0 &&
              props.key(item()) === props.key(props.items.at(-1)!)}
            outgoing={props.outgoing}
            connected={!props.outgoingItem ||
              props.outgoingItem(item()) === !!props.outgoing}
          >
            <ContentSlot content={() => props.render(item)} />
          </TreeItem>
        )}
      />
    </div>
  );
}
