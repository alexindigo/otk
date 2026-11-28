// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { SidebarTiming } from "@otk/client";
import ChromeMeta, { MetaItem } from "./ChromeMeta.tsx";
import TimeText from "./TimeText.tsx";

/** Render the supplied timer as a single yielding fact, regardless of kind. */
export default function SidebarTimer(
  props: { value?: SidebarTiming; class?: string },
) {
  return (
    <Show when={props.value}>
      {(timer) => (
        <MetaItem rank={2}>
          <ChromeMeta
            class={props.class}
            title={timer().kind === "run"
              ? "Current run duration"
              : "Time since last visit"}
          >
            <TimeText time={timer().time} tone={timer().tone} />
          </ChromeMeta>
        </MetaItem>
      )}
    </Show>
  );
}
