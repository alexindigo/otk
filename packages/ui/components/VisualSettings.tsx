// SPDX-License-Identifier: LGPL-3.0-only
import "./VisualSettings.css" with { type: "text" };
import { createSignal, For, Show } from "solid-js";
import { type Preferences, preferences } from "@otk/protocol";
type VisualKey = "reducedColors" | "animationsOff";
export default function VisualSettings(props: {
  prefs: Preferences;
  ready: boolean;
  onSet(key: VisualKey, value: boolean): Promise<void>;
}): import("solid-js").Element {
  const [error, setError] = createSignal("");
  return (
    <section class="otk-visual-settings" aria-label="Appearance settings">
      <h2>Appearance</h2>
      <For
        each={preferences.list().filter((
          row,
        ): row is import("@otk/protocol").PreferenceDefinition<VisualKey> =>
          row.key === "reducedColors" || row.key === "animationsOff"
        )}
      >
        {(row) => (
          <label>
            <input
              type="checkbox"
              name={row.key}
              checked={props.prefs[row.key]}
              disabled={!props.ready}
              onChange={(event) => {
                setError("");
                void props.onSet(row.key, event.currentTarget.checked).catch((
                  error,
                ) => setError((error as Error).message));
              }}
            />
            <span>{row.label}</span>
          </label>
        )}
      </For>
      <p class="otk-muted">
        Reduced colours uses status shapes and underlines. Animations also stop
        when your system requests reduced motion.
      </p>
      <Show when={error()}>
        <p class="otk-error" role="alert">{error()}</p>
      </Show>
    </section>
  );
}
