// SPDX-License-Identifier: LGPL-3.0-only
import "./PreferenceControls.css" with { type: "text" };
import { createSignal, type Element, For, onCleanup, Show } from "solid-js";
import {
  type PreferenceKey,
  type PreferenceRegistry,
  type Preferences,
  preferences,
} from "@otk/protocol";
import { ownedAction } from "../keyboard/context.tsx";

export interface PreferenceControlsProps {
  prefs: Preferences;
  ready: boolean;
  registry?: PreferenceRegistry;
  onSet(key: PreferenceKey, value: Preferences[PreferenceKey]): Promise<void>;
}

/** The browser owns native intent, never an optimistic preference snapshot. */
export default function PreferenceControls(
  props: PreferenceControlsProps & { group?: string },
): Element {
  const [error, setError] = createSignal("");
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  const set = ownedAction(
    "preference.set",
    (input: { key: PreferenceKey; value: Preferences[PreferenceKey] }) => {
      if (!props.ready) throw new Error("Preferences are not ready yet");
      return props.onSet(input.key, input.value);
    },
  );
  const change = (
    key: PreferenceKey,
    value: Preferences[PreferenceKey],
    restore: () => void,
  ) => {
    restore();
    setError("");
    void set({ key, value }).catch((failure: unknown) => {
      if (alive) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }).finally(() => {
      if (alive) restore();
    });
  };
  const rows = () => {
    const registry = props.registry ?? preferences;
    return props.group ? registry.settings(props.group) : registry.display();
  };
  return (
    <div class="otk-preference-controls">
      <fieldset>
        <For each={rows()} keyed={(row) => row.key}>
          {(row) => {
            const control = () =>
              (props.group ? row().settings! : row().display!).control;
            const options = () => {
              const value = control();
              return value.kind === "select" ? value.options : [];
            };
            return (
              <label class="otk-preference-control">
                <Show
                  when={control().kind === "toggle"}
                  fallback={
                    <>
                      {row().label}
                      <select
                        name={row().key}
                        value={String(props.prefs[row().key])}
                        onChange={(event) => {
                          const field = event.currentTarget,
                            value = field.value;
                          change(row().key, value, () => {
                            field.value = String(props.prefs[row().key]);
                          });
                        }}
                      >
                        <For each={options()}>
                          {(option) => (
                            <option value={option.value}>{option.label}</option>
                          )}
                        </For>
                      </select>
                    </>
                  }
                >
                  <input
                    type="checkbox"
                    name={row().key}
                    checked={props.prefs[row().key] === true}
                    onChange={(event) => {
                      const field = event.currentTarget, value = field.checked;
                      change(row().key, value, () => {
                        field.checked = props.prefs[row().key] === true;
                      });
                    }}
                  />
                  {row().label}
                </Show>
              </label>
            );
          }}
        </For>
      </fieldset>
      <Show when={error()}>
        <p class="otk-error otk-preference-error" role="alert">{error()}</p>
      </Show>
    </div>
  );
}
