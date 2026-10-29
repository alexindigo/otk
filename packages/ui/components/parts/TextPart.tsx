// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { PartRegistry } from "../../registries/renderers.ts";
import Blocks from "../Blocks.tsx";
import { blocksText } from "./text.ts";
export function registerTextPart(parts: PartRegistry): void {
  parts.registerTyped(
    "text",
    (props) => (
      <Show when={!props.user || !props.part.synthetic}>
        <Blocks
          blocks={props.part.blocks}
          streaming={props.streaming}
          conceal={props.prefs.conceal}
          compact={props.user}
        />
      </Show>
    ),
    (part) => ({
      copyable: !part.synthetic && part.blocks.length > 0,
      get text() {
        return part.synthetic ? undefined : blocksText(part.blocks);
      },
    }),
  );
}
