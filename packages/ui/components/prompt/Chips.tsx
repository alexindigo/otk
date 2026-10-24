// SPDX-License-Identifier: LGPL-3.0-only
import "./Chips.css" with { type: "text" };
import { For, Show } from "solid-js";
import type { Chip } from "./model.ts";
import { ownedAction } from "../../keyboard/context.tsx";
function title(chip: Chip): string | undefined {
  const part = chip.part;
  return chip.error ||
    (part.kind === "file" && part.source !== "path" ? part.name : undefined);
}
function thumbnail(chip: Chip): string | undefined {
  const part = chip.part;
  return part.kind === "file" && part.source === "upload" &&
      part.mime.startsWith("image/") && part.dataBase64
    ? `data:${part.mime};base64,${part.dataBase64}`
    : undefined;
}
export default function Chips(
  props: {
    chips: Chip[];
    onOpen(chip: Chip): void;
    onRemove(chip: Chip): void;
  },
) {
  const open = ownedAction("chip.open", (chip: Chip) => props.onOpen(chip));
  const remove = ownedAction(
    "chip.remove",
    (chip: Chip) => props.onRemove(chip),
  );
  return (
    <div class="otk-prompt-chips">
      <For each={props.chips} keyed={(chip) => chip.id}>
        {(chip) => (
          <span class="otk-prompt-chip">
            <button
              type="button"
              class="otk-control-grow"
              title={title(chip()) ?? chip().label}
              onClick={() => void open(chip())}
            >
              <Show when={thumbnail(chip())}>
                <img
                  class="otk-prompt-thumbnail"
                  src={thumbnail(chip())}
                  alt=""
                />
              </Show>
              <span class="otk-control-label">
                {chip().label}
                {chip().pending
                  ? " reading…"
                  : chip().error
                  ? ` ${chip().error}`
                  : ""}
              </span>
            </button>
            <button
              type="button"
              aria-label={`Remove ${chip().label}`}
              onClick={() => void remove(chip())}
            >
              ×
            </button>
          </span>
        )}
      </For>
    </div>
  );
}
