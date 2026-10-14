// SPDX-License-Identifier: LGPL-3.0-only
import "./KeysHelp.css" with { type: "text" };
import { createSignal, For, onSettled, Show } from "solid-js";
import { comboFromEvent, type Keymap } from "../keyboard/keys.ts";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
import CommandDialog from "./CommandDialog.tsx";
export default function KeysHelp(props: {
  keymap: Keymap;
  ready: boolean;
  onSave(value: Record<string, string>): Promise<void>;
  onClose(): void;
}): import("solid-js").Element {
  const [revision, setRevision] = createSignal(0),
    [editing, setEditing] = createSignal(""),
    [error, setError] = createSignal(""),
    [pending, setPending] = createSignal(false);
  let active = true;
  onSettled(() => {
    const release = props.keymap.subscribe(() => setRevision((n) => n + 1));
    return () => {
      active = false;
      release();
    };
  });
  const rows = () => {
    revision();
    return props.keymap.list();
  };
  const ports = useCommandPorts();
  const save = async (value: Record<string, string>) => {
    if (pending() || !props.ready) return;
    setPending(true);
    setError("");
    try {
      await props.onSave(value);
      if (active) setEditing("");
    } catch (error) {
      if (active) setError((error as Error).message);
    } finally {
      if (active) setPending(false);
    }
  };
  const rebind = ownedCommand(ports, {
    id: "keymap.rebind",
    title: "Rebind key",
    category: "Keys",
    hidden: true,
    run: async (_ctx, input: { id: string; key: string }) => {
      const result = props.keymap.propose(input.id, input.key);
      if (result.conflict || result.error) {
        setError(result.error ?? `Conflicts with ${result.conflict}`);
        return;
      }
      await save(result.value!);
    },
  });
  const reset = ownedCommand(ports, {
    id: "keymap.reset",
    title: "Reset key",
    category: "Keys",
    hidden: true,
    run: async (_ctx, id: string) => {
      const row = rows().find((row) => row.id === id);
      if (!row) return;
      const conflict = props.keymap.findConflict(id, row.defaultKey);
      if (conflict) {
        setError(`Conflicts with ${conflict}`);
        return;
      }
      const value = props.keymap.overrides();
      delete value[id];
      await save(value);
    },
  });
  const resetAll = ownedCommand(ports, {
    id: "keymap.reset.all",
    title: "Reset all keys",
    category: "Keys",
    hidden: true,
    run: () => save({}),
  });
  const capture = ownedCommand(ports, {
    id: "keymap.capture",
    title: "Capture shortcut",
    category: "Keys",
    hidden: true,
    run: (_ctx, id: string) => {
      setError("");
      setEditing(id);
    },
  });
  const cancelCapture = ownedCommand(ports, {
    id: "keymap.capture.cancel",
    title: "Cancel shortcut capture",
    category: "Keys",
    hidden: true,
    run: () => setEditing(""),
  });
  onSettled(() =>
    ports.keyboard?.layer("keymap.capture.cancel", () => !!editing(), 35)
  );
  return (
    <CommandDialog
      id="help.keys"
      title="Keyboard shortcuts"
      onClose={props.onClose}
    >
      <p class="otk-muted">
        Text fields keep their keys unless a binding opts in. Mod is Ctrl, or ⌘
        on macOS. Esc closes the top layer first.
      </p>
      <div class="otk-keys-list">
        <For each={rows()} keyed={(row) => row.id}>
          {(row) => (
            <div class="otk-keys-row" data-binding={row().id}>
              <span>
                {row().desc}
                <small>
                  {row().inPrompt ? "Also in prompt" : "Outside text fields"}
                </small>
              </span>
              <kbd>{row().key || "Unbound"}</kbd>
              <button
                type="button"
                disabled={!props.ready || pending()}
                onClick={() => void capture(row().id)}
              >
                Rebind
              </button>
              <button
                type="button"
                disabled={!props.ready || pending() || !row().overridden}
                onClick={() => void reset(row().id)}
              >
                Reset
              </button>
              <Show when={editing() === row().id}>
                <input
                  autofocus
                  aria-label={`New key for ${row().desc}`}
                  placeholder="Press the new key"
                  readonly
                  onKeyDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.key === "Escape") {
                      void cancelCapture();
                      return;
                    }
                    if (
                      ["Control", "Shift", "Alt", "Meta"].includes(event.key) ||
                      event.repeat || event.isComposing
                    ) return;
                    void rebind({ id: row().id, key: comboFromEvent(event) });
                  }}
                />
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <button
        type="button"
        disabled={!props.ready || pending()}
        onClick={() => void resetAll()}
      >
        Reset all shortcuts
      </button>
    </CommandDialog>
  );
}
