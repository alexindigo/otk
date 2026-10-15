// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { Part } from "@otk/protocol";
type TextPart = Extract<Part, { kind: "text" }>;
import type { PartRegistry } from "../../registries/renderers.ts";
import Blocks from "../Blocks.tsx";
export function registerTextPart(parts: PartRegistry): void {
  parts.registerTyped("text", (props) => (
    <div class="otk-text">
      <Show when={!props.user || !(props.part as TextPart).synthetic}>
        <Blocks
          blocks={(props.part as TextPart).blocks}
          streaming={props.streaming}
        />
      </Show>
    </div>
  ));
}
