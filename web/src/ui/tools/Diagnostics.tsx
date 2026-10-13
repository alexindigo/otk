// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { Diagnostic } from "@otk/protocol";
export default function Diagnostics(props: { items: Diagnostic[] }) {
  return (
    <ul class="otk-diagnostics">
      <For each={props.items} keyed={false}>
        {(item) => (
          <li data-severity={item().severity}>
            {item().severity} [{item().line}:{item().col}] {item().message}
          </li>
        )}
      </For>
    </ul>
  );
}
