// SPDX-License-Identifier: LGPL-3.0-only
import "./LiveCount.css" with { type: "text" };
import { lamp } from "@otk/client";
import type { EntityLamp } from "@otk/protocol";
import { For, Show } from "solid-js";
import StatusLight from "./StatusLight.tsx";
import ChromeMeta from "./ChromeMeta.tsx";

export const LIVE_COUNT_TRIGGER = "otk-live-count-trigger";

/** Layout shared by the composer's work pills. */
export default function LiveCount(props: {
  lamp?: EntityLamp;
  label?: string;
  compact: readonly {
    id: string;
    count: number;
    lamp?: EntityLamp;
  }[];
}) {
  return (
    <>
      <Show when={props.label}>
        <span class="otk-live-count is-full">
          <StatusLight small state={lamp(props.lamp)} />
          <ChromeMeta class="otk-control-label">{props.label}</ChromeMeta>
        </span>
      </Show>
      <span
        class={props.label
          ? "otk-live-count-compact"
          : "otk-live-count-compact is-only"}
        aria-hidden="true"
      >
        <For each={props.compact} keyed={(item) => item.id}>
          {(item) => (
            <span class="otk-live-count">
              <StatusLight
                small
                state={lamp(item().lamp)}
              />
              <ChromeMeta class="otk-control-label">{item().count}</ChromeMeta>
            </span>
          )}
        </For>
      </span>
    </>
  );
}
