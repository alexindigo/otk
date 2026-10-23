// SPDX-License-Identifier: LGPL-3.0-only
import ChangeCounts from "./ChangeCounts.tsx";
import "./RevertBanner.css" with { type: "text" };
import { For } from "solid-js";
import type { RevertInfo } from "@otk/protocol";
import { countLabel } from "./tools/count.ts";
export default function RevertBanner(props: { revert: RevertInfo }) {
  return (
    <aside class="otk-revert-banner" aria-label="Reverted messages">
      <strong>
        {countLabel(props.revert.messageCount, "message")} reverted
      </strong>
      <For each={props.revert.files} keyed={false}>
        {(file) => (
          <div>
            <span class="otk-path">{file().path}</span>{" "}
            <ChangeCounts
              additions={file().additions}
              deletions={file().deletions}
            />
          </div>
        )}
      </For>
    </aside>
  );
}
