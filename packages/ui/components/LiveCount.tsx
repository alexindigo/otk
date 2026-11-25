// SPDX-License-Identifier: LGPL-3.0-only
import "./LiveCount.css" with { type: "text" };
import { type EntityStateStore, lamp } from "@otk/client";
import { For } from "solid-js";
import StatusLight from "./StatusLight.tsx";
import ChromeMeta from "./ChromeMeta.tsx";

/** Layout shared by the composer's work pills. */
export default function LiveCount(props: {
  entities?: EntityStateStore;
  lampKey?: string;
  label: string;
  compact: readonly { id: string; count: number; lampKey?: string }[];
}) {
  return (
    <>
      <span class="otk-live-count is-full">
        <StatusLight small state={lamp(props.entities, props.lampKey)} />
        <ChromeMeta class="otk-control-label">{props.label}</ChromeMeta>
      </span>
      <span class="otk-live-count-compact" aria-hidden="true">
        <For each={props.compact} keyed={(item) => item.id}>
          {(item) => (
            <span class="otk-live-count">
              <StatusLight
                small
                state={lamp(props.entities, item().lampKey ?? props.lampKey)}
              />
              <ChromeMeta class="otk-control-label">{item().count}</ChromeMeta>
            </span>
          )}
        </For>
      </span>
    </>
  );
}
