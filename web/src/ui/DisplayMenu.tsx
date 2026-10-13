// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import type { PreferenceKey, Preferences } from "../../../protocol/prefs.ts";
const booleans = [
  ["timestamps", "Always show timestamps"],
  ["toolDetails", "Tool details"],
  ["conceal", "Conceal markup"],
  ["genericToolOutput", "Generic tool output"],
  ["diffWrap", "Wrap diffs"],
  ["scrollbar", "Scrollbar"],
  ["pasteSummary", "Paste summaries"],
] as const;
export default function DisplayMenu(props: {
  prefs: Preferences;
  ready: boolean;
  error: string;
  onSet(key: PreferenceKey, value: Preferences[PreferenceKey]): Promise<void>;
}) {
  return (
    <details class="otk-display-menu">
      <summary>Display</summary>
      <fieldset disabled={!props.ready}>
        <legend>Display preferences</legend>
        <For each={booleans} keyed={false}>
          {(item) => (
            <label>
              <input
                type="checkbox"
                name={item()[0]}
                checked={props.prefs[item()[0]]}
                onChange={(event) =>
                  void props.onSet(item()[0], event.currentTarget.checked)}
              />
              {item()[1]}
            </label>
          )}
        </For>
        <label>
          Thinking<select
            name="thinking"
            value={props.prefs.thinking}
            onChange={(event) =>
              void props.onSet(
                "thinking",
                event.currentTarget.value as Preferences["thinking"],
              )}
          >
            <option value="hide">Hide</option>
            <option value="show">Show</option>
          </select>
        </label>
        <label>
          Diff style<select
            name="diffStyle"
            value={props.prefs.diffStyle}
            onChange={(event) =>
              void props.onSet(
                "diffStyle",
                event.currentTarget.value as Preferences["diffStyle"],
              )}
          >
            <option value="auto">Auto</option>
            <option value="split">Split</option>
            <option value="unified">Unified</option>
          </select>
        </label>
      </fieldset>
      <Show when={props.error}>
        <p class="otk-error" role="alert">{props.error}</p>
      </Show>
    </details>
  );
}
