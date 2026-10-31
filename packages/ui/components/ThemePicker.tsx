// SPDX-License-Identifier: LGPL-3.0-only
import { failureText } from "@otk/client";
import "./ThemePicker.css" with { type: "text" };
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
import { createSignal, type Element, For, onSettled, Show } from "solid-js";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
import type { ThemeEngine } from "../theme/engine.ts";
import FieldFeedback from "./FieldFeedback.tsx";
import ActionSlot from "./ActionSlot.tsx";
import { FormSelect } from "./Form.tsx";
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
  let status: { focus(): void } | undefined, saveButton!: HTMLButtonElement;
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
      onSettled(() => status?.focus());
      setError("");
      try {
        await props.onSave(selected());
        if (active) cancel();
      } catch (error) {
        if (active) setError(failureText(error));
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
      <div
        class={["otk-theme-choices", { "is-pending": pending() }]}
        role="group"
        aria-label="Theme choices"
      >
        <For each={choices} keyed={(choice) => choice.id}>
          {(choice) => (
            <button
              type="button"
              data-theme-choice={choice().id}
              data-otk-selection="vertical"
              {...selection({
                kind: "pressed",
                selected: selected() === choice().id,
              })}
              onClick={() => void select(choice().id)}
            >
              <SelectionContent>{choice().label}</SelectionContent>
            </button>
          )}
        </For>
      </div>
      <label class="otk-system-light">
        Light theme used by System
        <FormSelect
          name="systemLightTheme"
          value={props.systemLightTheme}
          pending={!props.ready || pending()}
          onChange={async (event) => {
            const select = event.currentTarget, id = select.value;
            if (!props.ready || pending()) return;
            setPending(true);
            onSettled(() => status?.focus());
            setError("");
            try {
              await props.onSystemLightSave(id);
            } catch (error) {
              if (active) setError(failureText(error));
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
            <option value={props.systemLightTheme} hidden>
              Unavailable ({props.systemLightTheme}); uses default light
            </option>
          </Show>
          <For each={lightThemes} keyed={(theme) => theme.id}>
            {(theme) => <option value={theme().id}>{theme().label}</option>}
          </For>
        </FormSelect>
      </label>
      <FieldFeedback
        action
        feedback={error() ? { kind: "error", text: error() } : undefined}
      />
      <footer class="otk-theme-actions">
        <button type="button" onClick={() => void close()}>Cancel</button>
        <ActionSlot
          pending={pending()}
          feedback={pending()
            ? {
              kind: "pending",
              text: `Saving ${
                choices.find((choice) => choice.id === selected())?.label ??
                  "theme"
              }…`,
            }
            : undefined}
          control={(control) => status = control}
          focusAction={() => {
            if (saveButton.isConnected) saveButton.focus();
          }}
        >
          <button
            ref={(element) => saveButton = element}
            type="button"
            hidden={!props.ready}
            onClick={() => void save()}
          >
            Save theme
          </button>
        </ActionSlot>
      </footer>
    </>
  );
}
