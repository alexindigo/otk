// SPDX-License-Identifier: LGPL-3.0-only
import "./DisplayMenu.css" with { type: "text" };
import { For, Show } from "solid-js";
import {
  type PreferenceKey,
  type PreferenceRegistry,
  type Preferences,
  preferences,
} from "@otk/protocol";
import { ownedAction } from "../keyboard/context.tsx";
import { SettingsIcon } from "./ChromeIcons.tsx";
import Popover from "./surface/Popover.tsx";
export interface DisplayMenuProps {
  prefs: Preferences;
  ready: boolean;
  error: string;
  registry?: PreferenceRegistry;
  onSet(key: PreferenceKey, value: Preferences[PreferenceKey]): Promise<void>;
}
export default function DisplayMenu(
  props: DisplayMenuProps,
): import("solid-js").Element {
  return (
    <Popover
      class="otk-display-menu"
      label="Display options"
      title="Display preferences"
      trigger={<SettingsIcon />}
    >
      <DisplayPreferences {...props} />
    </Popover>
  );
}

/** Identical preference controls in the anchored menu and app-level dialog. */
export function DisplayPreferences(
  props: DisplayMenuProps,
): import("solid-js").Element {
  const set = ownedAction(
    "display.set",
    (input: { key: PreferenceKey; value: Preferences[PreferenceKey] }) =>
      props.onSet(input.key, input.value),
  );
  return (
    <div class="otk-display-preferences">
      <fieldset disabled={!props.ready}>
        <For each={(props.registry ?? preferences).display()} keyed={false}>
          {(item) => {
            const options = () => {
              const control = item().display!.control;
              return control.kind === "select" ? control.options : [];
            };
            return (
              <label>
                <Show
                  when={item().display!.control.kind === "toggle"}
                  fallback={
                    <>
                      {item().label}
                      <select
                        name={item().key}
                        value={String(props.prefs[item().key])}
                        onChange={(event) =>
                          void set({
                            key: item().key,
                            value: event.currentTarget.value,
                          })}
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
                    name={item().key}
                    checked={props.prefs[item().key] === true}
                    onChange={(event) =>
                      void set({
                        key: item().key,
                        value: event.currentTarget.checked,
                      })}
                  />
                  {item().label}
                </Show>
              </label>
            );
          }}
        </For>
      </fieldset>
      <Show when={props.error}>
        <p class="otk-error" role="alert">{props.error}</p>
      </Show>
    </div>
  );
}
