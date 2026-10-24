// SPDX-License-Identifier: LGPL-3.0-only
import { errorMessage } from "@otk/protocol";
import "./Palette.css" with { type: "text" };
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
import { createSignal, For, onSettled, Show } from "solid-js";
import { useCommandPorts } from "../keyboard/context.tsx";
export default function Palette(
  props: { onClose(): void },
): import("solid-js").Element {
  const { commands } = useCommandPorts();
  const [query, setQuery] = createSignal(""),
    [revision, setRevision] = createSignal(0),
    [error, setError] = createSignal("");
  let active = true;
  onSettled(() => {
    const release = commands.subscribe(() => setRevision((n) => n + 1));
    return () => {
      active = false;
      release();
    };
  });
  const rows = () => {
    revision();
    return commands.list().filter((row) =>
      `${row.cmd.title} ${row.cmd.category} ${row.cmd.slash?.join(" ") ?? ""}`
        .toLowerCase().includes(query().toLowerCase())
    );
  };
  const invoke = async (id: string) => {
    try {
      await commands.run(id);
      if (active) props.onClose();
    } catch (error) {
      if (active) setError(errorMessage(error));
    }
  };
  return (
    <>
      <input
        name="command-search"
        aria-label="Find a command"
        placeholder="Find a command…"
        autofocus
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            const row = rows().find((row) => row.enabled);
            if (row) void invoke(row.cmd.id);
          }
        }}
      />
      <ul class="otk-palette-list">
        <For each={rows()} keyed={(row) => row.cmd.id}>
          {(row) => (
            <li>
              <button
                type="button"
                data-command={row().cmd.id}
                data-otk-selection="vertical"
                {...selection({
                  kind: "candidate",
                  selected: rows().find((item) =>
                    item.enabled
                  )?.cmd.id === row().cmd.id,
                })}
                disabled={!row().enabled}
                onClick={() => void invoke(row().cmd.id)}
              >
                <SelectionContent class="otk-palette-content">
                  <span>
                    {row().cmd.title}
                    <small>{row().cmd.category}</small>
                  </span>
                  <kbd>{row().keys.join(" / ")}</kbd>
                </SelectionContent>
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={!rows().length}>
        <p class="otk-muted">No matching commands.</p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </>
  );
}
