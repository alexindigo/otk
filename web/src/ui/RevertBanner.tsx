// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { RevertInfo } from "../../../protocol/content.ts";
export default function RevertBanner(props: { revert: RevertInfo }) {
  return (
    <aside class="otk-revert-banner" aria-label="Reverted messages">
      <strong>{props.revert.messageCount} messages reverted</strong>
      <For each={props.revert.files} keyed={false}>
        {(file) => (
          <div>
            {file().path} <span class="otk-diff-add">+{file().additions}</span>
            {" "}
            <span class="otk-diff-del">−{file().deletions}</span>
          </div>
        )}
      </For>
    </aside>
  );
}
