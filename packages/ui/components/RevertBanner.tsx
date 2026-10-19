// SPDX-License-Identifier: LGPL-3.0-only
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
            <span class="otk-diff-add">+{file().additions}</span>{" "}
            <span class="otk-diff-del">−{file().deletions}</span>
          </div>
        )}
      </For>
    </aside>
  );
}
