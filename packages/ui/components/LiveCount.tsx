// SPDX-License-Identifier: LGPL-3.0-only
import "./LiveCount.css" with { type: "text" };
import { lamp } from "@otk/client";
import type { EntityLamp } from "@otk/protocol";
import { type Element, For } from "solid-js";
import StatusLight from "./StatusLight.tsx";
import ChromeMeta from "./ChromeMeta.tsx";

export const LIVE_COUNT_TRIGGER = "otk-live-count-trigger";

/** Layout shared by the composer's work pills. */
export default function LiveCount(props: {
  icon: () => Element;
  parts: readonly {
    id: string;
    count: number;
    lamp?: EntityLamp;
  }[];
}) {
  return (
    <span class="otk-live-count-compact" aria-hidden="true">
      <props.icon />
      <For each={props.parts} keyed={(item) => item.id}>
        {(item) => (
          <span class="otk-live-count">
            <StatusLight small state={lamp(item().lamp)} />
            <ChromeMeta class="otk-control-label">{item().count}</ChromeMeta>
          </span>
        )}
      </For>
    </span>
  );
}
