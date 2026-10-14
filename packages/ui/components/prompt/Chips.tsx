// SPDX-License-Identifier: LGPL-3.0-only
import "./Chips.css" with { type: "text" };
import { For } from "solid-js";
import type { Chip } from "./model.ts";
function title(chip: Chip): string | undefined {
  const part = chip.part;
  return chip.error ||
    (part.kind === "file" && part.source !== "path" ? part.name : undefined);
}
export default function Chips(
  props: {
    chips: Chip[];
    onOpen(chip: Chip): void;
    onRemove(chip: Chip): void;
  },
) {
  return (
    <div class="otk-prompt-chips">
      <For each={props.chips} keyed={(chip) => chip.id}>
        {(chip) => (
          <span class="otk-prompt-chip">
            <button
              type="button"
              title={title(chip())}
              onClick={() => props.onOpen(chip())}
            >
              {chip().label}
              {chip().pending
                ? " reading…"
                : chip().error
                ? ` ${chip().error}`
                : ""}
            </button>
            <button
              type="button"
              aria-label={`Remove ${chip().label}`}
              onClick={() => props.onRemove(chip())}
            >
              ×
            </button>
          </span>
        )}
      </For>
    </div>
  );
}
