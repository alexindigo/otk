// SPDX-License-Identifier: LGPL-3.0-only
import "./ThemePicker.css" with { type: "text" };
import { createSignal, type Element, For, onSettled, Show } from "solid-js";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
import type { ThemeEngine } from "../theme/engine.ts";
/** Preview is locally owned; committed state and saves are supplied by the host. */
export default function ThemePicker(props: {
  theme: ThemeEngine;
  ready: boolean;
  systemLightTheme: string;
  onSave(id: string): Promise<void>;
  onSystemLightSave(id: string): Promise<void>;
  onClose(): void;
}): Element {
  const [selected, setSelected] = createSignal(
      props.theme.snapshot().committed,
    ),
    [pending, setPending] = createSignal(false),
    [error, setError] = createSignal("");
  let active = true, preview: ReturnType<ThemeEngine["preview"]> | undefined;
  onSettled(() => {
    preview = props.theme.preview();
    return () => {
      active = false;
      preview?.close();
    };
  });
  const ports = useCommandPorts();
  const select = ownedCommand(ports, {
    id: "theme.preview",
    title: "Preview theme",
    category: "Display",
    hidden: true,
    run: (_ctx, id: string) => {
      if (pending()) return;
      preview?.select(id);
      setSelected(id);
    },
  });
  const cancel = () => {
    preview?.close();
    props.onClose();
  };
  const close = ownedCommand(ports, {
    id: "theme.cancel",
    title: "Cancel theme preview",
    category: "Display",
    hidden: true,
    run: cancel,
  });
  const save = ownedCommand(ports, {
    id: "theme.save",
    title: "Save theme",
    category: "Display",
    hidden: true,
    run: async () => {
      if (pending() || !props.ready) return;
      setPending(true);
      setError("");
      try {
        await props.onSave(selected());
        if (active) cancel();
      } catch (error) {
        if (active) setError((error as Error).message);
      } finally {
        if (active) setPending(false);
      }
    },
  });
  const choices = [
    ...props.theme.themes.list().map(({ id, label }) => ({ id, label })),
    { id: "system", label: "System" },
  ];
  const lightThemes = props.theme.themes.list().filter((theme) =>
    theme.mode === "light"
  );
  return (
    <>
      <p class="otk-muted">
        Preview a theme. Save to use it in connected tabs.
      </p>
      <div class="otk-theme-choices" role="group" aria-label="Theme choices">
        <For each={choices} keyed={(choice) => choice.id}>
          {(choice) => (
            <button
              type="button"
              data-theme-choice={choice().id}
              data-otk-selection="vertical"
              aria-pressed={selected() === choice().id ? "true" : "false"}
              disabled={pending()}
              onClick={() => void select(choice().id)}
            >
              {choice().label}
            </button>
          )}
        </For>
      </div>
      <label class="otk-system-light">
        Light theme used by System
        <select
          name="systemLightTheme"
          value={props.systemLightTheme}
          disabled={!props.ready || pending()}
          onChange={async (event) => {
            const select = event.currentTarget, id = select.value;
            setPending(true);
            setError("");
            try {
              await props.onSystemLightSave(id);
            } catch (error) {
              if (active) setError((error as Error).message);
            } finally {
              if (active) {
                select.value = props.systemLightTheme;
                setPending(false);
              }
            }
          }}
        >
          <Show
            when={!lightThemes.some((theme) =>
              theme.id === props.systemLightTheme
            )}
          >
            <option value={props.systemLightTheme}>
              Unavailable ({props.systemLightTheme}); uses default light
            </option>
          </Show>
          <For each={lightThemes} keyed={(theme) => theme.id}>
            {(theme) => <option value={theme().id}>{theme().label}</option>}
          </For>
        </select>
      </label>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <footer class="otk-theme-actions">
        <button type="button" onClick={() => void close()}>Cancel</button>
        <button
          type="button"
          disabled={!props.ready || pending()}
          onClick={() => void save()}
        >
          {pending() ? "Saving…" : "Save theme"}
        </button>
      </footer>
    </>
  );
}
